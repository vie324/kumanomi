-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 12:スタッフ名簿シートの一括登録
--
-- 0003 の「組織図シート取込」が組織のかたち(傘・店舗の責任者)を作るのに対し、
-- こちらは人事の名簿シート ── 社員番号・氏名・性別・役職・所属店舗・メール ──
-- をそのまま貼って、メンバーを一気に登録・更新するための取込。
--
-- 使い方(Supabase SQL Editor / psql どちらでも):
--
--   select public.import_staff_sheet($sheet$
--   状態	社員番号	姓	名	性別	役職	店舗	店舗	店舗	メール
--   	E001	山田	太郎	男性	マネージャー	鴻巣院	イオン上尾院	熊谷院	yamada@example.co.jp
--   育休中	E002	田中	桜	女性					tanaka@example.co.jp
--   $sheet$);
--
--   ・スプレッドシートから範囲コピーして、そのまま貼るだけ(タブ区切り)
--   ・列の並びは 状態 / 社員番号 / 姓 / 名 / 性別 / 役職 / 店舗… / メール
--   ・店舗の列は何列あってもよい(メールの列の手前までを所属店舗として読む)
--   ・並びの先頭が店舗の場合は主たる所属、2つめ以降は兼務になる
--   ・見出し行・空行は自動で飛ばす
--
-- 貼る前に確認したいときは preview_staff_sheet(同じ文字列)を使う。
-- 何度流しても同じ結果になる(社員番号 → 氏名 → メール の順で既存行に重ねる)。
--
-- ------------------------------------------------------------
-- 先に読むこと
-- ------------------------------------------------------------
--   * シートの店舗名は略称(越谷院)、名簿の店舗名は正式名称(越谷駅前院)の
--     ことがある。対応は public.store_aliases に入れる(下で 15 件登録済み)。
--   * 氏名の異体字(渡邉/渡邊、髙/高、﨑/崎 など)は app.name_fold が吸収する。
--     字そのものが違う場合は public.member_name_aliases に足す。
--   * 取込後は戻り値の jsonb を必ず確認すること。解決できなかった店舗名、
--     上司が決まらなかった人、シートに載っていない在籍者がすべて並ぶ。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 店舗名の別名(シートの書き方 → 名簿の正式名称)
-- ------------------------------------------------------------

create table if not exists public.store_aliases (
  alias       text primary key,                       -- シートに出てくる書き方
  store_name  text not null,                          -- public.stores.name の正式名称
  note        text,
  created_at  timestamptz not null default now()
);

comment on table public.store_aliases is
  'スタッフ名簿シートの店舗名を、名簿の正式な店舗名に読み替える表。ここに無い名前はそのまま照合する';

alter table public.store_aliases enable row level security;
drop policy if exists store_aliases_select on public.store_aliases;
create policy store_aliases_select on public.store_aliases
  for select to authenticated using (true);
drop policy if exists store_aliases_manage on public.store_aliases;
create policy store_aliases_manage on public.store_aliases
  for all to authenticated
  using (app.can_edit_org()) with check (app.can_edit_org());
grant select, insert, update, delete on public.store_aliases to authenticated;

-- 人事の名簿シートで使われている略称。店舗名が変わったら書き換えてよい。
insert into public.store_aliases (alias, store_name, note) values
  ('越谷院',       '越谷駅前院',           '名簿シートの略称'),
  ('南越谷院',     '南越谷駅前院',         '名簿シートの略称'),
  ('新宿院',       '新宿西口院',           '名簿シートの略称'),
  ('池袋院',       '池袋東口院',           '名簿シートの略称'),
  ('大宮院',       '大宮駅前院',           '名簿シートの略称'),
  ('川越院',       '川越駅前院',           '名簿シートの略称'),
  ('北浦和院',     '北浦和駅前院',         '名簿シートの略称'),
  ('浦和院',       '浦和コルソ院',         '名簿シートの略称'),
  ('武蔵浦和院',   '武蔵浦和駅前院',       '名簿シートの略称'),
  ('川口駅前院',   '川口院',               '名簿シートの略称'),
  ('春日部院',     'イオンモール春日部院', '名簿シートの略称'),
  ('熊谷院',       'ニットーモール熊谷院', '名簿シートの略称'),
  ('鴻巣院',       'ウニクス鴻巣院',       '名簿シートの略称'),
  ('鷲宮院',       'アリオ鷲宮院',         '名簿シートの略称'),
  ('イオン上尾院', 'イオンモール上尾院',   '名簿シートの略称')
on conflict (alias) do update
  set store_name = excluded.store_name,
      note       = excluded.note;

-- ------------------------------------------------------------
-- 2. 氏名の異体字をならす
--    渡邉 と 渡邊、髙橋 と 高橋 のような字の揺れで別人にしないための照合キー。
--    保存する氏名はシートのままで、ここで作るのは突き合わせ用のキーだけ。
-- ------------------------------------------------------------

create or replace function app.name_fold(p_name text)
returns text
language sql
immutable
as $$
  select nullif(
    translate(
      coalesce(app.name_key(p_name), ''),
      '邉邊髙﨑嵜濟齊齋凜冨眞廣惠澤瀧濱曾德瀨檜嶋栁槗塲ニ',
      '辺辺高崎崎済斉斎凛富真広恵沢滝浜曽徳瀬桧島柳橋場二'
    ),
    ''
  );
$$;

comment on function app.name_fold is
  '氏名の異体字をならした照合キー。空白と旧姓括弧は app.name_key が落とす';

-- 字そのものが違う場合の読み替え(シートの氏名 → 既存名簿の氏名)。
create table if not exists public.member_name_aliases (
  alias_key   text primary key,                       -- app.name_key(シートの氏名)
  name_key    text not null,                          -- public.members.name_key
  note        text,
  created_at  timestamptz not null default now()
);

comment on table public.member_name_aliases is
  '同じ人が別表記で載っているときの読み替え。異体字は app.name_fold が吸収するので、ここには字そのものが違うものだけ入れる';

alter table public.member_name_aliases enable row level security;
drop policy if exists member_name_aliases_select on public.member_name_aliases;
create policy member_name_aliases_select on public.member_name_aliases
  for select to authenticated using (true);
drop policy if exists member_name_aliases_manage on public.member_name_aliases;
create policy member_name_aliases_manage on public.member_name_aliases
  for all to authenticated
  using (app.can_edit_org()) with check (app.can_edit_org());
grant select, insert, update, delete on public.member_name_aliases to authenticated;

-- ------------------------------------------------------------
-- 3. 役職・性別の読み替え
-- ------------------------------------------------------------

create or replace function app.staff_rank_of(p_role text)
returns public.member_rank
language sql
immutable
as $$
  select case
    when l is null or l = ''                    then 'staff'
    when l ~ '統括院長|エリア院長|ブロック院長' then 'chief'
    when l ~ '社長|代表'                        then 'exec'     -- 「社長/統括マネージャー」はここ
    when l ~ '統括マネージャ|統括マネジャ|統括MG|統括ＭＧ|ゼネラルマネージャ' then 'exec'
    when l ~ 'マネージャ|マネジャ|エリア長'     then 'area'
    when l ~ '^(MG|ＭＧ)$'                      then 'area'
    when l ~ '院長|店長'                        then 'manager'
    when l ~ '事務'                             then 'clerk'
    when l ~ '本部|人事|総務'                   then 'hr'
    when l ~ 'メンター'                         then 'mentor'
    else 'staff'
  end::public.member_rank
  from (select btrim(regexp_replace(coalesce(p_role, ''), '[[:space:]　]+', '', 'g')) as l) t;
$$;

comment on function app.staff_rank_of is '名簿シートの役職欄をランクに読み替える。統括院長は院長より先に判定する';

create or replace function app.staff_department_of(p_rank public.member_rank)
returns public.department
language sql
immutable
as $$
  select case
    when p_rank::text in ('ceo', 'exec', 'area', 'chief') then 'management'
    when p_rank::text in ('hr', 'clerk')                  then 'head_office'
    else 'seitai'
  end::public.department;
$$;

create or replace function app.staff_gender_of(p_label text)
returns public.gender
language sql
immutable
as $$
  select case
    when l ~ '^(男|男性)$'       then 'male'
    when l ~ '^(女|女性)$'       then 'female'
    when l ~ 'その他|回答しない' then 'other'
    else 'unknown'
  end::public.gender
  from (select btrim(regexp_replace(coalesce(p_label, ''), '[[:space:]　]+', '', 'g')) as l) t;
$$;

-- ------------------------------------------------------------
-- 4. シートを 1 人 1 行に読み解く
-- ------------------------------------------------------------

create or replace function app.parse_staff_sheet(p_tsv text)
returns table (
  row_no      integer,
  state       text,
  employee_no text,
  full_name   text,
  gender      public.gender,
  role_title  text,
  store_names text[],
  email       text
)
language sql
stable
as $$
  with raw as (
    select row_number() over () as ln, replace(l, chr(13), '') as line
      from regexp_split_to_table(coalesce(p_tsv, ''), chr(10)) as l
  ), cells as (
    select ln, array(select btrim(x) from unnest(string_to_array(line, chr(9))) as x) as c
      from raw
     where btrim(replace(line, chr(9), '')) <> ''
  ), rows_only as (
    -- 見出し行・区切り行を落とす。姓があって、性別か社員番号が入っている行だけ読む
    select ln, c,
           (select min(i) from generate_subscripts(c, 1) i
             where i >= 5
               and c[i] ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') as email_i
      from cells
     where coalesce(c[3], '') <> ''
       and (app.staff_gender_of(c[5]) <> 'unknown' or coalesce(c[2], '') ~ '^[0-9]+$')
  )
  select
    (row_number() over (order by r.ln))::integer,
    nullif(r.c[1], ''),
    nullif(r.c[2], ''),
    btrim(r.c[3] || ' ' || coalesce(r.c[4], '')),
    app.staff_gender_of(r.c[5]),
    nullif(r.c[6], ''),
    coalesce((
      select array_agg(d.s order by d.ord)
        from (
          select u.x as s, min(u.i) as ord
            from unnest(r.c[7:coalesce(r.email_i, array_length(r.c, 1) + 1) - 1])
                 with ordinality as u(x, i)
           where btrim(coalesce(u.x, '')) not in ('', '-', '—', 'なし', '無し')
           group by u.x
        ) d
    ), '{}'::text[]),
    case when r.email_i is null then null else lower(r.c[r.email_i]) end
  from rows_only r;
$$;

comment on function app.parse_staff_sheet is
  '名簿シート(状態/社員番号/姓/名/性別/役職/店舗…/メール)を 1 人 1 行にほどく。店舗は重複を除いて並び順のまま返す';

-- ------------------------------------------------------------
-- 5. 既存メンバーとの突き合わせ
--    社員番号 → 氏名 → 別表記 → 異体字 → メール の順で探す。
--    別の社員番号が既に入っている人には、氏名やメールでは重ねない。
-- ------------------------------------------------------------

create or replace function app.staff_match_member(
  p_employee_no text,
  p_full_name   text,
  p_email       text
)
returns uuid
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(
    -- 1) 社員番号が一致する人
    (select m.id from public.members m
      where p_employee_no is not null and m.employee_no = p_employee_no),
    -- 2) 氏名(空白と旧姓括弧を無視)が一致する人
    (select m.id from public.members m
      where m.name_key = app.name_key(p_full_name)
        and (m.employee_no is null or p_employee_no is null or m.employee_no = p_employee_no)),
    -- 3) 別表記の読み替え表で一致する人
    (select m.id from public.members m
      join public.member_name_aliases a on a.name_key = m.name_key
     where a.alias_key = app.name_key(p_full_name)
       and (m.employee_no is null or p_employee_no is null or m.employee_no = p_employee_no)),
    -- 4) 異体字をならすと一致する人(1人に絞れるときだけ)
    (select (array_agg(m.id))[1] from public.members m
      where app.name_fold(m.full_name) = app.name_fold(p_full_name)
        and (m.employee_no is null or p_employee_no is null or m.employee_no = p_employee_no)
     having count(*) = 1),
    -- 5) メールが一致する人(1人に絞れるときだけ)
    (select (array_agg(m.id))[1] from public.members m
      where p_email is not null and lower(m.email) = lower(p_email)
        and (m.employee_no is null or p_employee_no is null or m.employee_no = p_employee_no)
     having count(*) = 1)
  );
$$;

comment on function app.staff_match_member is
  '名簿シートの 1 行が、既にいるメンバーの誰にあたるかを返す。見つからなければ null(=新規)';

-- ------------------------------------------------------------
-- 6. 取込前プレビュー(書き込みなし)
-- ------------------------------------------------------------

create or replace function public.preview_staff_sheet(p_tsv text)
returns table (
  row_no        integer,
  employee_no   text,
  full_name     text,
  gender        text,
  rank          text,
  role_title    text,
  primary_store text,
  extra_stores  text[],
  email         text,
  state         text,
  matched_to    text,      -- 重なる既存メンバー(空なら新規に作られる)
  unknown_store text[]     -- 名簿に見つからない店舗名
)
language sql
stable
as $$
  with s as (
    select p.*, app.staff_rank_of(p.role_title) as rank
      from app.parse_staff_sheet(p_tsv) p
  ), names as (
    select s.row_no, n.name, n.ord,
           coalesce(a.store_name, n.name) as want_name,
           (select st.name from public.stores st
             where st.name = n.name or st.name = coalesce(a.store_name, n.name)
             order by (st.name = n.name) desc limit 1) as found_name
      from s
      cross join lateral unnest(s.store_names) with ordinality as n(name, ord)
      left join public.store_aliases a on a.alias = n.name
  )
  select
    s.row_no,
    s.employee_no,
    s.full_name,
    s.gender::text,
    s.rank::text,
    s.role_title,
    (select nm.want_name from names nm where nm.row_no = s.row_no order by nm.ord limit 1),
    (select array_agg(nm.want_name order by nm.ord) from names nm
      where nm.row_no = s.row_no and nm.ord > 1),
    s.email,
    s.state,
    (select m.full_name from public.members m
      where m.id = app.staff_match_member(s.employee_no, s.full_name, s.email)),
    (select array_agg(distinct nm.name) from names nm
      where nm.row_no = s.row_no and nm.found_name is null)
  from s
  order by s.row_no;
$$;

comment on function public.preview_staff_sheet is
  '名簿シートを取り込まずに確認する。既存メンバーとの重なりと、名簿に無い店舗が分かる';

-- ------------------------------------------------------------
-- 7. 本体:一括登録
-- ------------------------------------------------------------

create or replace function public.import_staff_sheet(
  p_tsv          text,
  p_options      jsonb default '{}'::jsonb,
  p_source_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  -- 名簿に無い店舗をその名前で作る
  v_create_stores boolean := coalesce((p_options ->> 'create_missing_stores')::boolean, true);
  -- シートに載っていない在籍者を退職扱いにする(初回は false のまま差分を見ること)
  v_deactivate    boolean := coalesce((p_options ->> 'deactivate_missing')::boolean, false);
  -- 上司が空欄の人だけ、主所属の店舗から上長をたどって埋める
  v_link_managers boolean := coalesce((p_options ->> 'link_managers')::boolean, true);
  -- 店舗の院長・統括院長・MG 列もシートから書き換える(組織図取込と衝突しうるので既定は false)
  v_set_leaders   boolean := coalesce((p_options ->> 'set_store_leaders')::boolean, false);
  v_default_cat   text    := coalesce(p_options ->> 'default_category', '整骨院');
  v_rows          integer := 0;
  v_new_members   integer := 0;
  v_upd_members   integer := 0;
  v_new_stores    integer := 0;
  v_assignments   integer := 0;
  v_managers      integer := 0;
  v_leaders       integer := 0;
  v_deactivated   integer := 0;
begin
  -- 同じセッションで 2 回流したときのために、前回の作業表を落としておく
  -- (drop table if exists は毎回 NOTICE を出すので to_regclass で確かめる)
  if to_regclass('pg_temp._staff_rows')       is not null then drop table _staff_rows;       end if;
  if to_regclass('pg_temp._staff_stores')     is not null then drop table _staff_stores;     end if;
  if to_regclass('pg_temp._staff_new_stores') is not null then drop table _staff_new_stores; end if;
  if to_regclass('pg_temp._staff_assign')     is not null then drop table _staff_assign;     end if;

  -- ---- 1) シートを読む --------------------------------------
  create temp table _staff_rows on commit drop as
  select p.*,
         app.staff_rank_of(p.role_title) as rank,
         app.name_key(p.full_name)       as name_key,
         app.staff_match_member(p.employee_no, p.full_name, p.email) as member_id
    from app.parse_staff_sheet(p_tsv) p;

  select count(*) into v_rows from _staff_rows;
  if v_rows = 0 then
    raise exception '取り込める行がありませんでした。姓・性別・社員番号の列を確認してください';
  end if;

  -- 同じ社員番号が 2 行に出てきたら、どちらを採るか決められないので止める
  if exists (select 1 from _staff_rows where employee_no is not null
              group by employee_no having count(*) > 1) then
    raise exception '社員番号が重複しています: %'
      , (select string_agg(distinct r.employee_no, ', ') from _staff_rows r
          where r.employee_no is not null
            and (select count(*) from _staff_rows x where x.employee_no = r.employee_no) > 1)
      using errcode = 'unique_violation';
  end if;

  -- 異体字あわせで 2 行が同じ人に重なったら、後の行は新規に倒す
  update _staff_rows r set member_id = null
   where r.member_id is not null
     and r.row_no > (select min(x.row_no) from _staff_rows x where x.member_id = r.member_id);

  -- ---- 2) 店舗名を解決する ----------------------------------
  create temp table _staff_stores on commit drop as
  select distinct n.name as sheet_name,
         coalesce(a.store_name, n.name) as want_name,
         null::uuid as store_id
    from (select distinct unnest(store_names) as name from _staff_rows) n
    left join public.store_aliases a on a.alias = n.name;

  update _staff_stores t set store_id = s.id
    from public.stores s where s.name = t.sheet_name;                       -- シートの書き方そのもの
  update _staff_stores t set store_id = s.id
    from public.stores s where t.store_id is null and s.name = t.want_name; -- 別名を通して

  create temp table _staff_new_stores (name text) on commit drop;

  if v_create_stores then
    with created as (
      insert into public.stores (code, name, category, sort_order, is_active)
      select 'st-' || app.name_key(t.want_name), t.want_name,
             app.infer_store_category(t.want_name, v_default_cat), 900, true
        from _staff_stores t
       where t.store_id is null
      on conflict do nothing
      returning name
    )
    insert into _staff_new_stores (name) select c.name from created c;

    get diagnostics v_new_stores = row_count;

    update _staff_stores t set store_id = s.id
      from public.stores s where t.store_id is null and s.name = t.want_name;
  end if;

  -- 1 行ぶんの所属を、主所属 + 追加所属の店舗コードにたたむ
  create temp table _staff_assign on commit drop as
  select r.row_no,
         (array_agg(s.code order by n.ord))[1]  as primary_code,
         (array_agg(s.code order by n.ord))[2:] as extra_codes
    from _staff_rows r
    cross join lateral unnest(r.store_names) with ordinality as n(name, ord)
    join _staff_stores t on t.sheet_name = n.name and t.store_id is not null
    join public.stores  s on s.id = t.store_id
   group by r.row_no;

  -- ---- 3) 既にいる人を更新する ------------------------------
  with upd as (
    update public.members m set
      employee_no      = coalesce(r.employee_no, m.employee_no),
      full_name        = r.full_name,
      -- 異体字が直っていれば取込キーも合わせる。ただし他人と衝突するなら今のまま
      name_key         = case
                           when m.name_key = app.name_key(r.full_name) then m.name_key
                           when exists (select 1 from public.members x
                                         where x.name_key = app.name_key(r.full_name) and x.id <> m.id)
                             then m.name_key
                           else app.name_key(r.full_name)
                         end,
      gender           = case when r.gender = 'unknown' then m.gender else r.gender end,
      -- 役職欄が空("育休中" の行など)ならランク・呼称は今のまま
      rank             = case when r.role_title is null then m.rank else r.rank end,
      role_title       = coalesce(r.role_title, m.role_title),
      -- シートは部門(整体/受付/美容)を持たないので、管理系のときだけ書き換える
      department       = case when r.role_title is not null
                               and r.rank::text in ('ceo','exec','area','chief','hr','clerk')
                              then app.staff_department_of(r.rank)
                              else m.department end,
      primary_store_id = coalesce(app.store_id_of(a.primary_code), m.primary_store_id),
      store_codes      = case when a.extra_codes is null then m.store_codes else a.extra_codes end,
      email            = coalesce(r.email, m.email),
      is_active        = true,
      left_on          = null,
      note             = case when r.state is not null then r.state
                              when m.note in ('育休中','産休中','休職中') then null
                              else m.note end,
      updated_at       = now()
    from _staff_rows r
    left join _staff_assign a on a.row_no = r.row_no
    where m.id = r.member_id
    returning 1
  )
  select count(*) into v_upd_members from upd;

  -- ---- 4) 新しい人を足す ------------------------------------
  with ins as (
    insert into public.members (
      name_key, employee_no, full_name, gender, rank, role_title, department,
      primary_store_id, store_codes, email, is_active, note, sort_order)
    select
      -- 同姓同名は取込キーに社員番号を足して区別する
      case when exists (select 1 from public.members x where x.name_key = r.name_key)
             or (select count(*) from _staff_rows y where y.name_key = r.name_key) > 1
           then r.name_key || '@' || coalesce(r.employee_no, r.row_no::text)
           else r.name_key end,
      r.employee_no,
      r.full_name,
      r.gender,
      r.rank,
      coalesce(r.role_title, 'スタッフ'),
      app.staff_department_of(r.rank),
      app.store_id_of(a.primary_code),
      coalesce(a.extra_codes, '{}'::text[]),
      r.email,
      true,
      r.state,
      r.row_no * 10
    from _staff_rows r
    left join _staff_assign a on a.row_no = r.row_no
    where r.member_id is null
    returning 1
  )
  select count(*) into v_new_members from ins;

  -- 新しく入った人も、以降の処理で引けるように結び直す
  update _staff_rows r
     set member_id = app.staff_match_member(r.employee_no, r.full_name, r.email)
   where r.member_id is null;

  -- ---- 5) 所属(兼務を含む)を張り直す ----------------------
  -- シートに店舗が書かれている人だけ。空欄の人(本部・育休中)の所属は触らない。
  delete from public.member_store_assignments a
   using _staff_rows r, _staff_assign x
   where a.member_id = r.member_id and x.row_no = r.row_no;

  insert into public.member_store_assignments (member_id, store_id, department, role_title, is_primary)
  select distinct on (r.member_id, t.store_id)
         r.member_id, t.store_id, m.department, r.role_title, n.ord = 1
    from _staff_rows r
    join public.members m on m.id = r.member_id
    cross join lateral unnest(r.store_names) with ordinality as n(name, ord)
    join _staff_stores t on t.sheet_name = n.name and t.store_id is not null
   order by r.member_id, t.store_id, n.ord
  on conflict (member_id, store_id, department) do update
    set role_title = excluded.role_title,
        is_primary = excluded.is_primary;

  get diagnostics v_assignments = row_count;

  -- ---- 6) 店舗の責任者列(任意) ----------------------------
  if v_set_leaders then
    with leaders as (
      select distinct on (t.store_id, r.rank)
             t.store_id, r.rank, r.member_id
        from _staff_rows r
        cross join lateral unnest(r.store_names) as n(name)
        join _staff_stores t on t.sheet_name = n.name and t.store_id is not null
       where r.member_id is not null and r.rank::text in ('manager','chief','area','exec')
       order by t.store_id, r.rank, coalesce(nullif(r.employee_no, '')::bigint, 999999999)
    ), upd as (
      update public.stores s set
        director_id        = coalesce((select l.member_id from leaders l
                                        where l.store_id = s.id and l.rank::text = 'manager'), s.director_id),
        chief_director_id  = coalesce((select l.member_id from leaders l
                                        where l.store_id = s.id and l.rank::text = 'chief'), s.chief_director_id),
        area_manager_id    = coalesce((select l.member_id from leaders l
                                        where l.store_id = s.id and l.rank::text = 'area'), s.area_manager_id),
        general_manager_id = coalesce((select l.member_id from leaders l
                                        where l.store_id = s.id and l.rank::text = 'exec'), s.general_manager_id),
        updated_at         = now()
      where exists (select 1 from leaders l where l.store_id = s.id)
      returning 1
    )
    select count(*) into v_leaders from upd;
  end if;

  -- ---- 7) 上司が空欄の人に上司をつける(任意) ---------------
  -- シートは上司の列を持たないので、主所属の店舗にいる
  --   院長 → 統括院長 → マネージャー
  -- の順で、自分より上のいちばん近い人を入れる。既に付いている人は触らない。
  if v_link_managers then
    with mine as (
      select distinct r.member_id, r.rank, s.id as store_id
        from _staff_rows r
        join _staff_assign a on a.row_no = r.row_no
        join public.stores s on s.code = a.primary_code
       where r.member_id is not null
    ), pool as (
      select distinct t.store_id, r.rank, r.member_id
        from _staff_rows r
        cross join lateral unnest(r.store_names) as n(name)
        join _staff_stores t on t.sheet_name = n.name and t.store_id is not null
       where r.member_id is not null and r.rank::text in ('manager','chief','area')
    ), pick as (
      select m.member_id,
             coalesce(
               case when app.rank_level(m.rank) < app.rank_level('manager') then
                 (select p.member_id from pool p
                   where p.store_id = m.store_id and p.rank::text = 'manager'
                     and p.member_id <> m.member_id limit 1) end,
               case when app.rank_level(m.rank) < app.rank_level('chief') then
                 (select p.member_id from pool p
                   where p.store_id = m.store_id and p.rank::text = 'chief'
                     and p.member_id <> m.member_id limit 1) end,
               case when app.rank_level(m.rank) < app.rank_level('area') then
                 (select p.member_id from pool p
                   where p.store_id = m.store_id and p.rank::text = 'area'
                     and p.member_id <> m.member_id limit 1) end
             ) as manager_id
        from mine m
    ), upd as (
      update public.members m
         set reports_to_id = pick.manager_id, updated_at = now()
        from pick
       where m.id = pick.member_id
         and pick.manager_id is not null
         and m.reports_to_id is null
      returning 1
    )
    select count(*) into v_managers from upd;
  end if;

  -- ---- 8) シートに載っていない在籍者(任意で退職扱い) --------
  if v_deactivate then
    with gone as (
      update public.members m
         set is_active  = false,
             left_on    = coalesce(m.left_on, current_date),
             updated_at = now()
       where m.is_active
         and not exists (select 1 from _staff_rows r where r.member_id = m.id)
      returning 1
    )
    select count(*) into v_deactivated from gone;
  end if;

  -- ---- 9) 結果を返す ----------------------------------------
  return jsonb_build_object(
    'source',           p_source_label,
    'rows',             v_rows,
    'members_new',      v_new_members,
    'members_updated',  v_upd_members,
    'stores_new',       v_new_stores,
    'assignments',      v_assignments,
    'managers_linked',  v_managers,
    'store_leaders',    v_leaders,
    'deactivated',      v_deactivated,
    -- 新しく作った店舗(略称と正式名称のずれを見つける手がかりになる)
    'created_stores',   (select coalesce(jsonb_agg(n.name order by n.name), '[]'::jsonb)
                           from _staff_new_stores n),
    -- どの店舗にも結び付かなかった名前(create_missing_stores = false のときに出る)
    'unknown_stores',   (select coalesce(jsonb_agg(distinct t.sheet_name), '[]'::jsonb)
                           from _staff_stores t where t.store_id is null),
    -- 上司が空欄のまま残っている人(組織図の画面でつなぐ)
    'without_manager',  (select coalesce(jsonb_agg(m.full_name order by m.full_name), '[]'::jsonb)
                           from public.members m
                          where m.is_active and m.reports_to_id is null
                            and m.rank::text not in ('ceo','exec','hr','clerk')
                            and exists (select 1 from _staff_rows r where r.member_id = m.id)),
    -- 所属店舗が 1 つも決まらなかった人
    'without_store',    (select coalesce(jsonb_agg(r.full_name order by r.full_name), '[]'::jsonb)
                           from _staff_rows r
                          where not exists (select 1 from _staff_assign a where a.row_no = r.row_no)),
    -- シートに載っていない在籍者(退職・改姓の取りこぼしを見つける)
    'not_in_sheet',     (select coalesce(jsonb_agg(m.full_name order by m.full_name), '[]'::jsonb)
                           from public.members m
                          where m.is_active
                            and not exists (select 1 from _staff_rows r where r.member_id = m.id))
  );
end;
$$;

comment on function public.import_staff_sheet is
  '人事の名簿シート(社員番号・氏名・性別・役職・所属店舗・メール)を貼って、メンバーを一括登録する';

revoke all on function public.import_staff_sheet(text, jsonb, text) from public, anon;
grant execute on function public.import_staff_sheet(text, jsonb, text) to authenticated, service_role;
revoke all on function public.preview_staff_sheet(text) from public, anon;
grant execute on function public.preview_staff_sheet(text) to authenticated, service_role;
