-- ============================================================
-- くまのみ 統合ポータル — 組織図一括取込の回帰テスト
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/roster_import_test.sql
--
-- 0001〜0005 を適用済みのDBで実行する。最後に rollback するのでデータは残らない。
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
-- 1) 氏名セルの解釈
-- ------------------------------------------------------------

select pg_temp.check('注記なしの氏名',
  app.parse_person_cell('三日月 湊') ->> 'full_name', '三日月 湊');
select pg_temp.check('氏名キーは空白を落とす',
  app.parse_person_cell('三日月 湊') ->> 'name_key', '三日月湊');
select pg_temp.check('資格の注記',
  app.parse_person_cell('三日月 湊(柔整/男)') ->> 'license', 'judo');
select pg_temp.check('性別の注記',
  app.parse_person_cell('白雪 花音(柔整/女)') ->> 'gender', 'female');
select pg_temp.check('注記は氏名から取り除く',
  app.parse_person_cell('白雪 花音(柔整/女)') ->> 'full_name', '白雪 花音');
select pg_temp.check('半角括弧・スラッシュ以外の区切りも読む',
  app.parse_person_cell('白雪 花音(鍼灸・女)') ->> 'license', 'acupuncture');

-- 旧姓の括弧は注記ではない(氏名にそのまま残る)
select pg_temp.check('旧姓は氏名に残す',
  app.parse_person_cell('早乙女(桐生) 鈴') ->> 'full_name', '早乙女(桐生) 鈴');
select pg_temp.check('旧姓を取り出す',
  app.parse_person_cell('早乙女(桐生) 鈴') ->> 'former_name', '桐生');
select pg_temp.check('旧姓は氏名キーから除く',
  app.parse_person_cell('早乙女(桐生) 鈴') ->> 'name_key', '早乙女鈴');
select pg_temp.check('旧姓+注記の併用',
  app.parse_person_cell('早乙女(桐生) 鈴(整体/女)') ->> 'license', 'seitai');
select pg_temp.check('旧姓+注記でも氏名は保たれる',
  app.parse_person_cell('早乙女(桐生) 鈴(整体/女)') ->> 'full_name', '早乙女(桐生) 鈴');

-- 同姓同名の区別
select pg_temp.check('@は氏名に含めない',
  app.parse_person_cell('白雪 花音@2') ->> 'full_name', '白雪 花音');
select pg_temp.check('@は氏名キーに残す',
  app.parse_person_cell('白雪 花音@2') ->> 'name_key', '白雪花音@2');

-- 空セル
select pg_temp.check('空欄は人ではない',    app.parse_person_cell(''),     null::jsonb);
select pg_temp.check('ハイフンは人ではない', app.parse_person_cell('-'),   null::jsonb);
select pg_temp.check('「なし」は人ではない', app.parse_person_cell('なし'), null::jsonb);

-- ------------------------------------------------------------
-- 2) 見出しの判定
-- ------------------------------------------------------------

select pg_temp.check('統括MGはMGより先に判定',   app.roster_column_role('統括MG'), 'gm');
select pg_temp.check('MG',                       app.roster_column_role('MG'), 'mg');
select pg_temp.check('統括院長は院長より先に判定', app.roster_column_role('統括院長'), 'chief');
select pg_temp.check('院長',                     app.roster_column_role('院長'), 'director');
select pg_temp.check('店長は美容部門より先に判定', app.roster_column_role('店長'), 'beauty_manager');
select pg_temp.check('整体部門',                 app.roster_column_role('整体部門'), 'seitai');
select pg_temp.check('受付スタッフ',             app.roster_column_role('受付スタッフ'), 'reception');
select pg_temp.check('美容部門',                 app.roster_column_role('美容部門'), 'beauty');
select pg_temp.check('空白が入っていても判定できる', app.roster_column_role(' 統括 院長 '), 'chief');
select pg_temp.check('見出しでない語は無視',     app.roster_column_role('備考'), null::text);

-- ------------------------------------------------------------
-- 3) シートのパース(2行見出し・結合セル・引き継ぎ)
-- ------------------------------------------------------------

create temp table t_sheet as
select * from app.parse_roster_sheet($sheet$
					整体部門			受付スタッフ	美容部門
統括MG	MG	統括院長	店舗	院長					店長
東雲 玲司	西園寺 円	南雲 剛	テスト青葉院	北条 隼	三日月 湊	白雪 花音			橘 千尋
			テスト白鷺院	南雲 剛
		九条 誠	テスト朱雀院	九条 誠
	五十嵐 湊	神楽 遙	テスト玄武院	葛城 咲	伏見 灯	綾瀬 澪
		-	テスト麒麟院	五十嵐 湊	真田 蒼	相良 陸	早乙女(桐生) 鈴
$sheet$);

select pg_temp.check('店舗の行数', (select count(*)::int from t_sheet), 5);
select pg_temp.check('統括MGは全行に引き継がれる',
  (select count(*)::int from t_sheet where general_manager = '東雲 玲司'), 5);
select pg_temp.check('MGは次の値が出るまで引き継がれる',
  (select count(*)::int from t_sheet where area_manager = '西園寺 円'), 3);
select pg_temp.check('統括院長も引き継がれる',
  (select chief_director from t_sheet where store_name = 'テスト白鷺院'), '南雲 剛');
select pg_temp.check('ハイフンで引き継ぎを断ち切れる',
  (select chief_director from t_sheet where store_name = 'テスト麒麟院'), null::text);
select pg_temp.check('整体部門は配列で入る',
  (select array_length(seitai, 1) from t_sheet where store_name = 'テスト青葉院'), 2);
select pg_temp.check('店長の列を店長として読む',
  (select beauty_manager from t_sheet where store_name = 'テスト青葉院'), '橘 千尋');
select pg_temp.check('人のいない部門は空配列',
  (select array_length(seitai, 1) from t_sheet where store_name = 'テスト白鷺院'), null::int);

-- 1行見出しでも読めること
select pg_temp.check('1行見出しでも読める',
  (select count(*)::int from app.parse_roster_sheet(
$sheet$統括MG	MG	統括院長	店舗	院長	整体部門	整体部門
東雲 玲司	西園寺 円	南雲 剛	テスト青葉院	北条 隼	三日月 湊	白雪 花音
$sheet$)), 1);

-- 見出しが無ければエラーになること
do $blk$
begin
  perform app.parse_roster_sheet($sheet$あ	い	う
1	2	3
$sheet$);
  raise exception 'NG 見出しが無くても通ってしまった';
exception
  when others then
    if sqlerrm like 'NG %' then raise; end if;
    raise notice 'ok  見出しが無ければエラーになる';
end $blk$;

-- ------------------------------------------------------------
-- 4) 取り込み本体
-- ------------------------------------------------------------

create temp table t_result as
select public.import_roster_sheet($sheet$
					整体部門			受付スタッフ	美容部門
統括MG	MG	統括院長	店舗	院長					店長
東雲 玲司(男)	西園寺 円(女)	南雲 剛(男)	テスト青葉院	北条 隼(男)	三日月 湊(柔整/男)	白雪 花音(柔整/女)			橘 千尋(女)
			テスト白鷺院	南雲 剛(男)
		九条 誠(男)	テスト朱雀院	九条 誠(男)
	五十嵐 湊(男)	神楽 遙(男)	テスト玄武院	葛城 咲(女)	伏見 灯(鍼灸/女)	綾瀬 澪(整体/女)
		-	テスト麒麟院	五十嵐 湊(男)	真田 蒼(整体/女)	相良 陸(柔整/男)	早乙女(桐生) 鈴(女)
$sheet$, '{}'::jsonb, 'regression-test') as r;

select pg_temp.check('店舗が5件登録された',
  ((select r from t_result) ->> 'stores_created')::int, 5);
select pg_temp.check('メンバーが16名登録された',
  ((select r from t_result) ->> 'members_created')::int, 16);
-- 戻り値の orphans は名簿ぜんたいを数えるので、組織図に載っていない人
-- (スタッフ名簿だけで入った人など)がいると 0 にならない。
-- ここで見たいのは「この取込が上司を付け忘れなかったか」なので、
-- 今回のバッチに出てきた人だけを数える。
select pg_temp.check('上司なしの取りこぼしはない',
  (select count(*)::int
     from public.members m
     join public.roster_import_people p on p.name_key = m.name_key
    where p.batch_id = (((select r from t_result) ->> 'batch_id')::uuid)
      and m.is_active and m.reports_to_id is null
      and m.rank not in ('ceo', 'exec', 'hr')), 0);
select pg_temp.check('同姓同名の誤検出はない',
  jsonb_array_length((select r from t_result) -> 'duplicate_names'), 0);
-- 資格の注記があるのは整体部門の6名だけ。残る10名は「未確認」として報告される
select pg_temp.check('資格の注記が無い人は未確認として数えられる',
  ((select r from t_result) ->> 'unknown_license')::int, 10);
select pg_temp.check('性別は全員判定できた',
  ((select r from t_result) ->> 'unknown_gender')::int, 0);
select pg_temp.check('資格が未確認でも部門から呼称が決まる',
  (select role_title from public.members where name_key = '早乙女鈴'), 'スタッフ');

-- 傘のかたち
create or replace function pg_temp.boss(p_key text)
returns text language sql stable as $fn$
  select mgr.full_name from public.members m
    left join public.members mgr on mgr.id = m.reports_to_id
   where m.name_key = p_key;
$fn$;

select pg_temp.check('統括MGは組織のトップ',       pg_temp.boss('東雲玲司'), null::text);
select pg_temp.check('MGは統括MGの下',             pg_temp.boss('西園寺円'), '東雲 玲司');
select pg_temp.check('統括院長はMGの下',           pg_temp.boss('南雲剛'),   '西園寺 円');
select pg_temp.check('院長は統括院長の下',         pg_temp.boss('北条隼'),   '南雲 剛');
select pg_temp.check('整体部門は院長の下',         pg_temp.boss('三日月湊'), '北条 隼');
select pg_temp.check('店長は院長の下',             pg_temp.boss('橘千尋'),   '北条 隼');

-- 兼務:上位の役職で配置し、自分を自分の上司にしない
select pg_temp.check('MG兼院長は統括MGの下',       pg_temp.boss('五十嵐湊'), '東雲 玲司');
select pg_temp.check('MG兼院長のランクはMG',
  (select rank::text from public.members where name_key = '五十嵐湊'), 'area');
select pg_temp.check('統括院長兼院長はMGの下',     pg_temp.boss('九条誠'),   '西園寺 円');
select pg_temp.check('統括院長不在の店のスタッフはMG兼院長の下',
  pg_temp.boss('相良陸'), '五十嵐 湊');
select pg_temp.check('兼務している人は1人だけ登録される',
  (select count(*)::int from public.members where name_key = '五十嵐湊'), 1);
select pg_temp.check('兼務は複数店舗の所属になる',
  (select count(*)::int from public.member_store_assignments a
     join public.members m on m.id = a.member_id where m.name_key = '五十嵐湊'), 3);

-- 資格から呼称が決まる
select pg_temp.check('鍼灸師の呼称',
  (select role_title from public.members where name_key = '伏見灯'), '鍼灸師');
select pg_temp.check('整体師の呼称',
  (select role_title from public.members where name_key = '綾瀬澪'), '整体師');
select pg_temp.check('柔道整復師の呼称',
  (select role_title from public.members where name_key = '三日月湊'), '柔道整復師');
select pg_temp.check('院長の呼称',
  (select role_title from public.members where name_key = '北条隼'), '院長');
select pg_temp.check('店長の呼称',
  (select role_title from public.members where name_key = '橘千尋'), '店長');
select pg_temp.check('旧姓つきの氏名がそのまま入る',
  (select full_name from public.members where name_key = '早乙女鈴'), '早乙女(桐生) 鈴');
select pg_temp.check('旧姓が別に記録される',
  (select former_name from public.members where name_key = '早乙女鈴'), '桐生');

-- 店舗の責任者列
select pg_temp.check('店舗に院長が設定される',
  (select director from public.v_store_roster where name = 'テスト青葉院'), '北条 隼');
select pg_temp.check('店舗に統括院長が設定される',
  (select chief_director from public.v_store_roster where name = 'テスト白鷺院'), '南雲 剛');
select pg_temp.check('統括院長がいない店舗は空のまま',
  (select chief_director from public.v_store_roster where name = 'テスト麒麟院'), null::text);
select pg_temp.check('店舗に店長が設定される',
  (select beauty_manager from public.v_store_roster where name = 'テスト青葉院'), '橘 千尋');

-- 配下の計算
select pg_temp.check('統括MGの配下は15名',
  (select count(*)::int from app.subtree_ids(
     (select id from public.members where name_key = '東雲玲司'))), 15);
select pg_temp.check('院長の配下は整体2名+店長1名',
  (select count(*)::int from app.subtree_ids(
     (select id from public.members where name_key = '北条隼'))), 3);
select pg_temp.check('配下判定',
  app.is_descendant((select id from public.members where name_key = '三日月湊'),
                    (select id from public.members where name_key = '東雲玲司')), true);
select pg_temp.check('配下でない方向は偽',
  app.is_descendant((select id from public.members where name_key = '東雲玲司'),
                    (select id from public.members where name_key = '三日月湊')), false);

-- ------------------------------------------------------------
-- 5) 冪等性(2回流しても増えない)
-- ------------------------------------------------------------

create temp table t_before as
select (select count(*) from public.members) as members,
       (select count(*) from public.org_change_log) as logs;

create temp table t_result2 as
select public.import_roster_sheet($sheet$
					整体部門			受付スタッフ	美容部門
統括MG	MG	統括院長	店舗	院長					店長
東雲 玲司(男)	西園寺 円(女)	南雲 剛(男)	テスト青葉院	北条 隼(男)	三日月 湊(柔整/男)	白雪 花音(柔整/女)			橘 千尋(女)
			テスト白鷺院	南雲 剛(男)
		九条 誠(男)	テスト朱雀院	九条 誠(男)
	五十嵐 湊(男)	神楽 遙(男)	テスト玄武院	葛城 咲(女)	伏見 灯(鍼灸/女)	綾瀬 澪(整体/女)
		-	テスト麒麟院	五十嵐 湊(男)	真田 蒼(整体/女)	相良 陸(柔整/男)	早乙女(桐生) 鈴(女)
$sheet$, '{}'::jsonb, 'regression-test-2') as r;

select pg_temp.check('2回目は新規登録が発生しない',
  ((select r from t_result2) ->> 'members_created')::int, 0);
select pg_temp.check('2回目でメンバー数が変わらない',
  (select count(*)::int from public.members), (select members::int from t_before));
select pg_temp.check('2回目で上司の付け替えが起きない',
  (select count(*)::int from public.org_change_log), (select logs::int from t_before));

-- ------------------------------------------------------------
-- 6) 権限チェック(未ログインでは実行できない)
-- ------------------------------------------------------------

select pg_temp.check('未ログインは組織を編集できない', app.can_edit_org(), false);

do $blk$
begin
  perform public.import_roster_sheet_as_admin('dummy');
  raise exception 'NG 未ログインでも一括取込が実行できてしまった';
exception
  when insufficient_privilege then raise notice 'ok  未ログインの一括取込は拒否される';
end $blk$;

do $blk$
begin
  perform public.set_member_emails('[]'::jsonb);
  raise exception 'NG 未ログインでもメール設定が実行できてしまった';
exception
  when insufficient_privilege then raise notice 'ok  未ログインのメール設定は拒否される';
end $blk$;

do $blk$
begin
  perform public.link_member_accounts();
  raise exception 'NG 未ログインでもアカウント紐付けが実行できてしまった';
exception
  when insufficient_privilege then raise notice 'ok  未ログインのアカウント紐付けは拒否される';
end $blk$;

-- ------------------------------------------------------------
-- 7) 循環参照ガード
-- ------------------------------------------------------------

do $blk$
declare v_top uuid; v_mg uuid;
begin
  select id into v_top from public.members where name_key = '東雲玲司';
  select id into v_mg  from public.members where name_key = '西園寺円';
  update public.members set reports_to_id = v_mg where id = v_top;   -- 西園寺→東雲→西園寺 の輪
  raise exception 'NG 循環参照が作れてしまった';
exception
  when check_violation then raise notice 'ok  循環参照は弾かれる';
end $blk$;

do $blk$
declare v_id uuid;
begin
  select id into v_id from public.members where name_key = '北条隼';
  update public.members set reports_to_id = v_id where id = v_id;    -- 自分が自分の上司
  raise exception 'NG 自分を上司にできてしまった';
exception
  when check_violation then raise notice 'ok  自分を上司にはできない';
end $blk$;

-- ------------------------------------------------------------

do $blk$ begin raise notice '----------------------------------------'; end $blk$;
do $blk$ begin raise notice 'すべて成功しました'; end $blk$;

rollback;   -- テストデータは残さない
