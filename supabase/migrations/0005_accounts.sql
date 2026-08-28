-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 05:社員アカウントの紐付け
--
-- 組織図シートには氏名しか無いので、Supabase Auth のユーザーとは
-- 「メールアドレス」を橋渡しにして結びつける。
--
--   1) members.email を埋める        … set_member_emails()
--   2) Supabase Auth で社員を招待する … ダッシュボード / Admin API
--   3) auth.users と突き合わせる      … link_member_accounts()
--
-- 3 は何度実行してもよい。招待を受けた人から順に紐付いていく。
-- ============================================================

-- ------------------------------------------------------------
-- メールアドレスの一括設定
-- ------------------------------------------------------------

/**
 * 氏名 → メールアドレス の対応をまとめて登録する。
 *   select public.set_member_emails('[
 *     {"name": "日野 碧人", "email": "hino@example.co.jp"},
 *     {"name": "竹内 香織", "email": "takeuchi@example.co.jp"}
 *   ]'::jsonb);
 * 氏名は空白の有無を無視して照合する(取込と同じキー)。
 */
create or replace function public.set_member_emails(p_pairs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_updated integer := 0;
  v_missing text[] := '{}';
  v_item    jsonb;
begin
  if not app.can_edit_org() then
    raise exception 'メールアドレスの一括設定は統括マネージャー以上または本部人事のみ実行できます'
      using errcode = 'insufficient_privilege';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) loop
    update public.members m
       set email = nullif(btrim(v_item ->> 'email'), ''),
           updated_at = now()
     where m.name_key = app.name_key(v_item ->> 'name');
    if found then
      v_updated := v_updated + 1;
    else
      v_missing := v_missing || (v_item ->> 'name');
    end if;
  end loop;

  return jsonb_build_object(
    'updated', v_updated,
    'not_found', to_jsonb(v_missing)
  );
end;
$$;

comment on function public.set_member_emails is '氏名とメールアドレスの対応をまとめて登録する(組織図取込のあとに実行する)';

revoke all on function public.set_member_emails(jsonb) from public, anon;
grant execute on function public.set_member_emails(jsonb) to authenticated, service_role;

-- ------------------------------------------------------------
-- Auth ユーザーとの突き合わせ
-- ------------------------------------------------------------

/**
 * members.email と auth.users.email が一致する行を紐付ける。
 * 招待の進み具合に合わせて何度でも実行してよい。
 */
create or replace function public.link_member_accounts()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_linked integer := 0;
begin
  if not app.can_edit_org() then
    raise exception 'アカウントの紐付けは統括マネージャー以上または本部人事のみ実行できます'
      using errcode = 'insufficient_privilege';
  end if;

  with pairs as (
    select m.id as member_id, u.id as user_id
      from public.members m
      join auth.users u on lower(u.email) = lower(m.email)
     where m.email is not null
       and m.auth_user_id is distinct from u.id
       -- 1人のユーザーが2人のメンバーに紐付かないようにする
       and not exists (select 1 from public.members x where x.auth_user_id = u.id)
  ), upd as (
    update public.members m
       set auth_user_id = p.user_id, updated_at = now()
      from pairs p
     where m.id = p.member_id
    returning 1
  )
  select count(*) into v_linked from upd;

  return jsonb_build_object(
    'linked', v_linked,
    'total_linked', (select count(*) from public.members where auth_user_id is not null),
    'awaiting_invite', (select coalesce(jsonb_agg(full_name order by full_name), '[]'::jsonb)
                          from public.members
                         where is_active and auth_user_id is null and email is not null),
    'missing_email', (select count(*) from public.members where is_active and email is null)
  );
end;
$$;

comment on function public.link_member_accounts is 'members.email と auth.users.email を突き合わせてログインアカウントを紐付ける';

revoke all on function public.link_member_accounts() from public, anon;
grant execute on function public.link_member_accounts() to authenticated, service_role;

-- ------------------------------------------------------------
-- 自分の情報(画面の初期表示に使う)
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
    'full_name',     m.full_name,
    'rank',          m.rank,
    'rank_label',    app.rank_label(m.rank),
    'rank_level',    app.rank_level(m.rank),
    'role_title',    m.role_title,
    'department',    m.department,
    'store_id',      m.primary_store_id,
    'store_name',    s.name,
    'manager_id',    m.reports_to_id,
    'can_edit_org',  app.can_edit_org(),
    'managed_store_ids', (select coalesce(jsonb_agg(store_id), '[]'::jsonb) from app.managed_store_ids(m.id)),
    'subordinates',      (select count(*) from app.subtree_ids(m.id)),
    'mentees',           (select count(*) from public.mentorships ms
                           where ms.mentor_id = m.id and ms.ended_on is null)
  ) end
  from public.members m
  left join public.stores s on s.id = m.primary_store_id
  where m.id = app.current_member_id();
$$;

comment on function public.me is 'ログイン中のメンバー情報。画面の権限判定(js/auth.js)の初期値として使う';

grant execute on function public.me() to authenticated;

-- ------------------------------------------------------------
-- 紐付け状況の確認ビュー
-- ------------------------------------------------------------

create or replace view public.v_account_status as
select
  m.id,
  m.full_name,
  m.role_title,
  s.name as store_name,
  m.email,
  case
    when m.auth_user_id is not null then 'ログイン可'
    when m.email is null            then 'メール未登録'
    else '招待待ち'
  end as status,
  m.is_active
from public.members m
left join public.stores s on s.id = m.primary_store_id
where m.is_active;

comment on view public.v_account_status is 'アカウント発行の進捗。「メール未登録」→「招待待ち」→「ログイン可」の順に進む';

grant select on public.v_account_status to authenticated;
