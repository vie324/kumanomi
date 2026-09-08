-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 06:アプリとの橋渡し
--
-- アプリ側(js/)は uuid ではなく「安定コード」でデータを持っている。
--
--   店舗  … stores.code        ('st-narimasu')
--   人    … members.employee_no('145')
--
-- 画面のあいだで id を持ち回るのはこのコードなので、
-- 参照用ビューにもコードを返させて、uuid をブラウザに出さずに済ませる。
-- (js/remote.js の toLocal がこの列名をそのまま読む)
--
-- 破壊的変更なし。既存の列はそのままで、末尾に足すだけ。
-- ============================================================

-- ------------------------------------------------------------
-- 社労士へ提出する「所属コード」。給与連絡表の1列目に入る2桁の番号で、
-- 店舗ごとに固定。アプリ側は stores.deptCode として持っている。
-- ------------------------------------------------------------
alter table public.stores add column if not exists dept_code text;

comment on column public.stores.dept_code is '社労士提出用の所属コード(給与連絡表の「所属」列)';

-- ------------------------------------------------------------
-- 名簿ビューにコード列を足す
--   create or replace view は「末尾への追加」だけ許されるため、
--   既存の列順は 0002 のまま一字も変えずに写している。
-- ------------------------------------------------------------
create or replace view public.v_member_directory as
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
  -- ↓ ここから 0006 で追加。アプリが使う安定コードと表示用の属性
  s.code   as store_code,
  mgr.employee_no as manager_employee_no,
  m.color,
  m.employment,
  m.sort_order
from public.members m
left join public.stores  s   on s.id = m.primary_store_id
left join public.members mgr on mgr.id = m.reports_to_id;

comment on view public.v_member_directory is
  'メンバー名簿。ランク・部門・上司・配下人数をラベル付きで返す。store_code / manager_employee_no はアプリ側の安定キー';

-- ------------------------------------------------------------
-- 店舗ビュー(アプリの stores コレクションに対応)
--   RLS で stores を直接読ませているが、
--   列名をアプリ側の形にそろえた入口も用意しておく。
-- ------------------------------------------------------------
create or replace view public.v_app_stores as
select
  s.code,
  s.name,
  s.short_name,
  s.category,
  s.postal_code,
  s.address,
  s.phone,
  s.lat,
  s.lng,
  s.radius_m,
  s.open_hour,
  s.close_hour,
  s.closed_dow,
  s.beds,
  s.color,
  s.dept_code,
  s.is_pilot,
  s.sort_order
from public.stores s
where s.is_active
order by s.sort_order, s.name;

comment on view public.v_app_stores is '店舗一覧(アプリの stores コレクション用。uuid を出さない)';

grant select on public.v_app_stores to authenticated;

-- ------------------------------------------------------------
-- 自分の情報にも安定コードを持たせる
--   ログイン直後、アプリはこれで「自分が名簿のどの行か」を決める。
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
    'rank',          m.rank,
    'rank_label',    app.rank_label(m.rank),
    'rank_level',    app.rank_level(m.rank),
    'role_title',    m.role_title,
    'department',    m.department,
    'store_id',      m.primary_store_id,
    'store_code',    s.code,
    'store_name',    s.name,
    'manager_id',    m.reports_to_id,
    'manager_employee_no', (select mgr.employee_no from public.members mgr where mgr.id = m.reports_to_id),
    'can_edit_org',  app.can_edit_org(),
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

comment on function public.me is
  'ログイン中のメンバー情報。画面の権限判定(js/auth.js)の初期値として使う。employee_no / store_code はアプリ側の安定キー';

grant execute on function public.me() to authenticated;

-- ------------------------------------------------------------
-- 社員番号が空だと、アプリ側の安定キーが作れない。
-- 取込直後に一括で振れるようにしておく(既に入っている番号は触らない)。
--   select public.fill_employee_numbers();       -- 既定の 'K0001' 形式
--   select public.fill_employee_numbers('S', 3); -- 'S001' 形式
-- ------------------------------------------------------------
create or replace function public.fill_employee_numbers(
  p_prefix text default 'K',
  p_width  integer default 4
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_filled integer := 0;
  v_next   integer;
begin
  if not app.can_edit_org() then
    raise exception '社員番号の一括採番は統括マネージャー以上または本部人事のみ実行できます'
      using errcode = 'insufficient_privilege';
  end if;

  -- 既存の 'K0007' のような番号から続きを決める
  select coalesce(max(substring(employee_no from '^' || p_prefix || '([0-9]+)$')::integer), 0) + 1
    into v_next
    from public.members
   where employee_no ~ ('^' || p_prefix || '[0-9]+$');

  with target as (
    select id, row_number() over (order by sort_order, full_name) - 1 as n
      from public.members
     where employee_no is null
  )
  update public.members m
     set employee_no = p_prefix || lpad((v_next + t.n)::text, p_width, '0'),
         updated_at = now()
    from target t
   where m.id = t.id;

  get diagnostics v_filled = row_count;

  return jsonb_build_object(
    'filled', v_filled,
    'total_with_number', (select count(*) from public.members where employee_no is not null),
    'still_missing',     (select count(*) from public.members where employee_no is null)
  );
end;
$$;

comment on function public.fill_employee_numbers is
  '社員番号が空のメンバーに連番を振る。アプリ側の安定キーになるため、取込後に一度実行する';

revoke all on function public.fill_employee_numbers(text, integer) from public, anon;
grant execute on function public.fill_employee_numbers(text, integer) to authenticated, service_role;
