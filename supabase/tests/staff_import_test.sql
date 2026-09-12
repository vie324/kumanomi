-- ============================================================
-- くまのみ 統合ポータル — スタッフ名簿一括登録の回帰テスト
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/staff_import_test.sql
--
-- 0001〜0012 を適用済みのDBで実行する。最後に rollback するのでデータは残らない。
-- 実在の店舗・氏名とぶつからないテスト用の名前を使うので、
-- すでに本番データが入っているDBに対しても流せる。
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

-- ------------------------------------------------------------
-- 1) 役職の読み替え
-- ------------------------------------------------------------

select pg_temp.check('統括院長は院長より先に判定',
  app.staff_rank_of('統括院長')::text, 'chief');
select pg_temp.check('院長',              app.staff_rank_of('院長')::text, 'manager');
select pg_temp.check('店長も院長と同じ枠', app.staff_rank_of('店長')::text, 'manager');
select pg_temp.check('マネージャー',       app.staff_rank_of('マネージャー')::text, 'area');
select pg_temp.check('社長/統括マネージャーは統括MG扱い',
  app.staff_rank_of('社長/統括マネージャー')::text, 'exec');
select pg_temp.check('本部',              app.staff_rank_of('本部')::text, 'hr');
select pg_temp.check('一般社員',          app.staff_rank_of('一般社員')::text, 'staff');
select pg_temp.check('空欄はスタッフ',     app.staff_rank_of('')::text, 'staff');
select pg_temp.check('空白が入っていても判定できる',
  app.staff_rank_of(' 統括 院長 ')::text, 'chief');

select pg_temp.check('管理職の部門',   app.staff_department_of('area')::text,  'management');
select pg_temp.check('本部の部門',     app.staff_department_of('hr')::text,    'head_office');
select pg_temp.check('スタッフの部門', app.staff_department_of('staff')::text, 'seitai');

-- ------------------------------------------------------------
-- 2) 性別の読み替え
-- ------------------------------------------------------------

select pg_temp.check('男性', app.staff_gender_of('男性')::text, 'male');
select pg_temp.check('女性', app.staff_gender_of('女性')::text, 'female');
select pg_temp.check('空欄は未確認', app.staff_gender_of('')::text, 'unknown');

-- ------------------------------------------------------------
-- 3) 氏名の異体字あわせ
-- ------------------------------------------------------------

select pg_temp.check('邉と邊は同じ人',
  app.name_fold('渡邉 玲司'), app.name_fold('渡邊 玲司'));
select pg_temp.check('髙と高は同じ人',
  app.name_fold('髙橋 花音'), app.name_fold('高橋 花音'));
select pg_temp.check('﨑と崎は同じ人',
  app.name_fold('吉﨑 湊'), app.name_fold('吉崎 湊'));
select pg_temp.check('カタカナのニと漢数字の二は同じ人',
  app.name_fold('佐ニ木 灯'), app.name_fold('佐二木 灯'));
select pg_temp.check('別の名前は混ざらない',
  app.name_fold('東雲 玲司') = app.name_fold('東雲 玲子'), false);
select pg_temp.check('旧姓の括弧は落とす',
  app.name_fold('早乙女(桐生) 鈴'), app.name_fold('早乙女 鈴'));

-- ------------------------------------------------------------
-- 4) シートの読み取り
-- ------------------------------------------------------------

create temp table t_sheet as
select * from app.parse_staff_sheet($sheet$
状態	社員番号	姓	名	性別	役職	店舗	店舗	店舗	メール
	ZZ01	東雲	玲司	男性	マネージャー	テスト青葉院	テスト白鷺院	テスト青葉院	shinonome@example.test
	ZZ02	北条	隼	男性	院長	テスト青葉院			hojo@example.test
	ZZ03	白雪	花音	女性	一般社員	テスト青葉院			shirayuki@example.test
	ZZ04	九条	誠	男性	統括院長	テスト白鷺院	テスト青葉院		kujo@example.test
育休中	ZZ05	早乙女	鈴	女性					saotome@example.test
$sheet$);

select pg_temp.check('見出し行は飛ばす', (select count(*)::int from t_sheet), 5);
select pg_temp.check('姓と名をつないで氏名にする',
  (select full_name from t_sheet where employee_no = 'ZZ02'), '北条 隼');
select pg_temp.check('性別を読む',
  (select gender::text from t_sheet where employee_no = 'ZZ03'), 'female');
select pg_temp.check('メールを読む',
  (select email from t_sheet where employee_no = 'ZZ02'), 'hojo@example.test');
select pg_temp.check('状態を読む',
  (select state from t_sheet where employee_no = 'ZZ05'), '育休中');
select pg_temp.check('店舗は並び順のまま、重複は落とす',
  (select store_names from t_sheet where employee_no = 'ZZ01'),
  array['テスト青葉院', 'テスト白鷺院']);
select pg_temp.check('店舗が空欄なら空の配列',
  (select store_names from t_sheet where employee_no = 'ZZ05'), '{}'::text[]);

-- ------------------------------------------------------------
-- 5) 店舗名の別名
-- ------------------------------------------------------------

insert into public.stores (code, name, category) values ('zz-aoba', 'テスト青葉駅前院', '整骨院');
insert into public.store_aliases (alias, store_name) values ('テスト青葉院', 'テスト青葉駅前院');

-- ------------------------------------------------------------
-- 6) 取込本体
-- ------------------------------------------------------------

create temp table t_result as
select public.import_staff_sheet($sheet$
状態	社員番号	姓	名	性別	役職	店舗	店舗	店舗	メール
	ZZ01	東雲	玲司	男性	マネージャー	テスト青葉院	テスト白鷺院	テスト青葉院	shinonome@example.test
	ZZ02	北条	隼	男性	院長	テスト青葉院			hojo@example.test
	ZZ03	白雪	花音	女性	一般社員	テスト青葉院			shirayuki@example.test
	ZZ04	九条	誠	男性	統括院長	テスト白鷺院	テスト青葉院		kujo@example.test
育休中	ZZ05	早乙女	鈴	女性					saotome@example.test
$sheet$, jsonb_build_object('create_missing_stores', true), 'テスト') as r;

select pg_temp.check('読んだ行数',   (select (r ->> 'rows')::int            from t_result), 5);
select pg_temp.check('新しく足した人', (select (r ->> 'members_new')::int     from t_result), 5);
select pg_temp.check('更新した人',   (select (r ->> 'members_updated')::int from t_result), 0);
select pg_temp.check('新しく作った店舗', (select (r ->> 'stores_new')::int   from t_result), 1);
select pg_temp.check('解決できない店舗は無い',
  (select r -> 'unknown_stores' from t_result), '[]'::jsonb);
select pg_temp.check('作った店舗はテスト白鷺院だけ',
  (select r -> 'created_stores' from t_result), '["テスト白鷺院"]'::jsonb);

-- 別名を通して既存の店舗に入る(テスト青葉院 → テスト青葉駅前院)
select pg_temp.check('別名で既存の店舗に結び付く',
  (select s.name from public.members m join public.stores s on s.id = m.primary_store_id
    where m.employee_no = 'ZZ02'), 'テスト青葉駅前院');

select pg_temp.check('社員番号が入る',
  (select employee_no from public.members where full_name = '北条 隼'), 'ZZ02');
select pg_temp.check('メールが入る',
  (select email from public.members where employee_no = 'ZZ03'), 'shirayuki@example.test');
select pg_temp.check('性別が入る',
  (select gender::text from public.members where employee_no = 'ZZ03'), 'female');
select pg_temp.check('役職がそのまま呼称になる',
  (select role_title from public.members where employee_no = 'ZZ04'), '統括院長');
select pg_temp.check('ランクに読み替わる',
  (select rank::text from public.members where employee_no = 'ZZ01'), 'area');

-- 2 つめ以降の店舗は兼務になる
select pg_temp.check('主たる所属は 1 つめの店舗',
  (select s.name from public.members m join public.stores s on s.id = m.primary_store_id
    where m.employee_no = 'ZZ01'), 'テスト青葉駅前院');
select pg_temp.check('2 つめ以降は兼務',
  (select store_codes from public.members where employee_no = 'ZZ01'),
  array[(select code from public.stores where name = 'テスト白鷺院')]);
select pg_temp.check('所属は兼務ぶんも行になる',
  (select count(*)::int from public.member_store_assignments a
     join public.members m on m.id = a.member_id where m.employee_no = 'ZZ01'), 2);
select pg_temp.check('主たる所属の印は 1 つ',
  (select count(*)::int from public.member_store_assignments a
     join public.members m on m.id = a.member_id
    where m.employee_no = 'ZZ01' and a.is_primary), 1);

-- 育休中は在籍のまま、備考に残す
select pg_temp.check('育休中も在籍扱い',
  (select is_active from public.members where employee_no = 'ZZ05'), true);
select pg_temp.check('育休中は備考に残す',
  (select note from public.members where employee_no = 'ZZ05'), '育休中');
select pg_temp.check('店舗が空欄なら主たる所属は付かない',
  (select primary_store_id from public.members where employee_no = 'ZZ05'), null::uuid);

-- 上司は店舗の院長 → 統括院長 → MG の順でつながる
select pg_temp.check('一般社員の上司は同じ店舗の院長',
  (select mgr.employee_no from public.members m
     join public.members mgr on mgr.id = m.reports_to_id
    where m.employee_no = 'ZZ03'), 'ZZ02');
select pg_temp.check('院長の上司は統括院長',
  (select mgr.employee_no from public.members m
     join public.members mgr on mgr.id = m.reports_to_id
    where m.employee_no = 'ZZ02'), 'ZZ04');
select pg_temp.check('統括院長の上司はマネージャー',
  (select mgr.employee_no from public.members m
     join public.members mgr on mgr.id = m.reports_to_id
    where m.employee_no = 'ZZ04'), 'ZZ01');

-- ------------------------------------------------------------
-- 7) もう一度流しても増えない(異体字・改姓も同じ人に重なる)
-- ------------------------------------------------------------

create temp table t_again as
select public.import_staff_sheet($sheet$
状態	社員番号	姓	名	性別	役職	店舗	店舗	店舗	メール
	ZZ01	東雲	玲司	男性	マネージャー	テスト青葉院	テスト白鷺院	テスト青葉院	shinonome@example.test
	ZZ02	北条	隼	男性	院長	テスト青葉院			hojo@example.test
	ZZ03	白雪	花音	女性	一般社員	テスト青葉院			shirayuki@example.test
	ZZ04	九条	誠	男性	統括院長	テスト白鷺院	テスト青葉院		kujo@example.test
育休中	ZZ05	早乙女	鈴	女性					saotome@example.test
$sheet$, '{}'::jsonb, 'テスト2回目') as r;

select pg_temp.check('2 回目は誰も増えない', (select (r ->> 'members_new')::int  from t_again), 0);
select pg_temp.check('2 回目は全員更新',     (select (r ->> 'members_updated')::int from t_again), 5);
select pg_temp.check('2 回目は店舗も増えない', (select (r ->> 'stores_new')::int   from t_again), 0);

-- 社員番号が無くても、氏名だけで同じ人に重なる
create temp table t_byname as
select public.import_staff_sheet($sheet$
状態	社員番号	姓	名	性別	役職	店舗	メール
		北条	隼	男性	院長	テスト青葉院	hojo@example.test
$sheet$, '{}'::jsonb, 'テスト氏名のみ') as r;

select pg_temp.check('氏名だけでも同じ人に重なる',
  (select (r ->> 'members_new')::int from t_byname), 0);
select pg_temp.check('社員番号は消えない',
  (select employee_no from public.members where full_name = '北条 隼'), 'ZZ02');

-- 異体字で書かれていても同じ人に重なる(氏名はシートの字に直る)
create temp table t_itaiji as
select public.import_staff_sheet($sheet$
状態	社員番号	姓	名	性別	役職	店舗	メール
	ZZ04	九條	誠	男性	統括院長	テスト白鷺院	kujo@example.test
$sheet$, '{}'::jsonb, 'テスト異体字') as r;

select pg_temp.check('異体字でも同じ人に重なる',
  (select (r ->> 'members_new')::int from t_itaiji), 0);

-- ------------------------------------------------------------
-- 8) 同じ社員番号が 2 行にあると止まる
-- ------------------------------------------------------------

do $$
begin
  perform public.import_staff_sheet($sheet$
状態	社員番号	姓	名	性別	役職	店舗	メール
	ZZ09	五十嵐	湊	男性	一般社員	テスト青葉院	igarashi1@example.test
	ZZ09	伏見	灯	男性	一般社員	テスト青葉院	fushimi@example.test
$sheet$);
  raise exception 'NG 社員番号の重複で止まらなかった';
exception when unique_violation then
  raise notice 'ok  社員番号が重複していたら止まる';
end $$;

-- ------------------------------------------------------------
-- 9) 読める行が無いときは止まる
-- ------------------------------------------------------------

do $$
begin
  perform public.import_staff_sheet('状態	社員番号	姓	名	性別	役職	店舗	メール');
  raise exception 'NG 空のシートで止まらなかった';
exception when raise_exception then
  if sqlerrm like 'NG %' then raise; end if;
  raise notice 'ok  読める行が無ければ止まる';
end $$;

rollback;
