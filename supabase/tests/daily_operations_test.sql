-- ============================================================
-- くまのみ 統合ポータル — 毎日の業務(勤怠・シフト・希望休・日報)の回帰テスト
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/daily_operations_test.sql
--
-- 0001〜0007 を適用済みのDBで実行する。最後に rollback するのでデータは残らない。
-- 実在の店舗・氏名とぶつからないテスト用の名前を使うので、
-- すでに本番データが入っているDBに対しても流せる。
--
-- 見たいのは 2 点。
--   1. アプリ用ビュー(v_app_*)への書き込みが、社員番号 → uuid に正しく解決されること
--   2. RLS が js/auth.js と同じ範囲になっていること
--      (事務は勤怠が全社で見えるが日報は見えない、など)
-- ============================================================

\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.check(p_label text, p_actual anyelement, p_expected anyelement)
returns void
language plpgsql
as $fn$
begin
  if p_actual is distinct from p_expected then
    raise exception 'NG % : 期待 <%> / 実際 <%>', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok  %', p_label;
end;
$fn$;

-- ログイン中の人を差し替える(auth.uid() が読む値を書き換える)
create or replace function pg_temp.login_as(p_employee_no text)
returns void
language plpgsql
-- authenticated に切り替えたあとでも名簿を引けるように security definer にする。
-- ※ SET 句は付けないこと。SET 句のある関数は「中で行った設定変更を抜けるとき戻す」
--   ため、肝心の set_config('request.jwt.claim.sub') が消えてしまう。
security definer
as $fn$
declare v_uid uuid;
begin
  select auth_user_id into v_uid from public.members where employee_no = p_employee_no;
  if v_uid is null then raise exception 'テスト設定の誤り:% に auth ユーザーがいません', p_employee_no; end if;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end;
$fn$;

-- ------------------------------------------------------------
-- 0) 下ごしらえ:2店舗・5人・ログインアカウント
-- ------------------------------------------------------------
insert into public.stores (code, name, short_name, category, dept_code, beds)
values ('zz-test-a', 'テスト朝日院', 'テA', '整骨院', '91', 3),
       ('zz-test-b', 'テスト夕陽院', 'テB', '整体院', '92', 2);

-- 社長 → 院長A → スタッフA / メンターA、院長B、本部人事、事務
insert into public.members (name_key, employee_no, full_name, rank, role_title, primary_store_id, department)
select v.name_key, v.emp, v.nm, v.rk::public.member_rank, v.title,
       (select id from public.stores where code = v.store), 'seitai'
  from (values
    ('テスト社長',     'ZZ001', 'テスト 社長',   'ceo',     '社長',   'zz-test-a'),
    ('テスト院長A',    'ZZ002', 'テスト 院長A',  'manager', '院長',   'zz-test-a'),
    ('テストスタッフA','ZZ003', 'テスト スタッフA','staff',  'スタッフ','zz-test-a'),
    ('テスト院長B',    'ZZ004', 'テスト 院長B',  'manager', '院長',   'zz-test-b'),
    ('テスト人事',     'ZZ005', 'テスト 人事',   'hr',      '本部人事','zz-test-a'),
    ('テスト事務',     'ZZ006', 'テスト 事務',   'clerk',   '事務職員','zz-test-a')
  ) as v(name_key, emp, nm, rk, title, store);

update public.members set reports_to_id = (select id from public.members where employee_no = 'ZZ001')
 where employee_no in ('ZZ002', 'ZZ004', 'ZZ005', 'ZZ006');
update public.members set reports_to_id = (select id from public.members where employee_no = 'ZZ002')
 where employee_no = 'ZZ003';

-- 院長は自店舗の責任者(app.managed_store_ids がこれを見る)
update public.stores set director_id = (select id from public.members where employee_no = 'ZZ002')
 where code = 'zz-test-a';
update public.stores set director_id = (select id from public.members where employee_no = 'ZZ004')
 where code = 'zz-test-b';

insert into auth.users (email)
select 'zz' || employee_no || '@test.invalid' from public.members where employee_no like 'ZZ%';
update public.members m
   set auth_user_id = u.id
  from auth.users u
 where u.email = 'zz' || m.employee_no || '@test.invalid';

-- ------------------------------------------------------------
-- 1) 事務職員ランクが SQL 側にも入っているか
-- ------------------------------------------------------------
select pg_temp.check('clerk が enum にある',
  exists(select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
          where t.typname = 'member_rank' and e.enumlabel = 'clerk'), true);
select pg_temp.check('clerk のランク名', app.rank_label('clerk'), '事務職員');
select pg_temp.check('clerk のランク強度', app.rank_level('clerk'), 1);
select pg_temp.check('hr のランク強度は据え置き', app.rank_level('hr'), 3);

-- ------------------------------------------------------------
-- 2) 安定コードのビュー(0006)
-- ------------------------------------------------------------
select pg_temp.check('名簿ビューに店舗コードが出る',
  (select store_code from public.v_member_directory where employee_no = 'ZZ003'), 'zz-test-a');
select pg_temp.check('名簿ビューに上司の社員番号が出る',
  (select manager_employee_no from public.v_member_directory where employee_no = 'ZZ003'), 'ZZ002');
select pg_temp.check('店舗ビューは所属コードを返す',
  (select dept_code from public.v_app_stores where code = 'zz-test-a'), '91');

-- 社員番号の一括採番(既存の番号は触らない)
insert into public.members (name_key, full_name, rank, role_title)
values ('テスト未採番', 'テスト 未採番', 'staff', 'スタッフ');
select pg_temp.check('採番前は空',
  (select employee_no from public.members where name_key = 'テスト未採番'), null::text);

set local role postgres;
do $blk$
declare v_res jsonb;
begin
  perform set_config('request.jwt.claim.sub',
    (select auth_user_id::text from public.members where employee_no = 'ZZ001'), true);
  v_res := public.fill_employee_numbers('ZT', 3);
  if (v_res ->> 'filled')::int < 1 then raise exception 'NG 採番されなかった: %', v_res; end if;
  raise notice 'ok  未採番のメンバーに社員番号が振られる(%)', v_res ->> 'filled';
end $blk$;
select pg_temp.check('既存の社員番号は書き換えられない',
  (select employee_no from public.members where name_key = 'テストスタッフA'), 'ZZ003');

-- ------------------------------------------------------------
-- 3) アプリ用ビューへの書き込み(社員番号 → uuid の解決)
-- ------------------------------------------------------------
set local role authenticated;
select pg_temp.login_as('ZZ003');   -- スタッフAとして打刻する

insert into public.v_app_attendance (id, staff_id, store_id, date, shift_type, clock_in, clock_out, break_min, status, gps_ok, approved)
values ('zz-at-1', 'ZZ003', 'zz-test-a', current_date, 'full', '09:55', '19:30', 60, 'normal', true, false);

select pg_temp.check('打刻が uuid に解決されて入る',
  (select m.employee_no from public.attendance a join public.members m on m.id = a.member_id
    where a.app_id = 'zz-at-1'), 'ZZ003');
select pg_temp.check('店舗コードも解決される',
  (select s.code from public.attendance a join public.stores s on s.id = a.store_id
    where a.app_id = 'zz-at-1'), 'zz-test-a');

-- 同じ app_id で送り直すと上書き(sync.js の再送で二重に増えない)
insert into public.v_app_attendance (id, staff_id, store_id, date, shift_type, clock_in, clock_out, break_min, status, gps_ok, approved)
values ('zz-at-1', 'ZZ003', 'zz-test-a', current_date, 'full', '09:55', '20:10', 60, 'normal', true, false);
select pg_temp.check('同じ id の再送は1行のまま',
  (select count(*) from public.attendance where app_id = 'zz-at-1'), 1::bigint);
select pg_temp.check('再送で退勤時刻が更新される',
  (select clock_out from public.attendance where app_id = 'zz-at-1'), '20:10'::time);

insert into public.v_app_daily_reports (id, staff_id, store_id, date, revenue, treatments, new_patients, proposals, contracts, goods, comment, status)
values ('zz-dr-1', 'ZZ003', 'zz-test-a', current_date, 48000, 7, 1, 1, 1, 0, 'テストの所感', 'submitted');
select pg_temp.check('日報が入る',
  (select revenue from public.daily_reports where app_id = 'zz-dr-1'), 48000);

insert into public.v_app_shift_requests (id, staff_id, month, wishes, reasons, note)
values ('zz-sr-1', 'ZZ003', to_char(current_date + interval '1 month', 'YYYY-MM'),
        jsonb_build_object(to_char(current_date + interval '1 month', 'YYYY-MM') || '-05', 'off'),
        jsonb_build_object(to_char(current_date + interval '1 month', 'YYYY-MM') || '-05', '通院のため'),
        null);
select pg_temp.check('希望休の理由が保たれる',
  (select reasons ->> (to_char(current_date + interval '1 month', 'YYYY-MM') || '-05')
     from public.shift_requests where app_id = 'zz-sr-1'), '通院のため');
select pg_temp.check('理由なしの希望休も出せる',
  (select jsonb_typeof(reasons) from public.shift_requests where app_id = 'zz-sr-1'), 'object');

-- 存在しない社員番号は弾く(黙って別人の行にしない)
do $blk$ begin
  insert into public.v_app_attendance (id, staff_id, store_id, date)
  values ('zz-at-bad', 'NOPE', 'zz-test-a', current_date);
  raise exception 'NG 存在しない社員番号が通ってしまった';
exception when foreign_key_violation then raise notice 'ok  存在しない社員番号は弾かれる';
end $blk$;

-- ------------------------------------------------------------
-- 4) 勤怠の RLS
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ003');
select pg_temp.check('本人は自分の打刻が見える',
  (select count(*) from public.v_app_attendance where id = 'zz-at-1'), 1::bigint);

select pg_temp.login_as('ZZ002');   -- 同じ店の院長
select pg_temp.check('院長は配下の打刻が見える',
  (select count(*) from public.v_app_attendance where id = 'zz-at-1'), 1::bigint);

select pg_temp.login_as('ZZ004');   -- よその店の院長
select pg_temp.check('よその院長には見えない',
  (select count(*) from public.v_app_attendance where id = 'zz-at-1'), 0::bigint);

select pg_temp.login_as('ZZ005');   -- 本部人事
select pg_temp.check('人事は全社の打刻が見える',
  (select count(*) from public.v_app_attendance where id = 'zz-at-1'), 1::bigint);

select pg_temp.login_as('ZZ006');   -- 事務職員(給与の最終確認)
select pg_temp.check('事務は全社の打刻が見える',
  (select count(*) from public.v_app_attendance where id = 'zz-at-1'), 1::bigint);

-- 承認はアプリと同じ経路(ビュー越しの UPDATE)で行う。
-- 実テーブルへの直接 UPDATE と違い、INSTEAD OF トリガを通るため
-- ここが通らないと画面から承認できない。
select pg_temp.login_as('ZZ002');
update public.v_app_attendance set approved = true where id = 'zz-at-1';
select pg_temp.check('院長はビュー越しに打刻を承認できる',
  (select approved from public.attendance where app_id = 'zz-at-1'), true);
select pg_temp.check('承認者が記録される',
  (select am.employee_no from public.attendance a
     join public.members am on am.id = a.approved_by where a.app_id = 'zz-at-1'), 'ZZ002');

-- 管轄外の院長はビュー越しでも承認できない
select pg_temp.login_as('ZZ004');
do $blk$
declare n integer;
begin
  update public.v_app_attendance set approved = true where id = 'zz-at-1';
  get diagnostics n = row_count;
  if n > 0 then raise exception 'NG 管轄外の院長が承認できてしまった'; end if;
  raise notice 'ok  管轄外の院長は承認できない';
end $blk$;

select pg_temp.login_as('ZZ003');
do $blk$
declare n integer;
begin
  update public.attendance set clock_out = '23:59' where app_id = 'zz-at-1';
  get diagnostics n = row_count;
  if n > 0 then raise exception 'NG 承認済みの打刻を本人が書き換えられた'; end if;
  raise notice 'ok  承認済みの打刻は本人でも書き換えられない';
end $blk$;

-- ------------------------------------------------------------
-- 5) 日報の RLS(人事・事務は対象外)
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ003');
select pg_temp.check('本人は自分の日報が見える',
  (select count(*) from public.v_app_daily_reports where id = 'zz-dr-1'), 1::bigint);

select pg_temp.login_as('ZZ002');
select pg_temp.check('院長は配下の日報が見える',
  (select count(*) from public.v_app_daily_reports where id = 'zz-dr-1'), 1::bigint);

select pg_temp.login_as('ZZ005');
select pg_temp.check('人事に日報は見えない',
  (select count(*) from public.v_app_daily_reports where id = 'zz-dr-1'), 0::bigint);

select pg_temp.login_as('ZZ006');
select pg_temp.check('事務に日報は見えない',
  (select count(*) from public.v_app_daily_reports where id = 'zz-dr-1'), 0::bigint);

select pg_temp.login_as('ZZ004');
select pg_temp.check('よその院長に日報は見えない',
  (select count(*) from public.v_app_daily_reports where id = 'zz-dr-1'), 0::bigint);

-- 他人の日報は書けない
select pg_temp.login_as('ZZ002');
do $blk$
declare n integer;
begin
  update public.daily_reports set comment = '院長が書き換え' where app_id = 'zz-dr-1';
  get diagnostics n = row_count;
  if n > 0 then raise exception 'NG 他人の日報を書き換えられた'; end if;
  raise notice 'ok  他人の日報は書き換えられない';
end $blk$;

-- ------------------------------------------------------------
-- 6) 希望休の RLS
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ002');
select pg_temp.check('院長は配下の希望休が見える(理由つき)',
  (select count(*) from public.v_app_shift_requests where id = 'zz-sr-1'), 1::bigint);

select pg_temp.login_as('ZZ004');
select pg_temp.check('よその院長に希望休は見えない',
  (select count(*) from public.v_app_shift_requests where id = 'zz-sr-1'), 0::bigint);

select pg_temp.login_as('ZZ002');
do $blk$
declare n integer;
begin
  update public.shift_requests set note = '院長が書き換え' where app_id = 'zz-sr-1';
  get diagnostics n = row_count;
  if n > 0 then raise exception 'NG 他人の希望休を書き換えられた'; end if;
  raise notice 'ok  希望休を書けるのは本人だけ';
end $blk$;

-- ------------------------------------------------------------
-- 7) シフトの RLS(閲覧は全社員・編集は管轄のみ)
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ002');
insert into public.v_app_shifts (id, staff_id, store_id, date, type)
values ('zz-sh-1', 'ZZ003', 'zz-test-a', current_date + 1, 'early');
select pg_temp.check('院長は自店舗のシフトを組める',
  (select shift_type from public.shifts where app_id = 'zz-sh-1'), 'early');

select pg_temp.login_as('ZZ004');
select pg_temp.check('シフトは全社員が閲覧できる',
  (select count(*) from public.v_app_shifts where id = 'zz-sh-1'), 1::bigint);
do $blk$
declare n integer;
begin
  update public.shifts set shift_type = 'late' where app_id = 'zz-sh-1';
  get diagnostics n = row_count;
  if n > 0 then raise exception 'NG 管轄外のシフトを書き換えられた'; end if;
  raise notice 'ok  管轄外のシフトは編集できない';
end $blk$;

select pg_temp.login_as('ZZ005');   -- 本部人事はシフトを組まない
do $blk$
declare n integer;
begin
  update public.shifts set shift_type = 'late' where app_id = 'zz-sh-1';
  get diagnostics n = row_count;
  if n > 0 then raise exception 'NG 人事がシフトを書き換えられた'; end if;
  raise notice 'ok  本部人事はシフトを編集しない(js/auth.js と同じ)';
end $blk$;

-- ------------------------------------------------------------
-- 8) 1人1日1件(二重打刻・二重日報を作らない)
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ003');
do $blk$ begin
  insert into public.v_app_attendance (id, staff_id, store_id, date)
  values ('zz-at-dup', 'ZZ003', 'zz-test-a', current_date);
  raise exception 'NG 同じ日に2件目の打刻が入った';
exception when unique_violation then raise notice 'ok  同じ日に打刻は1件だけ';
end $blk$;

-- ------------------------------------------------------------

do $blk$ begin raise notice '----------------------------------------'; end $blk$;
do $blk$ begin raise notice 'すべて成功しました'; end $blk$;

rollback;   -- テストデータは残さない
