-- ============================================================
-- くまのみ 統合ポータル — シード:スタッフ名簿の一括登録(ひな形)
--
-- 元データ:人事のスタッフ名簿スプレッドシート
--           (状態 / 社員番号 / 姓 / 名 / 性別 / 役職 / 店舗… / メール)
--
-- ------------------------------------------------------------
-- ⚠ このファイルはひな形です
-- ------------------------------------------------------------
-- 実際の名簿は全社員の氏名とメールアドレスを含むので、リポジトリには入れません。
-- 手元で次のように使ってください。
--
--   cp supabase/seed/0002_staff.sql supabase/seed/0002_staff.local.sql
--   # $sheet$ … $sheet$ の中身を、スプレッドシートからコピーして貼り替える
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/0002_staff.local.sql
--
-- *.local.sql は .gitignore に入れてあるのでコミットされません。
-- Supabase の SQL Editor に直接貼って実行してもかまいません。
--
-- 前提:supabase/migrations/0001〜0012 を適用済みであること
--      (まだなら supabase/setup.sql を先に流す)
--
-- 何度実行しても同じ状態になる。名簿が変わったら貼り替えて実行し直すだけでよい。
--
-- ------------------------------------------------------------
-- 実行前に読むこと
-- ------------------------------------------------------------
--   * 貼り付けた内容は先に確認できる:
--       select * from public.preview_staff_sheet($sheet$ …同じ内容… $sheet$);
--     matched_to が空の行は新しく作られる人、unknown_store は名簿に無い店舗。
--   * シートの店舗名(越谷院)と名簿の正式名称(越谷駅前院)の対応は
--     public.store_aliases にある。ずれていたらそこを直す。
--   * 資格(柔整/鍼灸/整体)と部門(整体/受付/美容)はこのシートに無いので触らない。
--     組織図シートの取込(0001_roster.sql)で入った値がそのまま残る。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 別表記の読み替え(必要なときだけ)
--    組織図シートと人事名簿で字そのものが違う人を、同じ人として重ねる。
--    異体字(渡邉/渡邊、髙/高、﨑/崎 など)は app.name_fold が自動で吸収するので、
--    ここに書くのはそれ以外だけ。alias_key / name_key は空白を除いた氏名。
--    ⚠ 同一人物かどうかは人事データで必ず確認すること。
-- ------------------------------------------------------------
-- insert into public.member_name_aliases (alias_key, name_key, note) values
--   ('シートの氏名', '名簿の氏名', '同一人物と確認済み')
-- on conflict (alias_key) do update
--   set name_key = excluded.name_key, note = excluded.note;

-- ------------------------------------------------------------
-- 2. 名簿の取込
--    スプレッドシートから範囲コピーして、$sheet$ と $sheet$ の間に貼る。
--    貼らずに実行すると「取り込める行がありませんでした」で止まるだけで、
--    データは何も変わらない。
--
--    書き方の見本(タブ区切り。見出し行はあってもなくてもよい):
--
--      状態	社員番号	姓	名	性別	役職	店舗	店舗	店舗	メール
--      	E001	山田	太郎	男性	マネージャー	上尾院	アリオ上尾院	川口駅前院	yamada@example.co.jp
--      	E002	鈴木	花子	女性	院長	上尾院			suzuki@example.co.jp
--      	E003	佐藤	次郎	男性	一般社員	上尾院			sato@example.co.jp
--      	E004	高橋	三郎	男性	本部				takahashi@example.co.jp
--      育休中	E005	田中	桜	女性					tanaka@example.co.jp
--
--    ・店舗の列は 1 列目が主たる所属、2 列目以降が兼務
--    ・役職が空欄の人はランクも呼称も今のまま(育休中の人など)
--    ・状態の欄に書いた文字(育休中 など)はメンバーの備考に入る
-- ------------------------------------------------------------
select jsonb_pretty(public.import_staff_sheet(
  $sheet$
  -- ここにスプレッドシートの内容を貼る
  $sheet$,
  jsonb_build_object(
    -- 名簿に無い店舗をその名前で作る
    'create_missing_stores', true,
    -- true にすると、このシートに載っていない在籍者を退職扱いにする。
    -- 初回は false のままにして、戻り値の not_in_sheet を確認してから有効にすること。
    'deactivate_missing', false,
    -- 上司が空欄の人だけ、主所属の店舗にいる院長→統括院長→MG の順でつなぐ
    'link_managers', true,
    -- 店舗の院長・統括院長・MG 列も名簿から書き換える。
    -- 組織図シートの取込(0001_roster.sql)と食い違うので既定は false。
    'set_store_leaders', false,
    -- 名前から推測できない店舗のカテゴリ
    'default_category', '整骨院'
  ),
  'スタッフ名簿スプレッドシート'
));

-- ------------------------------------------------------------
-- 3. 取り込み結果の確認
-- ------------------------------------------------------------

-- 1) 店舗ごとの人数(元のシートと突き合わせる)
--   select s.name, count(*) from public.members m
--     join public.stores s on s.id = m.primary_store_id
--    where m.is_active group by s.name order by s.name;

-- 2) 社員番号が入っていない在籍者(名簿に載っていない人)
--   select full_name, role_title from public.members
--    where is_active and employee_no is null order by full_name;

-- 3) 上司が付いていない人(社長・統括MG・本部を除く)
--   select full_name, role_title from public.members
--    where is_active and reports_to_id is null
--      and rank not in ('ceo', 'exec', 'hr', 'clerk');

-- 4) アカウント発行の進みぐあい
--   select status, count(*) from public.v_account_status group by status;

-- ------------------------------------------------------------
-- 4. このあとやること
-- ------------------------------------------------------------
--   1. Supabase Auth で社員を招待する(ダッシュボード / Admin API)
--   2. select public.link_member_accounts();   -- 名簿とログインを紐付ける
