-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 08:最初の管理者を作る
--
-- 鶏と卵の問題を解く。
--   ・名簿を登録できるのは「統括マネージャー以上または本部人事」
--   ・でも最初はその人自身が名簿に居ない
--   → ログインはできるのに「名簿と紐付いていません」で止まる
--
-- そこで、SQL Editor から 1 回だけ実行して最初の管理者を作れるようにする。
--
--   select public.bootstrap_admin('admin@example.co.jp', '管理 太郎');
--
-- 手順:
--   1. Supabase → Authentication → Users → Add user で
--      メールアドレスとパスワードを決めてユーザーを作る
--      (パスワードはここで決める。SQL には書かない)
--   2. SQL Editor で上の 1 行を実行する
--   3. アプリにそのメールとパスワードでログインする
--
-- ------------------------------------------------------------
-- 安全のための決まりごと
--   ・ブラウザからは呼べない(anon / authenticated から実行権限を外す)
--     SQL Editor か service_role からしか実行できない
--   ・すでに別の管理者が居るときは断る。2人目以降は通常の
--     set_member_emails() + link_member_accounts() で紐付ける
--   ・同じ人に対して何度実行しても増えない(冪等)
-- ============================================================

create or replace function public.bootstrap_admin(
  p_email       text,
  p_name        text default '管理者',
  p_employee_no text default null,
  p_rank        text default 'ceo'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user_id  uuid;
  v_email    text := lower(btrim(p_email));
  v_key      text := app.name_key(p_name);
  v_emp      text := nullif(btrim(coalesce(p_employee_no, '')), '');
  v_member   public.members;
  v_other    text;
  v_action   text;
  v_store    text;
begin
  if v_email is null or v_email = '' then
    raise exception 'メールアドレスを指定してください' using errcode = 'invalid_parameter_value';
  end if;
  if p_rank not in ('ceo', 'exec', 'hr') then
    raise exception 'p_rank は ceo / exec / hr のいずれかにしてください(指定: %)', p_rank
      using errcode = 'invalid_parameter_value';
  end if;

  -- 1) Supabase Auth のユーザーを探す
  select u.id into v_user_id
    from auth.users u
   where lower(u.email) = v_email
   limit 1;

  if v_user_id is null then
    raise exception
      E'% のユーザーが Supabase Authentication にありません。\n'
      '先に Authentication → Users → Add user でメールとパスワードを登録してから、もう一度実行してください。', p_email
      using errcode = 'no_data_found';
  end if;

  -- 2) この人の名簿行を探す(紐付け済み → 同姓同名 → 同じメール の順)
  select * into v_member from public.members where auth_user_id = v_user_id;
  if v_member.id is null and v_key is not null then
    select * into v_member from public.members where name_key = v_key;
  end if;
  if v_member.id is null then
    select * into v_member from public.members where lower(email) = v_email;
  end if;

  -- 3) 初回だけ許す。すでに別の管理者が居るなら断る
  select m.full_name into v_other
    from public.members m
   where m.auth_user_id is not null
     and m.auth_user_id <> v_user_id
     and app.rank_level(m.rank) >= 6
   limit 1;

  if v_other is not null and (v_member.id is null or app.rank_level(v_member.rank) < 6) then
    raise exception
      E'管理者はすでに登録されています(%)。\n'
      '2人目以降は set_member_emails() と link_member_accounts()、'
      'または画面の「メンバー・組織図の一括登録」から紐付けてください。', v_other
      using errcode = 'unique_violation';
  end if;

  -- 4) 社員番号を決める(アプリはこれで人を識別する)
  if v_emp is null then v_emp := nullif(btrim(coalesce(v_member.employee_no, '')), ''); end if;
  if v_emp is null then
    v_emp := 'ADMIN001';
    while exists (select 1 from public.members where employee_no = v_emp) loop
      v_emp := 'ADMIN' || lpad((substring(v_emp from 6)::integer + 1)::text, 3, '0');
    end loop;
  end if;

  -- 5) 名簿に登録するか、既存の行を管理者に引き上げる
  if v_member.id is null then
    insert into public.members (
      name_key, employee_no, auth_user_id, full_name, email,
      rank, role_title, department, is_active
    ) values (
      coalesce(v_key, 'admin-' || left(v_user_id::text, 8)),
      v_emp, v_user_id, p_name, v_email,
      p_rank::public.member_rank,
      case p_rank when 'hr' then '本部人事' when 'exec' then '統括マネージャー' else '社長' end,
      'head_office'::public.department, true
    )
    returning * into v_member;
    v_action := 'created';
  else
    update public.members m
       set auth_user_id = v_user_id,
           email        = coalesce(nullif(btrim(m.email), ''), v_email),
           employee_no  = coalesce(nullif(btrim(m.employee_no), ''), v_emp),
           rank         = case when app.rank_level(m.rank) >= app.rank_level(p_rank::public.member_rank)
                               then m.rank else p_rank::public.member_rank end,
           is_active    = true,
           updated_at   = now()
     where m.id = v_member.id
    returning * into v_member;
    v_action := 'linked';
  end if;

  select s.name into v_store from public.stores s where s.id = v_member.primary_store_id;

  return jsonb_build_object(
    'action',       v_action,
    'member_id',    v_member.id,
    'employee_no',  v_member.employee_no,
    'full_name',    v_member.full_name,
    'rank',         v_member.rank,
    'rank_label',   app.rank_label(v_member.rank),
    'email',        v_member.email,
    'store',        coalesce(v_store, '(未所属)'),
    'can_edit_org', app.rank_level(v_member.rank) >= 6,
    'next',         'このメールアドレスとパスワードでアプリにログインできます'
  );
end;
$$;

comment on function public.bootstrap_admin is
  '最初の管理者を1人だけ作る。SQL Editor から実行する。2人目以降は link_member_accounts() を使う';

-- ブラウザからは絶対に呼べないようにする(呼べたら誰でも管理者になれてしまう)
revoke all on function public.bootstrap_admin(text, text, text, text) from public, anon, authenticated;
grant execute on function public.bootstrap_admin(text, text, text, text) to service_role;

-- ------------------------------------------------------------
-- 紐付けの状態をひと目で見る
--   「ログインできない」と言われたとき、まずこれを見る。
-- ------------------------------------------------------------
create or replace view public.v_login_status
  with (security_invoker = true) as
select
  u.email,
  m.full_name,
  m.employee_no,
  m.rank,
  app.rank_label(m.rank) as rank_label,
  s.name as store_name,
  case
    when m.id is null           then '名簿に未登録 — bootstrap_admin() か 名簿の取り込みが必要'
    when m.employee_no is null  then '社員番号が未設定 — fill_employee_numbers() が必要'
    when not m.is_active        then '退職扱い'
    else 'ログインできます'
  end as status
from auth.users u
left join public.members m on m.auth_user_id = u.id
left join public.stores  s on s.id = m.primary_store_id
order by u.email;

comment on view public.v_login_status is
  'Auth ユーザーと名簿の紐付き状況。ログインできない原因はここに出る';

grant select on public.v_login_status to authenticated;
