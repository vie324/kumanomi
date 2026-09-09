-- ============================================================
-- くまのみ 統合ポータル — みんなで使う部分(0009)の回帰テスト
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/collaboration_test.sql
--
-- 0001〜0009 を適用済みのDBで実行する。最後に rollback するのでデータは残らない。
--
-- 見たいのは次の点。
--   1. 投稿・タスク・チャット・研修・始末書・予算が、社員番号のまま読み書きできること
--   2. 「誰が読めて、誰が直せるか」が要件どおりであること
--        投稿      … 全員が読める。本文は本人、いいねは誰でも
--        タスク    … 担当 / 作成者 / 傘の上の人
--        チャット  … 参加者だけ
--        研修      … 予定は院長以上が作る。レポートは提出したら全員が読める
--        始末書    … 本人と、組織図で上の人(+人事・社長)
--        予算      … 全員が読めて、役員以上が決める
--   3. プロフィール写真が本人だけ書けること
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

-- ------------------------------------------------------------
-- 0) 下ごしらえ(daily_operations_test と同じ顔ぶれ)
-- ------------------------------------------------------------
insert into public.stores (code, name, short_name, category, dept_code, beds)
values ('zz-test-a', 'テスト朝日院', 'テA', '整骨院', '91', 3),
       ('zz-test-b', 'テスト夕陽院', 'テB', '整体院', '92', 2);

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
-- 1) 投稿(社内SNS)
-- ------------------------------------------------------------
set local role authenticated;
select pg_temp.login_as('ZZ003');

insert into public.v_app_posts (id, type, author_id, store_id, title, body, date)
values ('zz-po-1', 'timeline', 'ZZ003', 'zz-test-a', null, '今日も一日ありがとうございました', now());
select pg_temp.check('投稿が社員番号のまま入る',
  (select author_id from public.v_app_posts where id = 'zz-po-1'), 'ZZ003');

insert into public.v_app_posts (id, type, author_id, store_id, to_id, body, points, date)
values ('zz-po-2', 'thanks', 'ZZ003', 'zz-test-a', 'ZZ002', 'いつもフォローありがとうございます', 3, now());
select pg_temp.check('サンクスギフトの宛先も社員番号で返る',
  (select to_id from public.v_app_posts where id = 'zz-po-2'), 'ZZ002');

-- 他人の名前では投稿できない
do $blk$ begin
  insert into public.v_app_posts (id, type, author_id, body) values ('zz-po-bad', 'timeline', 'ZZ002', 'なりすまし');
  raise exception 'NG 他人の名前で投稿できてしまった';
exception when insufficient_privilege then raise notice 'ok  他人の名前では投稿できない';
end $blk$;

select pg_temp.login_as('ZZ004');   -- よその店の院長
select pg_temp.check('投稿は全員が読める',
  (select count(*) from public.v_app_posts where id = 'zz-po-1'), 1::bigint);

-- いいねは誰でも付けられる
update public.v_app_posts set likes = array['ZZ004'] where id = 'zz-po-1';
select pg_temp.check('よその人もいいねできる',
  (select likes from public.v_app_posts where id = 'zz-po-1'), array['ZZ004']);

select pg_temp.login_as('ZZ006');   -- 事務(ランク1)
update public.v_app_posts set body = '書き換え', likes = array['ZZ004', 'ZZ006'] where id = 'zz-po-1';
select pg_temp.check('本人以外は本文を変えられない(いいねだけ通る)',
  (select body from public.v_app_posts where id = 'zz-po-1'), '今日も一日ありがとうございました');
select pg_temp.check('いいねは反映される',
  (select likes from public.v_app_posts where id = 'zz-po-1'), array['ZZ004', 'ZZ006']);

select pg_temp.login_as('ZZ003');
update public.v_app_posts set body = '本人が直した' where id = 'zz-po-1';
select pg_temp.check('本人は本文を直せる',
  (select body from public.v_app_posts where id = 'zz-po-1'), '本人が直した');

select pg_temp.login_as('ZZ006');
do $blk$
declare n integer;
begin
  delete from public.v_app_posts where id = 'zz-po-1';
  if exists (select 1 from public.posts where app_id = 'zz-po-1') then
    raise notice 'ok  本人でも院長でもない人は投稿を消せない';
  else
    raise exception 'NG 事務が他人の投稿を消せてしまった';
  end if;
end $blk$;

-- ------------------------------------------------------------
-- 2) タスク(振り分け)
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ002');   -- 院長A → スタッフA に振る
insert into public.v_app_tasks (id, title, owner_id, created_by, due, status, source)
values ('zz-tk-1', 'ベッドメイクの見直し', 'ZZ003', 'ZZ002', current_date + 3, 'todo',
        '{"kind":"chat","refId":"zz-room-1","label":"チャットから"}'::jsonb);
select pg_temp.check('タスクの担当が社員番号で返る',
  (select owner_id from public.v_app_tasks where id = 'zz-tk-1'), 'ZZ003');

select pg_temp.login_as('ZZ003');
select pg_temp.check('担当者にはタスクが見える',
  (select count(*) from public.v_app_tasks where id = 'zz-tk-1'), 1::bigint);
update public.v_app_tasks set status = 'done', progress = 100 where id = 'zz-tk-1';
select pg_temp.check('担当者が完了にできる',
  (select status from public.v_app_tasks where id = 'zz-tk-1'), 'done');
select pg_temp.check('完了時刻が自動で入る',
  (select completed_at is not null from public.tasks where app_id = 'zz-tk-1'), true);

-- スタッフが上の人に振ることもできる(作成者は自分)
insert into public.v_app_tasks (id, title, owner_id, created_by, due, status)
values ('zz-tk-2', '院長に確認依頼', 'ZZ002', 'ZZ003', current_date + 1, 'todo');
select pg_temp.check('スタッフから院長へも振れる',
  (select owner_id from public.v_app_tasks where id = 'zz-tk-2'), 'ZZ002');

-- 作成者を他人にはできない
do $blk$ begin
  insert into public.v_app_tasks (id, title, owner_id, created_by, status)
  values ('zz-tk-bad', 'なりすまし', 'ZZ004', 'ZZ001', 'todo');
  raise exception 'NG 作成者を他人にできてしまった';
exception when insufficient_privilege then raise notice 'ok  作成者は自分にしかできない';
end $blk$;

select pg_temp.login_as('ZZ004');   -- よその院長
select pg_temp.check('よその院長に他店のタスクは見えない',
  (select count(*) from public.v_app_tasks where id in ('zz-tk-1', 'zz-tk-2')), 0::bigint);

select pg_temp.login_as('ZZ001');   -- 社長
select pg_temp.check('社長は傘の中のタスクが見える',
  (select count(*) from public.v_app_tasks where id in ('zz-tk-1', 'zz-tk-2')), 2::bigint);

-- ------------------------------------------------------------
-- 3) チャット(参加者だけ)
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ002');
insert into public.v_app_chat_rooms (id, kind, name, icon, "desc", store_id, member_ids, announce_only)
values ('zz-room-1', 'store', 'テスト朝日院', '🏥', '店舗の連絡', 'zz-test-a', array['ZZ002', 'ZZ003'], false);
select pg_temp.check('ルームの参加者が社員番号で返る',
  (select member_ids from public.v_app_chat_rooms where id = 'zz-room-1'), array['ZZ002', 'ZZ003']);

-- 自分が入っていないルームは作れない
do $blk$ begin
  insert into public.v_app_chat_rooms (id, kind, name, member_ids)
  values ('zz-room-bad', 'group', '他人だけの部屋', array['ZZ003', 'ZZ004']);
  raise exception 'NG 自分が入っていないルームを作れてしまった';
exception when insufficient_privilege then raise notice 'ok  ルームは自分を含めてしか作れない';
end $blk$;

select pg_temp.login_as('ZZ003');
insert into public.v_app_chat_messages (id, room_id, author_id, date, text, mentions)
values ('zz-msg-1', 'zz-room-1', 'ZZ003', now(), '@院長A 明日の朝礼は9時からですか?', array['ZZ002']);
select pg_temp.check('発言が入る',
  (select text from public.v_app_chat_messages where id = 'zz-msg-1'), '@院長A 明日の朝礼は9時からですか?');

select pg_temp.login_as('ZZ004');   -- 参加していない人
select pg_temp.check('参加していないルームは見えない',
  (select count(*) from public.v_app_chat_rooms where id = 'zz-room-1'), 0::bigint);
select pg_temp.check('参加していないルームの発言も見えない',
  (select count(*) from public.v_app_chat_messages where id = 'zz-msg-1'), 0::bigint);
do $blk$ begin
  insert into public.v_app_chat_messages (id, room_id, author_id, date, text)
  values ('zz-msg-bad', 'zz-room-1', 'ZZ004', now(), '割り込み');
  raise exception 'NG 参加していないルームに書けてしまった';
exception when insufficient_privilege then raise notice 'ok  参加していないルームには書けない';
end $blk$;

select pg_temp.login_as('ZZ002');   -- 参加者(発言者ではない)
update public.v_app_chat_messages set read_by = array['ZZ002'], text = '書き換え' where id = 'zz-msg-1';
select pg_temp.check('既読は付けられる',
  (select read_by from public.v_app_chat_messages where id = 'zz-msg-1'), array['ZZ002']);
select pg_temp.check('他人の発言の本文は変えられない',
  (select text from public.v_app_chat_messages where id = 'zz-msg-1'), '@院長A 明日の朝礼は9時からですか?');

-- 発言からタスクを作って、発言に紐付ける(他人の発言にも付けられる)
insert into public.v_app_tasks (id, title, owner_id, created_by, status, source)
values ('zz-tk-3', '朝礼時刻を確認', 'ZZ002', 'ZZ002', 'todo', '{"kind":"chat","refId":"zz-room-1"}'::jsonb);
update public.v_app_chat_messages set task_id = 'zz-tk-3' where id = 'zz-msg-1';
select pg_temp.check('発言にタスクを紐付けられる',
  (select task_id from public.v_app_chat_messages where id = 'zz-msg-1'), 'zz-tk-3');

select pg_temp.login_as('ZZ001');   -- 社長は全ルームを見られる
select pg_temp.check('役員以上は参加していないルームも読める',
  (select count(*) from public.v_app_chat_rooms where id = 'zz-room-1'), 1::bigint);

-- ------------------------------------------------------------
-- 4) 研修とレポート
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ003');
do $blk$ begin
  insert into public.v_app_trainings (id, title, type, date, required)
  values ('zz-tr-bad', 'スタッフが作った研修', '座学', current_date + 7, false);
  raise exception 'NG スタッフが研修の予定を作れてしまった';
exception when insufficient_privilege then raise notice 'ok  研修の予定を作れるのは院長以上';
end $blk$;

select pg_temp.login_as('ZZ002');
insert into public.v_app_trainings (id, title, type, date, start, duration_min, required, place, attendees)
values ('zz-tr-1', '骨盤矯正の基礎', '技術研修', current_date + 7, '19:00', 90, true, '本部',
        '[{"staffId":"ZZ003","status":"invited"}]'::jsonb);
select pg_temp.check('研修の予定が入る',
  (select title from public.v_app_trainings where id = 'zz-tr-1'), '骨盤矯正の基礎');

select pg_temp.login_as('ZZ003');
update public.v_app_trainings
   set title = 'スタッフが書き換え',
       attendees = '[{"staffId":"ZZ003","status":"attend"}]'::jsonb
 where id = 'zz-tr-1';
select pg_temp.check('スタッフは出欠だけ変えられる(題名は戻る)',
  (select title from public.v_app_trainings where id = 'zz-tr-1'), '骨盤矯正の基礎');
select pg_temp.check('出欠は反映される',
  (select attendees -> 0 ->> 'status' from public.v_app_trainings where id = 'zz-tr-1'), 'attend');

-- レポート:下書きは本人だけ、提出したら全員
insert into public.v_app_training_reports (id, training_id, author_id, body, learned, apply_plan, status)
values ('zz-rp-1', 'zz-tr-1', 'ZZ003', '骨盤の触診を練習した', '左右差の見方', '初診で必ず確認する', 'draft');

select pg_temp.login_as('ZZ004');
select pg_temp.check('下書きのレポートは他人に見えない',
  (select count(*) from public.v_app_training_reports where id = 'zz-rp-1'), 0::bigint);

select pg_temp.login_as('ZZ003');
update public.v_app_training_reports set status = 'submitted' where id = 'zz-rp-1';
select pg_temp.check('提出すると提出時刻が入る',
  (select submitted_at is not null from public.training_reports where app_id = 'zz-rp-1'), true);

select pg_temp.login_as('ZZ004');
select pg_temp.check('提出済みのレポートは全員が読める',
  (select count(*) from public.v_app_training_reports where id = 'zz-rp-1'), 1::bigint);
do $blk$
declare n integer;
begin
  update public.v_app_training_reports set body = '他人が書き換え' where id = 'zz-rp-1';
  if (select body from public.training_reports where app_id = 'zz-rp-1') <> '骨盤の触診を練習した' then
    raise exception 'NG 他人のレポートを書き換えられた';
  end if;
  raise notice 'ok  レポートを書けるのは本人だけ';
end $blk$;

-- 同じ研修に2通は出せない
select pg_temp.login_as('ZZ003');
do $blk$ begin
  insert into public.v_app_training_reports (id, training_id, author_id, body, status)
  values ('zz-rp-dup', 'zz-tr-1', 'ZZ003', '2通目', 'draft');
  raise exception 'NG 同じ研修に2通目のレポートが入った';
exception when unique_violation then raise notice 'ok  レポートは研修ごとに1人1通';
end $blk$;

-- ------------------------------------------------------------
-- 5) 始末書・業務改善書
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ003');
insert into public.v_app_incident_reports
  (id, author_id, kind, occurred_on, conclusion, cause, process_detail, worst_case, prevention, status)
values ('zz-ir-1', 'ZZ003', 'shimatsu', current_date - 1,
        '予約の二重登録で患者様を30分お待たせした', '予約表の確認不足',
        '電話予約を受けた際に既存の予約を確認せずに登録した', '患者様が離脱し、口コミで評判を落としていた',
        '電話を受けたらまず予約表を開く。登録前に時間帯を声に出して確認する', 'submitted');
select pg_temp.check('始末書が入り、提出時刻が付く',
  (select submitted_at is not null from public.incident_reports where app_id = 'zz-ir-1'), true);

select pg_temp.login_as('ZZ002');   -- 直属の上司
select pg_temp.check('組織図の上の人は始末書が読める',
  (select count(*) from public.v_app_incident_reports where id = 'zz-ir-1'), 1::bigint);

select pg_temp.login_as('ZZ001');   -- 社長(さらに上)
select pg_temp.check('社長も読める',
  (select count(*) from public.v_app_incident_reports where id = 'zz-ir-1'), 1::bigint);

select pg_temp.login_as('ZZ005');   -- 本部人事
select pg_temp.check('本部人事も読める',
  (select count(*) from public.v_app_incident_reports where id = 'zz-ir-1'), 1::bigint);

select pg_temp.login_as('ZZ004');   -- よその院長(組織図で上ではない)
select pg_temp.check('よその院長には見えない',
  (select count(*) from public.v_app_incident_reports where id = 'zz-ir-1'), 0::bigint);

select pg_temp.login_as('ZZ006');   -- 事務(横の人)
select pg_temp.check('横の人には見えない',
  (select count(*) from public.v_app_incident_reports where id = 'zz-ir-1'), 0::bigint);

-- 上の人は「確認」だけできる。本文は書き換えられない
select pg_temp.login_as('ZZ002');
update public.v_app_incident_reports
   set status = 'acknowledged', ack_comment = '再発防止策を朝礼で共有してください', conclusion = '上司が書き換え'
 where id = 'zz-ir-1';
select pg_temp.check('上の人が確認済みにできる',
  (select status from public.v_app_incident_reports where id = 'zz-ir-1'), 'acknowledged');
select pg_temp.check('確認した人が記録される',
  (select acknowledged_by from public.v_app_incident_reports where id = 'zz-ir-1'), 'ZZ002');
select pg_temp.check('上の人は本文を書き換えられない',
  (select conclusion from public.v_app_incident_reports where id = 'zz-ir-1'), '予約の二重登録で患者様を30分お待たせした');

-- 本人は提出後に本文を変えられない
select pg_temp.login_as('ZZ003');
update public.v_app_incident_reports set cause = '本人があとから書き換え' where id = 'zz-ir-1';
select pg_temp.check('提出後は本人でも本文を変えられない',
  (select cause from public.v_app_incident_reports where id = 'zz-ir-1'), '予約表の確認不足');

-- 他人の名前では出せない
do $blk$ begin
  insert into public.v_app_incident_reports (id, author_id, kind, occurred_on, status)
  values ('zz-ir-bad', 'ZZ002', 'kaizen', current_date, 'draft');
  raise exception 'NG 他人の名前で始末書を出せてしまった';
exception when insufficient_privilege then raise notice 'ok  始末書は自分の名前でしか出せない';
end $blk$;

-- ------------------------------------------------------------
-- 6) 予算
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ002');   -- 院長は決められない
do $blk$ begin
  insert into public.v_app_budgets (id, store_id, month, amount)
  values ('zz-bg-bad', 'zz-test-a', to_char(current_date, 'YYYY-MM'), 1000000);
  raise exception 'NG 院長が予算を決められてしまった';
exception when insufficient_privilege then raise notice 'ok  予算を決められるのは役員以上';
end $blk$;

select pg_temp.login_as('ZZ001');
insert into public.v_app_budgets (id, store_id, month, amount)
values ('zz-bg-1', 'zz-test-a', to_char(current_date, 'YYYY-MM'), 3200000);
select pg_temp.check('社長は予算を決められる',
  (select amount from public.v_app_budgets where id = 'zz-bg-1'), 3200000::bigint);

-- 同じ店・同じ月を送り直したら上書き(2行にならない)
insert into public.v_app_budgets (id, store_id, month, amount)
values ('zz-bg-1', 'zz-test-a', to_char(current_date, 'YYYY-MM'), 3500000);
select pg_temp.check('同じ月の予算は1行のまま',
  (select count(*) from public.budgets b join public.stores s on s.id = b.store_id
    where s.code = 'zz-test-a' and b.month = to_char(current_date, 'YYYY-MM')), 1::bigint);

select pg_temp.login_as('ZZ003');
select pg_temp.check('予算は全員が読める',
  (select amount from public.v_app_budgets where id = 'zz-bg-1'), 3500000::bigint);

-- ------------------------------------------------------------
-- 7) プロフィール写真
-- ------------------------------------------------------------
select pg_temp.login_as('ZZ003');
update public.members set photo_url = 'https://example.invalid/avatars/ZZ003/me.jpg'
 where employee_no = 'ZZ003';
select pg_temp.check('自分の写真は自分で設定できる',
  (select photo_url from public.v_member_directory where employee_no = 'ZZ003'),
  'https://example.invalid/avatars/ZZ003/me.jpg');
select pg_temp.check('me() に写真が出る',
  (select public.me() ->> 'photo_url'), 'https://example.invalid/avatars/ZZ003/me.jpg');

do $blk$
declare n integer;
begin
  update public.members set photo_url = 'https://example.invalid/x.jpg' where employee_no = 'ZZ002';
  get diagnostics n = row_count;
  if n > 0 then raise exception 'NG 他人の写真を書き換えられた'; end if;
  raise notice 'ok  他人の写真は書き換えられない';
end $blk$;

-- Storage:自分のフォルダにだけ置ける
insert into storage.objects (bucket_id, name) values ('avatars', 'ZZ003/me.jpg');
select pg_temp.check('自分のフォルダに写真を置ける',
  (select count(*) from storage.objects where name = 'ZZ003/me.jpg'), 1::bigint);
do $blk$ begin
  insert into storage.objects (bucket_id, name) values ('avatars', 'ZZ002/hijack.jpg');
  raise exception 'NG 他人のフォルダに写真を置けてしまった';
exception when insufficient_privilege then raise notice 'ok  他人のフォルダには置けない';
end $blk$;

-- ------------------------------------------------------------

do $blk$ begin raise notice '----------------------------------------'; end $blk$;
do $blk$ begin raise notice 'すべて成功しました'; end $blk$;

rollback;   -- テストデータは残さない
