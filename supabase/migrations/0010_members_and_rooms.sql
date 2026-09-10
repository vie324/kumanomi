-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 10:メンバーの手入力と、所属から自動で決まるチャットルーム
--
--   1. メンバーの手入力追加・編集
--        統括院長より上(マネージャー / 統括マネージャー / 社長)と本部人事が、
--        画面からメンバーを足したり、異動・退職・委員会の任命ができる。
--        アプリは uuid を持たないので、v_app_members ビュー越しに
--        社員番号・店舗コードのまま読み書きする(0007 と同じ作り)。
--
--   2. 所属(主所属・追加所属・委員会)からチャットルームを自動生成
--        ・全社ルーム         … 在籍者全員がずっと入っている
--        ・店舗ルーム         … その店舗が主所属 or 追加所属の人
--        ・委員会ルーム       … その委員会に任命された人
--        メンバーの所属が変わるとトリガでルームの参加者が更新される。
--        成増店 → 浦和店へ異動すると、成増店のルームから外れて浦和店のルームに入る。
--
--   3. 本人が自分のランク・所属・上司を書き換えられないようにするガード
--        (0004 の members_update_self はどの列でも直せてしまっていた)
-- ============================================================

-- ------------------------------------------------------------
-- 1. 委員会マスタ
-- ------------------------------------------------------------
create table if not exists public.committees (
  id          uuid primary key default gen_random_uuid(),
  code        text        not null unique,             -- 'cm-tech' などアプリ側の安定コード
  name        text        not null,
  icon        text,
  description text,
  sort_order  integer     not null default 0,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.committees is '委員会マスタ。メンバーは members.committee_codes で任命される';

drop trigger if exists committees_touch on public.committees;
create trigger committees_touch before update on public.committees
  for each row execute function app.touch_updated_at();

-- ------------------------------------------------------------
-- 2. メンバーの追加所属と委員会
-- ------------------------------------------------------------
alter table public.members add column if not exists store_codes     text[] not null default '{}';
alter table public.members add column if not exists committee_codes text[] not null default '{}';
comment on column public.members.store_codes     is '追加所属の店舗コード(主所属 primary_store_id とは別に兼務する店舗)';
comment on column public.members.committee_codes is '任命されている委員会のコード';

-- ------------------------------------------------------------
-- 3. 権限:メンバーを手入力で足せる人
--    統括院長(4)より上 = マネージャー(5)以上、または本部人事
-- ------------------------------------------------------------
create or replace function app.can_manage_members()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(app.my_rank_level() >= 5 or app.my_rank()::text = 'hr', false);
$$;

alter table public.committees enable row level security;
drop policy if exists committees_select on public.committees;
create policy committees_select on public.committees
  for select to authenticated using (true);
drop policy if exists committees_manage on public.committees;
create policy committees_manage on public.committees
  for all to authenticated
  using (app.can_manage_members()) with check (app.can_manage_members());
grant select, insert, update, delete on public.committees to authenticated;

-- メンバーの追加・編集(0004 の members_manage は統括MG以上+人事のまま残し、マネージャーにも開く)
drop policy if exists members_manage_by_manager on public.members;
create policy members_manage_by_manager on public.members
  for all to authenticated
  using (app.can_manage_members()) with check (app.can_manage_members());

-- 本人が直せるのはプロフィールだけ。ランク・所属・上司・社員番号などは元に戻す
create or replace function app.guard_member_self_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- SQL Editor / service_role / 管理者は対象外
  if auth.uid() is null or app.can_manage_members() then return new; end if;
  new.rank             := old.rank;
  new.role_title       := old.role_title;
  new.department       := old.department;
  new.primary_store_id := old.primary_store_id;
  new.reports_to_id    := old.reports_to_id;
  new.employee_no      := old.employee_no;
  new.name_key         := old.name_key;
  new.full_name        := old.full_name;
  new.store_codes      := old.store_codes;
  new.committee_codes  := old.committee_codes;
  new.is_active        := old.is_active;
  new.joined_on        := old.joined_on;
  new.left_on          := old.left_on;
  new.employment       := old.employment;
  new.sort_order       := old.sort_order;
  new.auth_user_id     := old.auth_user_id;
  new.email            := old.email;
  new.license          := old.license;
  new.gender           := old.gender;
  return new;
end;
$$;
drop trigger if exists members_guard_self on public.members;
create trigger members_guard_self before update on public.members
  for each row execute function app.guard_member_self_update();

-- ------------------------------------------------------------
-- 4. 管轄店舗に追加所属も数える(0006 の関数を差し替え)
-- ------------------------------------------------------------
create or replace function app.managed_store_ids(p_member_id uuid)
returns table (store_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rank  public.member_rank;
  v_level integer;
begin
  select m.rank into v_rank from public.members m where m.id = p_member_id;
  if v_rank is null then
    return;
  end if;

  if v_rank::text = 'hr' then
    return query select s.id from public.stores s where s.is_active;
    return;
  end if;

  v_level := app.rank_level(v_rank);

  return query
  with scope as (
    select p_member_id as id
    union
    select t.member_id from app.subtree_ids(p_member_id) t
  ),
  owned as (
    select a.store_id, m.rank
      from public.member_store_assignments a
      join scope on scope.id = a.member_id
      join public.members m on m.id = a.member_id
     where a.ended_on is null
    union all
    select m.primary_store_id, m.rank
      from public.members m
      join scope on scope.id = m.id
     where m.primary_store_id is not null
       and m.is_active
    union all
    -- 追加所属(画面から足した兼務)
    select s.id, m.rank
      from public.members m
      join scope on scope.id = m.id
      join public.stores s on s.code = any (m.store_codes)
     where m.is_active
  )
  select distinct o.store_id
    from owned o
   where o.store_id is not null
     and (v_level >= 3 or o.rank::text = 'manager');
end;
$$;

-- ------------------------------------------------------------
-- 5. 名簿ビューに追加所属・委員会・メールを足す(末尾への追加のみ)
-- ------------------------------------------------------------
drop view if exists public.v_member_directory;
create view public.v_member_directory
  with (security_invoker = true) as
select
  m.id,
  m.name_key,
  m.employee_no,
  m.full_name,
  m.kana,
  m.former_name,
  m.gender,
  case m.gender when 'male' then '男性' when 'female' then '女性' else '—' end as gender_label,
  m.license,
  case m.license
    when 'judo'        then '柔道整復師'
    when 'acupuncture' then '鍼灸師'
    when 'seitai'      then '整体師'
    when 'esthetic'    then 'エステティシャン'
    when 'reception'   then '受付'
    when 'none'        then '資格なし'
    else '未確認'
  end as license_label,
  m.rank,
  app.rank_label(m.rank) as rank_label,
  app.rank_level(m.rank) as rank_level,
  m.role_title,
  m.department,
  case m.department
    when 'seitai'      then '整体部門'
    when 'beauty'      then '美容部門'
    when 'reception'   then '受付スタッフ'
    when 'management'  then 'マネジメント'
    else '本部'
  end as department_label,
  s.id   as store_id,
  s.name as store_name,
  s.category as store_category,
  mgr.id   as manager_id,
  mgr.full_name as manager_name,
  mgr.role_title as manager_role,
  (select count(*) from app.subtree_ids(m.id)) as subordinate_count,
  (select count(*) from public.mentorships ms where ms.mentor_id = m.id and ms.ended_on is null) as mentee_count,
  m.joined_on,
  m.is_active,
  s.code   as store_code,
  mgr.employee_no as manager_employee_no,
  m.color,
  m.employment,
  m.sort_order,
  m.photo_url,
  m.store_codes,
  m.committee_codes,
  m.email
from public.members m
left join public.stores  s   on s.id = m.primary_store_id
left join public.members mgr on mgr.id = m.reports_to_id;

comment on view public.v_member_directory is
  'メンバー名簿。store_code / manager_employee_no はアプリ側の安定キー。store_codes は追加所属、committee_codes は委員会';
grant select on public.v_member_directory to authenticated;

-- ------------------------------------------------------------
-- 6. アプリ用の書き込みビュー v_app_members
--    社員番号・店舗コード・上司の社員番号のまま INSERT / UPDATE できる。
-- ------------------------------------------------------------
create or replace view public.v_app_members
  with (security_invoker = true) as
select
  m.employee_no,
  m.full_name,
  m.kana,
  m.role_title,
  m.rank::text        as rank,
  m.department::text  as department,
  s.code              as primary_store_code,
  mgr.employee_no     as manager_employee_no,
  m.color,
  m.joined_on,
  m.left_on,
  m.is_active,
  m.photo_url,
  m.email,
  m.phone,
  m.employment::text  as employment,
  m.sort_order,
  m.store_codes,
  m.committee_codes,
  m.license::text     as license,
  m.note
from public.members m
left join public.stores  s   on s.id = m.primary_store_id
left join public.members mgr on mgr.id = m.reports_to_id;

create or replace function app.write_app_members()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
declare
  v_store   uuid;
  v_mgr     uuid;
  v_key     text;
  v_rank    public.member_rank;
  v_dept    public.department;
  v_emp     public.employment_type;
  v_lic     public.license_type;
  v_no      text;
begin
  if tg_op = 'DELETE' then
    -- 消さずに退職扱いにする(履歴を守る)
    update public.members set is_active = false, left_on = coalesce(left_on, current_date)
     where employee_no = old.employee_no;
    return old;
  end if;

  v_no := nullif(btrim(coalesce(new.employee_no, '')), '');
  if v_no is null then
    raise exception '社員番号を指定してください' using errcode = 'not_null_violation';
  end if;
  if new.rank is not null and new.rank not in ('ceo','exec','area','chief','manager','mentor','staff','hr','clerk') then
    raise exception '不明なランクです: %', new.rank using errcode = 'invalid_parameter_value';
  end if;
  v_rank := new.rank::public.member_rank;
  v_dept := case when new.department in ('seitai','beauty','reception','management','head') then new.department::public.department else null end;
  v_emp  := case when new.employment is not null then new.employment::public.employment_type else null end;
  v_lic  := case when new.license is not null then new.license::public.license_type else null end;
  v_store := case when new.primary_store_code is null then null else app.store_id_of(new.primary_store_code) end;
  if new.primary_store_code is not null and v_store is null then
    raise exception '店舗コード % が見つかりません', new.primary_store_code using errcode = 'foreign_key_violation';
  end if;
  v_mgr := case when new.manager_employee_no is null then null else app.member_id_of(new.manager_employee_no) end;
  if new.manager_employee_no is not null and v_mgr is null then
    raise exception '上司の社員番号 % が見つかりません', new.manager_employee_no using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'UPDATE' then
    update public.members set
      employee_no      = v_no,
      full_name        = coalesce(new.full_name, full_name),
      kana             = coalesce(new.kana, kana),
      role_title       = coalesce(new.role_title, role_title),
      rank             = coalesce(v_rank, rank),
      department       = coalesce(v_dept, department),
      primary_store_id = case when new.primary_store_code is distinct from old.primary_store_code then v_store else primary_store_id end,
      reports_to_id    = case when new.manager_employee_no is distinct from old.manager_employee_no then v_mgr else reports_to_id end,
      color            = coalesce(new.color, color),
      joined_on        = coalesce(new.joined_on, joined_on),
      left_on          = case when new.left_on is distinct from old.left_on then new.left_on else left_on end,
      is_active        = coalesce(new.is_active, is_active),
      photo_url        = case when new.photo_url is distinct from old.photo_url then new.photo_url else photo_url end,
      email            = case when new.email is distinct from old.email then new.email else email end,
      phone            = case when new.phone is distinct from old.phone then new.phone else phone end,
      employment       = coalesce(v_emp, employment),
      sort_order       = coalesce(new.sort_order, sort_order),
      store_codes      = coalesce(new.store_codes, store_codes),
      committee_codes  = coalesce(new.committee_codes, committee_codes),
      license          = coalesce(v_lic, license),
      note             = case when new.note is distinct from old.note then new.note else note end
    where employee_no = old.employee_no;
    -- 名簿は全員が読めるのでビューの行は見えるが、書けるかは RLS が決める。
    -- 黙って何も起きないと同期が成功扱いになるので、はっきり断る
    if not found then
      raise exception '% の名簿を編集する権限がありません', old.employee_no using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- INSERT:取込キー(name_key)は氏名から作る。同姓同名がいれば社員番号を付けて区別する
  if new.full_name is null or btrim(new.full_name) = '' then
    raise exception '氏名を指定してください' using errcode = 'not_null_violation';
  end if;
  v_key := app.name_key(new.full_name);
  if exists (select 1 from public.members where name_key = v_key and employee_no is distinct from v_no) then
    v_key := v_key || '@' || v_no;
  end if;

  insert into public.members as m (name_key, employee_no, full_name, kana, role_title, rank, department,
    primary_store_id, reports_to_id, color, joined_on, is_active, photo_url, email, phone, employment,
    sort_order, store_codes, committee_codes, license, note)
  values (v_key, v_no, new.full_name, new.kana, coalesce(new.role_title, 'スタッフ'), coalesce(v_rank, 'staff'),
    coalesce(v_dept, 'seitai'), v_store, v_mgr, new.color, new.joined_on, coalesce(new.is_active, true),
    new.photo_url, new.email, new.phone, coalesce(v_emp, 'unknown'), coalesce(new.sort_order, 0),
    coalesce(new.store_codes, '{}'), coalesce(new.committee_codes, '{}'), coalesce(v_lic, 'unknown'), new.note)
  on conflict (employee_no) do update set
    full_name = excluded.full_name, kana = excluded.kana, role_title = excluded.role_title,
    rank = excluded.rank, department = excluded.department, primary_store_id = excluded.primary_store_id,
    reports_to_id = excluded.reports_to_id, color = excluded.color, joined_on = excluded.joined_on,
    is_active = excluded.is_active, email = excluded.email, phone = excluded.phone,
    employment = excluded.employment, store_codes = excluded.store_codes,
    committee_codes = excluded.committee_codes, license = excluded.license, note = excluded.note;
  return new;
end; $$;
drop trigger if exists v_app_members_write on public.v_app_members;
create trigger v_app_members_write instead of insert or update or delete on public.v_app_members
  for each row execute function app.write_app_members();
grant select, insert, update, delete on public.v_app_members to authenticated;

-- ------------------------------------------------------------
-- 7. 所属から自動で決まるチャットルーム
-- ------------------------------------------------------------
alter table public.chat_rooms add column if not exists auto_key text unique;
comment on column public.chat_rooms.auto_key is
  '自動ルームの識別子。all / store:<店舗コード> / committee:<委員会コード>。参加者は所属から自動で決まり、手では変えられない';

-- そのルームに居るべき人(社員番号)
create or replace function app.auto_room_member_nos(p_auto_key text)
returns text[]
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(array_agg(m.employee_no order by m.sort_order, m.employee_no), '{}')
    from public.members m
   where m.is_active
     and m.employee_no is not null
     and (
       p_auto_key = 'all'
       or (p_auto_key like 'store:%' and (
             m.primary_store_id = app.store_id_of(substr(p_auto_key, 7))
             or substr(p_auto_key, 7) = any (m.store_codes)))
       or (p_auto_key like 'committee:%' and substr(p_auto_key, 11) = any (m.committee_codes))
     );
$$;

-- 自動ルームを 1 つ用意して参加者を合わせる
create or replace function app.ensure_auto_room(
  p_auto_key text, p_app_id text, p_kind text, p_name text, p_icon text, p_desc text, p_store_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare v_members text[] := app.auto_room_member_nos(p_auto_key);
begin
  -- 「参加者は手で変えられない」ガード(guard_auto_room)を、この同期だけ通す
  perform set_config('app.room_sync', 'on', true);
  insert into public.chat_rooms (app_id, auto_key, kind, name, icon, description, store_id, member_nos, announce_only)
  values (p_app_id, p_auto_key, p_kind, p_name, p_icon, p_desc, p_store_id, v_members, false)
  on conflict (app_id) do update set
    auto_key = excluded.auto_key,
    name     = excluded.name,
    icon     = coalesce(public.chat_rooms.icon, excluded.icon),
    store_id = excluded.store_id;
  update public.chat_rooms
     set member_nos = v_members
   where auto_key = p_auto_key
     and member_nos is distinct from v_members;
  perform set_config('app.room_sync', '', true);
end;
$$;

-- 全社・全店舗・全委員会のルームをそろえ、参加者を所属に合わせる
create or replace function app.sync_auto_rooms()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare r record;
begin
  perform app.ensure_auto_room('all', 'cr-all', 'group', '全社アナウンス', '📢', '全社員向けの連絡(全員が参加)', null);
  for r in select s.id, s.code, s.name from public.stores s where s.is_active loop
    perform app.ensure_auto_room('store:' || r.code, 'cr-store-' || r.code, 'store',
      r.name, '🏠', r.name || 'のスタッフルーム(所属から自動で更新)', r.id);
  end loop;
  for r in select c.code, c.name, c.icon, c.description from public.committees c where c.is_active loop
    perform app.ensure_auto_room('committee:' || r.code, 'cr-committee-' || r.code, 'committee',
      r.name, coalesce(r.icon, '🗂'), coalesce(r.description, r.name || 'のルーム'), null);
  end loop;
end;
$$;

create or replace function app.trg_sync_auto_rooms()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  perform app.sync_auto_rooms();
  return null;
end;
$$;

drop trigger if exists members_sync_rooms on public.members;
create trigger members_sync_rooms
  after insert or update of primary_store_id, store_codes, committee_codes, is_active, employee_no, sort_order or delete
  on public.members
  for each statement execute function app.trg_sync_auto_rooms();

drop trigger if exists stores_sync_rooms on public.stores;
create trigger stores_sync_rooms
  after insert or update of is_active, name, code on public.stores
  for each statement execute function app.trg_sync_auto_rooms();

drop trigger if exists committees_sync_rooms on public.committees;
create trigger committees_sync_rooms
  after insert or update or delete on public.committees
  for each statement execute function app.trg_sync_auto_rooms();

-- 自動ルームの参加者・種類は手で変えない。消しもしない(所属が変わればまた作られる)
create or replace function app.guard_auto_room()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  -- ログイン中の人の操作だけを見る。SQL Editor と、所属からの自動同期(app.room_sync)は素通し
  v_user_edit boolean := auth.uid() is not null
                         and coalesce(current_setting('app.room_sync', true), '') <> 'on';
begin
  if tg_op = 'DELETE' then
    if old.auto_key is not null and v_user_edit then
      raise exception '所属から自動で作られるルームは削除できません' using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;
  if old.auto_key is not null and v_user_edit then
    new.member_nos := old.member_nos;
    new.auto_key   := old.auto_key;
    new.kind       := old.kind;
    new.store_id   := old.store_id;
  end if;
  return new;
end;
$$;
drop trigger if exists chat_rooms_guard_auto on public.chat_rooms;
create trigger chat_rooms_guard_auto before update or delete on public.chat_rooms
  for each row execute function app.guard_auto_room();

-- ビューに auto_key を出す(末尾に追加)
create or replace view public.v_app_chat_rooms
  with (security_invoker = true) as
select
  r.app_id      as id,
  r.kind, r.name, r.icon,
  r.description as "desc",
  st.code       as store_id,
  r.member_nos  as member_ids,
  r.announce_only,
  r.pinned_message_app_id as pinned_message_id,
  app.employee_no_of(r.created_by) as created_by,
  r.auto_key
from public.chat_rooms r
left join public.stores st on st.id = r.store_id;
grant select, insert, update, delete on public.v_app_chat_rooms to authenticated;

-- 既存データに対して一度そろえる
select app.sync_auto_rooms();

-- ------------------------------------------------------------
-- 8. 自分の情報に追加所属・委員会を足す
-- ------------------------------------------------------------
create or replace function public.me()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select case when m.id is null then null else jsonb_build_object(
    'id',            m.id,
    'employee_no',   m.employee_no,
    'full_name',     m.full_name,
    'kana',          m.kana,
    'email',         m.email,
    'color',         m.color,
    'photo_url',     m.photo_url,
    'rank',          m.rank,
    'rank_label',    app.rank_label(m.rank),
    'rank_level',    app.rank_level(m.rank),
    'role_title',    m.role_title,
    'department',    m.department,
    'store_id',      m.primary_store_id,
    'store_code',    s.code,
    'store_name',    s.name,
    'store_codes',   to_jsonb(m.store_codes),
    'committee_codes', to_jsonb(m.committee_codes),
    'manager_id',    m.reports_to_id,
    'manager_employee_no', (select mgr.employee_no from public.members mgr where mgr.id = m.reports_to_id),
    'can_edit_org',  app.can_edit_org(),
    'can_manage_members', app.can_manage_members(),
    'managed_store_ids', (select coalesce(jsonb_agg(store_id), '[]'::jsonb) from app.managed_store_ids(m.id)),
    'managed_store_codes', (
      select coalesce(jsonb_agg(st.code), '[]'::jsonb)
        from app.managed_store_ids(m.id) ms
        join public.stores st on st.id = ms.store_id
    ),
    'subordinates',      (select count(*) from app.subtree_ids(m.id)),
    'mentees',           (select count(*) from public.mentorships ms
                           where ms.mentor_id = m.id and ms.ended_on is null)
  ) end
  from public.members m
  left join public.stores s on s.id = m.primary_store_id
  where m.id = app.current_member_id();
$$;
grant execute on function public.me() to authenticated;
