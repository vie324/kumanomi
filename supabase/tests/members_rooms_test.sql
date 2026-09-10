-- ============================================================
-- くまのみ 統合ポータル — メンバーの手入力と自動チャットルーム(0010)の回帰テスト
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/members_rooms_test.sql
--
-- 見たいのは次の点。
--   1. マネージャー以上と本部人事は v_app_members 越しにメンバーを足せる。院長・統括院長は足せない
--   2. 本人は自分のランク・所属・上司を書き換えられない(プロフィールは直せる)
--   3. 店舗・委員会・全社のルームが自動で作られ、所属に応じて参加者が決まる
--   4. 異動すると旧店舗のルームから外れ、新店舗のルームに入る。退職すると全ルームから外れる
--   5. 自動ルームの参加者は画面から変えられない
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

create or replace function pg_temp.login_as(p_employee_no text)
returns void
language plpgsql
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

/** テスト中に足したメンバーにログインアカウントを付ける */
create or replace function pg_temp.make_login(p_employee_no text)
returns void
language plpgsql
security definer
as $fn$
declare v_uid uuid;
begin
  insert into auth.users (email) values ('zz' || p_employee_no || '@test.invalid') returning id into v_uid;
  update public.members set auth_user_id = v_uid where employee_no = p_employee_no;
end;
$fn$;

/** 自動ルームがあるか(RLS を通さずに数える) */
create or replace function pg_temp.room_exists(p_auto_key text)
returns boolean
language sql
security definer
as $fn$ select exists (select 1 from public.chat_rooms where auto_key = p_auto_key); $fn$;

/** ルームの参加者にその社員番号が入っているか */
create or replace function pg_temp.in_room(p_room text, p_no text)
returns boolean
language sql
security definer
as $fn$ select coalesce((select p_no = any (member_nos) from public.chat_rooms where app_id = p_room), false); $fn$;

-- ------------------------------------------------------------
-- 0) 下ごしらえ:2店舗・委員会1つ・社長 / マネージャー / 統括院長 / 院長 / スタッフ / 人事
-- ------------------------------------------------------------
insert into public.stores (code, name, short_name, category, dept_code, beds)
values ('zz-test-a', 'テスト朝日院', 'テA', '整骨院', '91', 3),
       ('zz-test-b', 'テスト夕陽院', 'テB', '整体院', '92', 2);

insert into public.committees (code, name, icon, description)
values ('zz-eisei', 'テスト衛生委員会', '🧼', '院内の衛生');

insert into public.members (name_key, employee_no, full_name, rank, role_title, primary_store_id, department)
select v.name_key, v.emp, v.nm, v.rk::public.member_rank, v.title,
       (select id from public.stores where code = v.store), 'seitai'
  from (values
    ('テスト社長',     'ZZ001', 'テスト 社長',   'ceo',     '社長',      'zz-test-a'),
    ('テスト院長A',    'ZZ002', 'テスト 院長A',  'manager', '院長',      'zz-test-a'),
    ('テストスタッフA','ZZ003', 'テスト スタッフA','staff',  'スタッフ',   'zz-test-a'),
    ('テスト院長B',    'ZZ004', 'テスト 院長B',  'manager', '院長',      'zz-test-b'),
    ('テスト人事',     'ZZ005', 'テスト 人事',   'hr',      '本部人事',   'zz-test-a'),
    ('テストMG',       'ZZ007', 'テスト MG',     'area',    'マネージャー','zz-test-a'),
    ('テスト統括院長', 'ZZ008', 'テスト 統括院長','chief',  '統括院長',   'zz-test-a')
  ) as v(name_key, emp, nm, rk, title, store);

update public.members set reports_to_id = (select id from public.members where employee_no = 'ZZ001')
 where employee_no in ('ZZ005', 'ZZ007');
update public.members set reports_to_id = (select id from public.members where employee_no = 'ZZ007')
 where employee_no = 'ZZ008';
update public.members set reports_to_id = (select id from public.members where employee_no = 'ZZ008')
 where employee_no in ('ZZ002', 'ZZ004');
update public.members set reports_to_id = (select id from public.members where employee_no = 'ZZ002')
 where employee_no = 'ZZ003';

insert into auth.users (email)
select 'zz' || employee_no || '@test.invalid' from public.members where employee_no like 'ZZ%';
update public.members m
   set auth_user_id = u.id
  from auth.users u
 where u.email = 'zz' || m.employee_no || '@test.invalid';

-- ------------------------------------------------------------
-- 1) 自動ルームがそろっている(トリガが上の INSERT で走っている)
-- ------------------------------------------------------------
select pg_temp.check('全社ルームがある',
  (select auto_key from public.chat_rooms where app_id = 'cr-all'), 'all');
select pg_temp.check('店舗ルームが店舗ごとにある',
  (select count(*) from public.chat_rooms where auto_key in ('store:zz-test-a', 'store:zz-test-b')), 2::bigint);
select pg_temp.check('委員会ルームがある',
  (select kind from public.chat_rooms where auto_key = 'committee:zz-eisei'), 'committee');
select pg_temp.check('全社ルームに全員いる', pg_temp.in_room('cr-all', 'ZZ003') and pg_temp.in_room('cr-all', 'ZZ004'), true);
select pg_temp.check('店舗ルームは所属の人だけ',
  pg_temp.in_room('cr-store-zz-test-a', 'ZZ003') and not pg_temp.in_room('cr-store-zz-test-b', 'ZZ003'), true);

-- ------------------------------------------------------------
-- 2) メンバーの手入力追加(誰ができるか)
-- ------------------------------------------------------------
set local role authenticated;

select pg_temp.login_as('ZZ002');   -- 院長
do $blk$ begin
  insert into public.v_app_members (employee_no, full_name, rank, role_title, primary_store_code)
  values ('ZZ101', 'テスト 新人', 'staff', 'スタッフ', 'zz-test-a');
  raise exception 'NG 院長がメンバーを追加できてしまった';
exception when insufficient_privilege then raise notice 'ok  院長はメンバーを追加できない';
end $blk$;

select pg_temp.login_as('ZZ008');   -- 統括院長
do $blk$ begin
  insert into public.v_app_members (employee_no, full_name, rank, role_title, primary_store_code)
  values ('ZZ101', 'テスト 新人', 'staff', 'スタッフ', 'zz-test-a');
  raise exception 'NG 統括院長がメンバーを追加できてしまった';
exception when insufficient_privilege then raise notice 'ok  統括院長はメンバーを追加できない';
end $blk$;

select pg_temp.login_as('ZZ007');   -- マネージャー(統括院長より上)
insert into public.v_app_members (employee_no, full_name, kana, rank, role_title, primary_store_code,
  manager_employee_no, joined_on, committee_codes)
values ('ZZ101', 'テスト 新人', 'てすと しんじん', 'staff', 'スタッフ', 'zz-test-a', 'ZZ002', current_date, '{zz-eisei}');
select pg_temp.check('マネージャーはメンバーを追加できる',
  (select full_name from public.members where employee_no = 'ZZ101'), 'テスト 新人');
select pg_temp.check('取込キー(name_key)が氏名から作られる',
  (select name_key from public.members where employee_no = 'ZZ101'), 'テスト新人');
select pg_temp.check('上司が社員番号から解決される',
  (select manager_employee_no from public.v_app_members where employee_no = 'ZZ101'), 'ZZ002');
select pg_temp.check('名簿ビューに委員会が出る',
  (select committee_codes from public.v_member_directory where employee_no = 'ZZ101'), array['zz-eisei']);

-- 同姓同名は社員番号を付けて区別する(取込キーがぶつからない)
select pg_temp.login_as('ZZ005');   -- 本部人事
insert into public.v_app_members (employee_no, full_name, rank, role_title, primary_store_code)
values ('ZZ102', 'テスト 新人', 'staff', 'スタッフ', 'zz-test-b');
select pg_temp.check('本部人事もメンバーを追加できる(同姓同名も可)',
  (select name_key from public.members where employee_no = 'ZZ102'), 'テスト新人@ZZ102');

-- 存在しない店舗コードは弾く
do $blk$ begin
  insert into public.v_app_members (employee_no, full_name, primary_store_code) values ('ZZ103', 'テスト 誤り', 'nope');
  raise exception 'NG 存在しない店舗コードが通った';
exception when foreign_key_violation then raise notice 'ok  存在しない店舗コードは弾かれる';
end $blk$;

-- ------------------------------------------------------------
-- 3) 新人が所属のルームに自動で入る
-- ------------------------------------------------------------
select pg_temp.check('新人が全社ルームに入る', pg_temp.in_room('cr-all', 'ZZ101'), true);
select pg_temp.check('新人が配属店舗のルームに入る', pg_temp.in_room('cr-store-zz-test-a', 'ZZ101'), true);
select pg_temp.check('新人が任命された委員会のルームに入る', pg_temp.in_room('cr-committee-zz-eisei', 'ZZ101'), true);
select pg_temp.check('別店舗のルームには入らない', pg_temp.in_room('cr-store-zz-test-b', 'ZZ101'), false);

-- 新人自身にはそのルームが見える(RLS)
select pg_temp.make_login('ZZ101');
select pg_temp.login_as('ZZ101');
select pg_temp.check('新人から店舗ルームと委員会ルームが見える',
  (select count(*) from public.v_app_chat_rooms where id in ('cr-store-zz-test-a', 'cr-committee-zz-eisei', 'cr-all')), 3::bigint);
select pg_temp.check('ルームに自動の印(auto_key)が出る',
  (select auto_key from public.v_app_chat_rooms where id = 'cr-store-zz-test-a'), 'store:zz-test-a');

-- ------------------------------------------------------------
-- 4) 異動:朝日院 → 夕陽院(追加所属で朝日院にも残る場合も)
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ007');
update public.v_app_members set primary_store_code = 'zz-test-b' where employee_no = 'ZZ101';
select pg_temp.check('異動で旧店舗のルームから外れる', pg_temp.in_room('cr-store-zz-test-a', 'ZZ101'), false);
select pg_temp.check('異動で新店舗のルームに入る', pg_temp.in_room('cr-store-zz-test-b', 'ZZ101'), true);
select pg_temp.check('全社ルームには残る', pg_temp.in_room('cr-all', 'ZZ101'), true);
select pg_temp.check('委員会ルームにも残る', pg_temp.in_room('cr-committee-zz-eisei', 'ZZ101'), true);

update public.v_app_members set store_codes = '{zz-test-a}' where employee_no = 'ZZ101';
select pg_temp.check('追加所属にすると両方の店舗ルームに入る',
  pg_temp.in_room('cr-store-zz-test-a', 'ZZ101') and pg_temp.in_room('cr-store-zz-test-b', 'ZZ101'), true);

update public.v_app_members set committee_codes = '{}' where employee_no = 'ZZ101';
select pg_temp.check('委員会を外すとルームからも外れる', pg_temp.in_room('cr-committee-zz-eisei', 'ZZ101'), false);

-- 異動した本人からは旧店舗のルームが見えなくなる
select pg_temp.login_as('ZZ101');
update public.v_app_members set store_codes = '{}' where employee_no = 'ZZ101';  -- 本人は変えられない(下で確認)
select pg_temp.login_as('ZZ007');
update public.v_app_members set store_codes = '{}' where employee_no = 'ZZ101';
select pg_temp.login_as('ZZ101');
select pg_temp.check('異動した本人から旧店舗のルームは見えない',
  (select count(*) from public.v_app_chat_rooms where id = 'cr-store-zz-test-a'), 0::bigint);

-- ------------------------------------------------------------
-- 5) 本人はプロフィールしか直せない
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ003');
update public.v_app_members set kana = 'てすと すたっふ', rank = 'ceo', primary_store_code = 'zz-test-b',
  manager_employee_no = 'ZZ001', committee_codes = '{zz-eisei}'
 where employee_no = 'ZZ003';
select pg_temp.check('本人はかなを直せる',
  (select kana from public.members where employee_no = 'ZZ003'), 'てすと すたっふ');
select pg_temp.check('本人は自分のランクを変えられない',
  (select rank::text from public.members where employee_no = 'ZZ003'), 'staff');
select pg_temp.check('本人は自分の所属を変えられない',
  (select primary_store_code from public.v_app_members where employee_no = 'ZZ003'), 'zz-test-a');
select pg_temp.check('本人は自分の上司を変えられない',
  (select manager_employee_no from public.v_app_members where employee_no = 'ZZ003'), 'ZZ002');
select pg_temp.check('本人は委員会に自分を任命できない',
  (select committee_codes from public.members where employee_no = 'ZZ003'), '{}'::text[]);

-- 他人の行は書けない(黙って無視ではなく、はっきり断られる)
do $blk$ begin
  update public.v_app_members set kana = 'x' where employee_no = 'ZZ004';
  raise exception 'NG スタッフが他人の名簿を書き換えられた';
exception when insufficient_privilege then raise notice 'ok  スタッフは他人の名簿を書き換えられない';
end $blk$;
select pg_temp.check('他人のかなは変わっていない',
  (select kana from public.members where employee_no = 'ZZ004'), null::text);

-- ------------------------------------------------------------
-- 6) 自動ルームの参加者は画面から変えられない
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ002');   -- 朝日院の院長(ルームの参加者)
update public.v_app_chat_rooms set member_ids = array['ZZ002'] where id = 'cr-store-zz-test-a';
select pg_temp.check('自動ルームの参加者を手で減らせない',
  pg_temp.in_room('cr-store-zz-test-a', 'ZZ003'), true);
update public.v_app_chat_rooms set icon = '🏥' where id = 'cr-store-zz-test-a';
select pg_temp.check('自動ルームでもアイコンは変えられる',
  (select icon from public.chat_rooms where app_id = 'cr-store-zz-test-a'), '🏥');
delete from public.v_app_chat_rooms where id = 'cr-store-zz-test-a';   -- 院長:RLS で何も起きない
select pg_temp.check('院長は自動ルームを削除できない',
  (select count(*) from public.chat_rooms where app_id = 'cr-store-zz-test-a'), 1::bigint);
select pg_temp.login_as('ZZ001');   -- 社長:RLS は通るがガードで断られる
do $blk$ begin
  delete from public.v_app_chat_rooms where id = 'cr-store-zz-test-a';
  raise exception 'NG 社長が自動ルームを削除できてしまった';
exception when insufficient_privilege then raise notice 'ok  社長でも自動ルームは削除できない(所属から作り直される)';
end $blk$;

-- 委員会を足すとルームもできる
select pg_temp.login_as('ZZ005');
insert into public.committees (code, name, icon) values ('zz-saiyo', 'テスト採用委員会', '🤝');
select pg_temp.check('委員会を足すとルームが自動で作られる', pg_temp.room_exists('committee:zz-saiyo'), true);
select pg_temp.login_as('ZZ003');
do $blk$ begin
  insert into public.committees (code, name) values ('zz-nope', 'スタッフが作る委員会');
  raise exception 'NG スタッフが委員会を作れてしまった';
exception when insufficient_privilege then raise notice 'ok  委員会を作れるのはマネージャー以上と人事';
end $blk$;

-- ------------------------------------------------------------
-- 7) 退職:全ルームから外れる(行は残る)
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ007');
delete from public.v_app_members where employee_no = 'ZZ102';
select pg_temp.check('退職は行を消さず在籍フラグを落とす',
  (select is_active from public.members where employee_no = 'ZZ102'), false);
select pg_temp.check('退職者は全社ルームから外れる', pg_temp.in_room('cr-all', 'ZZ102'), false);
select pg_temp.check('退職者は店舗ルームからも外れる', pg_temp.in_room('cr-store-zz-test-b', 'ZZ102'), false);

-- me() に追加所属・委員会・権限が出る
select pg_temp.login_as('ZZ007');
select pg_temp.check('me() にメンバー管理の権限が出る', (public.me() ->> 'can_manage_members')::boolean, true);
select pg_temp.login_as('ZZ002');
select pg_temp.check('院長の me() ではメンバー管理は不可', (public.me() ->> 'can_manage_members')::boolean, false);

-- ------------------------------------------------------------

do $blk$ begin raise notice '----------------------------------------'; end $blk$;
do $blk$ begin raise notice 'すべて成功しました'; end $blk$;

rollback;   -- テストデータは残さない
