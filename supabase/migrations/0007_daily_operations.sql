-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 07:毎日の業務
--
--   勤怠 attendance        … 打刻。給与連絡表の元データ
--   シフト shifts          … 1人1日1枠
--   希望休 shift_requests  … 月ごとの希望(理由は任意)
--   日報 daily_reports     … 施術数・売上・所感
--
-- 見える範囲の考え方は 0004 と同じ。
--   自分 … いつでも
--   配下 … app.can_see_member()(組織図の傘)
--   人事 … 勤怠とシフトは全社(日報は対象外。js/auth.js と揃える)
--   事務 … 給与に直結する勤怠は全社(閲覧のみ)
--
-- アプリ側は uuid ではなく安定コードで持つため、
-- 行を一意にするキーは「アプリが作った id」(app_id)にしている。
-- これで端末側で採番 → あとから送信、という順番でも衝突しない。
-- ============================================================

-- ------------------------------------------------------------
-- 事務職員ランク。js/auth.js の RANKS に 'clerk' を足したので合わせる
-- ------------------------------------------------------------
-- ※ 新しい enum 値は「追加したのと同じトランザクション内では使えない」。
--    そのため以下の関数・ポリシーはすべて ::text で比較している。
alter type public.member_rank add value if not exists 'clerk';

-- ランクの強さ。0002 の app.rank_level に clerk を足す
create or replace function app.rank_level(p_rank public.member_rank)
returns integer
language sql
immutable
as $$
  select case p_rank::text
    when 'ceo'     then 7
    when 'exec'    then 6
    when 'area'    then 5
    when 'chief'   then 4
    when 'manager' then 3
    when 'hr'      then 3
    when 'mentor'  then 2
    when 'clerk'   then 1
    else 1
  end;
$$;

create or replace function app.rank_label(p_rank public.member_rank)
returns text
language sql
immutable
as $$
  select case p_rank::text
    when 'ceo'     then '社長'
    when 'exec'    then '統括マネージャー'
    when 'area'    then 'マネージャー'
    when 'chief'   then '統括院長'
    when 'manager' then '院長・店長'
    when 'hr'      then '本部人事'
    when 'mentor'  then 'メンター'
    when 'clerk'   then '事務職員'
    else 'スタッフ'
  end;
$$;

-- 給与に直結する情報(勤怠・経費・交通費・発注)を最終確認する人
create or replace function app.is_payroll_clerk()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(app.my_rank()::text in ('clerk', 'hr') or app.my_rank_level() >= 6, false);
$$;

-- 勤怠・シフトを全社で扱える人(本部人事・事務・統括マネージャー以上)
create or replace function app.can_see_all_attendance()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(app.my_rank()::text in ('hr', 'clerk') or app.my_rank_level() >= 6, false);
$$;

-- 自分の店舗を管轄しているか(院長・店長以上)
create or replace function app.manages_store(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select p_store_id is not null
     and exists (
       select 1 from app.managed_store_ids(app.current_member_id()) m
        where m.store_id = p_store_id
     );
$$;

-- ------------------------------------------------------------
-- 共通:アプリ側の id を持つ行の作り
--   app_id  … 'at0001' 'sh0012' のようにアプリが採番した安定キー
--   すべての表で unique。sync.js の upsert がこれを使う。
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 勤怠
-- ------------------------------------------------------------
create table if not exists public.attendance (
  id          uuid primary key default gen_random_uuid(),
  app_id      text        not null unique,
  member_id   uuid        not null references public.members (id) on delete cascade,
  store_id    uuid        references public.stores (id) on delete set null,
  work_date   date        not null,
  shift_type  text,                                   -- early / late / full / off / training
  clock_in    time,
  clock_out   time,
  break_min   integer     not null default 0,
  status      text        not null default 'normal',  -- normal / late / early / absent / paid ...
  gps_ok      boolean     not null default true,
  approved    boolean     not null default false,
  approved_by uuid        references public.members (id) on delete set null,
  approved_at timestamptz,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint attendance_break_nonneg check (break_min >= 0),
  constraint attendance_one_per_day unique (member_id, work_date)
);

create index if not exists attendance_member_date_idx on public.attendance (member_id, work_date desc);
create index if not exists attendance_store_date_idx  on public.attendance (store_id, work_date desc);
create index if not exists attendance_unapproved_idx  on public.attendance (approved, work_date desc)
  where approved = false;

comment on table public.attendance is '打刻。給与連絡表(社労士提出)の元データ';

-- ------------------------------------------------------------
-- シフト
-- ------------------------------------------------------------
create table if not exists public.shifts (
  id         uuid primary key default gen_random_uuid(),
  app_id     text        not null unique,
  member_id  uuid        not null references public.members (id) on delete cascade,
  store_id   uuid        references public.stores (id) on delete set null,
  work_date  date        not null,
  shift_type text        not null default 'full',   -- early / late / full / off / training
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shifts_one_per_day unique (member_id, work_date)
);

create index if not exists shifts_date_idx  on public.shifts (work_date);
create index if not exists shifts_store_idx on public.shifts (store_id, work_date);

comment on table public.shifts is 'シフト。1人1日1枠';

-- ------------------------------------------------------------
-- 希望休(月ごと)
--   wishes / reasons は「日付 → 種別」「日付 → 理由」の対応。
--   理由は任意入力なので、空でも提出できる。
-- ------------------------------------------------------------
create table if not exists public.shift_requests (
  id           uuid primary key default gen_random_uuid(),
  app_id       text        not null unique,
  member_id    uuid        not null references public.members (id) on delete cascade,
  target_month text        not null,                     -- 'YYYY-MM'
  wishes       jsonb       not null default '{}'::jsonb, -- {"2026-10-05":"off"}
  reasons      jsonb       not null default '{}'::jsonb, -- {"2026-10-05":"通院のため"}
  note         text,
  submitted_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint shift_requests_month_format check (target_month ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint shift_requests_one_per_month unique (member_id, target_month)
);

create index if not exists shift_requests_month_idx on public.shift_requests (target_month);

comment on table public.shift_requests is '希望休。理由は任意(reasons に入っていない日は理由なし)';

-- ------------------------------------------------------------
-- 日報
-- ------------------------------------------------------------
create table if not exists public.daily_reports (
  id            uuid primary key default gen_random_uuid(),
  app_id        text        not null unique,
  member_id     uuid        not null references public.members (id) on delete cascade,
  store_id      uuid        references public.stores (id) on delete set null,
  report_date   date        not null,
  revenue       integer     not null default 0,
  treatments    integer     not null default 0,
  new_patients  integer     not null default 0,
  proposals     integer     not null default 0,  -- 回数券の提案数
  contracts     integer     not null default 0,  -- 成約数
  goods         integer     not null default 0,  -- 物販
  comment       text,
  ai_summary    text,
  status        text        not null default 'draft',  -- draft / submitted
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint daily_reports_one_per_day unique (member_id, report_date),
  constraint daily_reports_status_ok check (status in ('draft', 'submitted'))
);

create index if not exists daily_reports_member_date_idx on public.daily_reports (member_id, report_date desc);
create index if not exists daily_reports_store_date_idx  on public.daily_reports (store_id, report_date desc);

comment on table public.daily_reports is '日報。閲覧は組織図の傘の中(本部人事は対象外)';

-- ------------------------------------------------------------
-- updated_at
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['attendance', 'shifts', 'shift_requests', 'daily_reports'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format(
      'create trigger %I_touch before update on public.%I
         for each row execute function app.touch_updated_at()', t, t);
  end loop;
end $$;

-- ============================================================
-- 権限(RLS)
-- ============================================================

alter table public.attendance     enable row level security;
alter table public.shifts         enable row level security;
alter table public.shift_requests enable row level security;
alter table public.daily_reports  enable row level security;

-- ---------------- 勤怠 ----------------
-- 見える:自分 / 傘の中 / 全社(人事・事務・統括MG以上)
drop policy if exists attendance_select on public.attendance;
create policy attendance_select on public.attendance
  for select to authenticated
  using (
    member_id = app.current_member_id()
    or app.can_see_all_attendance()
    or app.can_see_member(app.current_member_id(), member_id)
  );

-- 打刻できる:本人だけ(人事は打刻しない。js/auth.js の kintai.punch と同じ)
drop policy if exists attendance_insert on public.attendance;
create policy attendance_insert on public.attendance
  for insert to authenticated
  with check (member_id = app.current_member_id() and app.my_rank()::text <> 'hr');

-- 直せる:本人(未承認のあいだ)/ 管轄の責任者 / 人事
-- ※ 承認済みの打刻を本人が書き換えられないようにする。給与に直結するため
drop policy if exists attendance_update on public.attendance;
create policy attendance_update on public.attendance
  for update to authenticated
  using (
    (member_id = app.current_member_id() and approved = false)
    or app.my_rank()::text in ('hr', 'ceo')
    or app.manages_store(store_id)
  )
  with check (
    (member_id = app.current_member_id() and approved = false)
    or app.my_rank()::text in ('hr', 'ceo')
    or app.manages_store(store_id)
  );

-- 消せる:人事と社長のみ(履歴を守る)
drop policy if exists attendance_delete on public.attendance;
create policy attendance_delete on public.attendance
  for delete to authenticated
  using (app.my_rank()::text in ('hr', 'ceo'));

-- ---------------- シフト ----------------
-- 見える:全社員(誰がいつ出るかは全員が知る必要がある)
drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts
  for select to authenticated using (true);

-- 組める:管轄の責任者・社長(人事は組まない。js/auth.js の shift.edit と同じ)
drop policy if exists shifts_write on public.shifts;
create policy shifts_write on public.shifts
  for all to authenticated
  using (app.my_rank()::text = 'ceo' or (app.my_rank()::text <> 'hr' and app.manages_store(store_id)))
  with check (app.my_rank()::text = 'ceo' or (app.my_rank()::text <> 'hr' and app.manages_store(store_id)));

-- ---------------- 希望休 ----------------
-- 見える:自分 / 傘の中(院長が部下の希望を見る)/ 人事
drop policy if exists shift_requests_select on public.shift_requests;
create policy shift_requests_select on public.shift_requests
  for select to authenticated
  using (
    member_id = app.current_member_id()
    or app.my_rank()::text in ('hr', 'ceo')
    or app.can_see_member(app.current_member_id(), member_id)
  );

-- 出せる・直せる:本人のみ
drop policy if exists shift_requests_write on public.shift_requests;
create policy shift_requests_write on public.shift_requests
  for all to authenticated
  using (member_id = app.current_member_id())
  with check (member_id = app.current_member_id());

-- ---------------- 日報 ----------------
-- 見える:自分 / 傘の中 / メンティー。本部人事と事務は対象外
drop policy if exists daily_reports_select on public.daily_reports;
create policy daily_reports_select on public.daily_reports
  for select to authenticated
  using (
    app.my_rank()::text not in ('hr', 'clerk')
    and (
      member_id = app.current_member_id()
      or app.can_see_member(app.current_member_id(), member_id)
    )
  );

-- 書ける:本人のみ(人事・事務は日報を書かない)
drop policy if exists daily_reports_write on public.daily_reports;
create policy daily_reports_write on public.daily_reports
  for all to authenticated
  using (member_id = app.current_member_id() and app.my_rank()::text not in ('hr', 'clerk'))
  with check (member_id = app.current_member_id() and app.my_rank()::text not in ('hr', 'clerk'));

grant select, insert, update, delete
  on public.attendance, public.shifts, public.shift_requests, public.daily_reports
  to authenticated;

-- ============================================================
-- アプリ向けビュー(uuid を出さず、安定コードで返す)
-- ============================================================

create or replace view public.v_app_attendance
  with (security_invoker = true) as
select
  a.app_id            as id,
  m.employee_no       as staff_id,
  st.code             as store_id,
  a.work_date         as date,
  a.shift_type,
  a.clock_in,
  a.clock_out,
  a.break_min,
  a.status,
  a.gps_ok,
  a.approved,
  am.employee_no      as approved_by,
  a.approved_at,
  a.note
from public.attendance a
join public.members m on m.id = a.member_id
left join public.stores  st on st.id = a.store_id
left join public.members am on am.id = a.approved_by;

create or replace view public.v_app_shifts
  with (security_invoker = true) as
select
  s.app_id       as id,
  m.employee_no  as staff_id,
  st.code        as store_id,
  s.work_date    as date,
  s.shift_type   as type,
  s.note
from public.shifts s
join public.members m on m.id = s.member_id
left join public.stores st on st.id = s.store_id;

create or replace view public.v_app_shift_requests
  with (security_invoker = true) as
select
  r.app_id       as id,
  m.employee_no  as staff_id,
  r.target_month as month,
  r.wishes,
  r.reasons,
  r.note,
  r.submitted_at
from public.shift_requests r
join public.members m on m.id = r.member_id;

create or replace view public.v_app_daily_reports
  with (security_invoker = true) as
select
  d.app_id       as id,
  m.employee_no  as staff_id,
  st.code        as store_id,
  d.report_date  as date,
  d.revenue,
  d.treatments,
  d.new_patients,
  d.proposals,
  d.contracts,
  d.goods,
  d.comment,
  d.ai_summary,
  d.status
from public.daily_reports d
join public.members m on m.id = d.member_id
left join public.stores st on st.id = d.store_id;

comment on view public.v_app_attendance     is '勤怠(アプリ用。社員番号・店舗コードで返す)';
comment on view public.v_app_shifts         is 'シフト(アプリ用)';
comment on view public.v_app_shift_requests is '希望休(アプリ用)';
comment on view public.v_app_daily_reports  is '日報(アプリ用)';

grant select on
  public.v_app_attendance, public.v_app_shifts,
  public.v_app_shift_requests, public.v_app_daily_reports
  to authenticated;

-- ============================================================
-- 書き込みの入口
--   アプリは社員番号・店舗コードしか持っていないので、
--   uuid への読み替えをサーバー側で引き受ける。
--   ビューに INSTEAD OF トリガを置き、PostgREST から
--   ビューへ upsert / update できるようにする。
-- ============================================================

create or replace function app.member_id_of(p_employee_no text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_catalog
as $$ select id from public.members where employee_no = p_employee_no; $$;

create or replace function app.store_id_of(p_code text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_catalog
as $$ select id from public.stores where code = p_code; $$;

-- ---------------- 勤怠 ----------------
create or replace function app.write_app_attendance()
returns trigger
language plpgsql
security invoker            -- RLS を効かせたまま書く(迂回させない)
set search_path = public, pg_catalog
as $$
declare v_member uuid; v_store uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.attendance where app_id = old.id;
    return old;
  end if;

  v_member := app.member_id_of(new.staff_id);
  v_store  := app.store_id_of(new.store_id);
  if v_member is null then
    raise exception '社員番号 % のメンバーが見つかりません', new.staff_id using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'UPDATE' then
    update public.attendance set
      store_id    = coalesce(v_store, store_id),
      shift_type  = coalesce(new.shift_type, shift_type),
      clock_in    = new.clock_in,
      clock_out   = new.clock_out,
      break_min   = coalesce(new.break_min, 0),
      status      = coalesce(new.status, 'normal'),
      gps_ok      = coalesce(new.gps_ok, true),
      note        = new.note,
      approved    = coalesce(new.approved, false),
      approved_by = case when coalesce(new.approved, false) and not approved
                         then app.current_member_id() else approved_by end,
      approved_at = case when coalesce(new.approved, false) and not approved
                         then now() else approved_at end
    where app_id = old.id;
    return new;
  end if;

  insert into public.attendance as a (
    app_id, member_id, store_id, work_date, shift_type,
    clock_in, clock_out, break_min, status, gps_ok, approved, note
  ) values (
    new.id, v_member, v_store, new.date, new.shift_type,
    new.clock_in, new.clock_out, coalesce(new.break_min, 0), coalesce(new.status, 'normal'),
    coalesce(new.gps_ok, true), coalesce(new.approved, false), new.note
  )
  on conflict (app_id) do update set
    store_id   = coalesce(excluded.store_id, a.store_id),
    shift_type = coalesce(excluded.shift_type, a.shift_type),
    clock_in   = excluded.clock_in,
    clock_out  = excluded.clock_out,
    break_min  = excluded.break_min,
    status     = excluded.status,
    gps_ok     = excluded.gps_ok,
    approved   = excluded.approved,
    note       = excluded.note,
    approved_by = case when excluded.approved and not a.approved
                       then app.current_member_id() else a.approved_by end,
    approved_at = case when excluded.approved and not a.approved
                       then now() else a.approved_at end;
  return new;
end;
$$;

drop trigger if exists v_app_attendance_write on public.v_app_attendance;
create trigger v_app_attendance_write
  instead of insert or update or delete on public.v_app_attendance
  for each row execute function app.write_app_attendance();

-- ---------------- シフト ----------------
create or replace function app.write_app_shifts()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare v_member uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.shifts where app_id = old.id;
    return old;
  end if;
  v_member := app.member_id_of(new.staff_id);
  if v_member is null then
    raise exception '社員番号 % のメンバーが見つかりません', new.staff_id using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'UPDATE' then
    update public.shifts set
      store_id   = coalesce(app.store_id_of(new.store_id), store_id),
      shift_type = coalesce(new.type, shift_type),
      note       = new.note
    where app_id = old.id;
    return new;
  end if;

  insert into public.shifts as s (app_id, member_id, store_id, work_date, shift_type, note)
  values (new.id, v_member, app.store_id_of(new.store_id), new.date, coalesce(new.type, 'full'), new.note)
  on conflict (app_id) do update set
    store_id   = coalesce(excluded.store_id, s.store_id),
    shift_type = excluded.shift_type,
    note       = excluded.note;
  return new;
end;
$$;

drop trigger if exists v_app_shifts_write on public.v_app_shifts;
create trigger v_app_shifts_write
  instead of insert or update or delete on public.v_app_shifts
  for each row execute function app.write_app_shifts();

-- ---------------- 希望休 ----------------
create or replace function app.write_app_shift_requests()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare v_member uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.shift_requests where app_id = old.id;
    return old;
  end if;
  v_member := app.member_id_of(new.staff_id);
  if v_member is null then
    raise exception '社員番号 % のメンバーが見つかりません', new.staff_id using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'UPDATE' then
    update public.shift_requests set
      wishes       = coalesce(new.wishes, '{}'::jsonb),
      reasons      = coalesce(new.reasons, '{}'::jsonb),
      note         = new.note,
      submitted_at = coalesce(new.submitted_at, submitted_at)
    where app_id = old.id;
    return new;
  end if;

  insert into public.shift_requests as r (app_id, member_id, target_month, wishes, reasons, note, submitted_at)
  values (new.id, v_member, new.month,
          coalesce(new.wishes, '{}'::jsonb), coalesce(new.reasons, '{}'::jsonb),
          new.note, coalesce(new.submitted_at, now()))
  on conflict (app_id) do update set
    wishes       = excluded.wishes,
    reasons      = excluded.reasons,
    note         = excluded.note,
    submitted_at = excluded.submitted_at;
  return new;
end;
$$;

drop trigger if exists v_app_shift_requests_write on public.v_app_shift_requests;
create trigger v_app_shift_requests_write
  instead of insert or update or delete on public.v_app_shift_requests
  for each row execute function app.write_app_shift_requests();

-- ---------------- 日報 ----------------
create or replace function app.write_app_daily_reports()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare v_member uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.daily_reports where app_id = old.id;
    return old;
  end if;
  v_member := app.member_id_of(new.staff_id);
  if v_member is null then
    raise exception '社員番号 % のメンバーが見つかりません', new.staff_id using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'UPDATE' then
    update public.daily_reports set
      store_id     = coalesce(app.store_id_of(new.store_id), store_id),
      revenue      = coalesce(new.revenue, 0),
      treatments   = coalesce(new.treatments, 0),
      new_patients = coalesce(new.new_patients, 0),
      proposals    = coalesce(new.proposals, 0),
      contracts    = coalesce(new.contracts, 0),
      goods        = coalesce(new.goods, 0),
      comment      = new.comment,
      ai_summary   = new.ai_summary,
      status       = coalesce(new.status, 'draft')
    where app_id = old.id;
    return new;
  end if;

  insert into public.daily_reports as d (
    app_id, member_id, store_id, report_date,
    revenue, treatments, new_patients, proposals, contracts, goods,
    comment, ai_summary, status
  ) values (
    new.id, v_member, app.store_id_of(new.store_id), new.date,
    coalesce(new.revenue, 0), coalesce(new.treatments, 0), coalesce(new.new_patients, 0),
    coalesce(new.proposals, 0), coalesce(new.contracts, 0), coalesce(new.goods, 0),
    new.comment, new.ai_summary, coalesce(new.status, 'draft')
  )
  on conflict (app_id) do update set
    store_id     = coalesce(excluded.store_id, d.store_id),
    revenue      = excluded.revenue,
    treatments   = excluded.treatments,
    new_patients = excluded.new_patients,
    proposals    = excluded.proposals,
    contracts    = excluded.contracts,
    goods        = excluded.goods,
    comment      = excluded.comment,
    ai_summary   = excluded.ai_summary,
    status       = excluded.status;
  return new;
end;
$$;

drop trigger if exists v_app_daily_reports_write on public.v_app_daily_reports;
create trigger v_app_daily_reports_write
  instead of insert or update or delete on public.v_app_daily_reports
  for each row execute function app.write_app_daily_reports();

grant insert, update, delete on
  public.v_app_attendance, public.v_app_shifts,
  public.v_app_shift_requests, public.v_app_daily_reports
  to authenticated;
