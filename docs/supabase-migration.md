# Supabase 本番移行 — メンバーと組織図の登録

くまのみ統合ポータルを localStorage のデモから Supabase に載せ替えるための第1段階です。
**店舗・メンバー・組織図(誰が誰の下か)** をスプレッドシートから SQL で一括登録できるようにしています。

日々の勤怠・日報・予約などのテーブルはこの上に乗せていく想定で、
権限(RLS)の形はすでにこの段階で `js/auth.js` と揃えてあります。

---

## 1. 何が入っているか

```
supabase/
  migrations/
    0001_core_schema.sql    店舗・メンバー・所属・メンター・変更履歴
    0002_org_views.sql      組織ツリーのビューと判定関数(配下・可視範囲・管轄店舗)
    0003_roster_import.sql  組織図シート(TSV)の一括取込
    0004_rls.sql            行レベルセキュリティ
    0005_accounts.sql       社員アカウント(auth.users)との紐付け
    0006_app_bridge.sql     アプリとの橋渡し(安定キー・所属コード・社員番号の採番)
  seed/
    roster_sheet.tsv        組織図シートそのもの(ここを直すのが一番早い)
    0001_roster.sql         上のシートを埋め込んだ実行用SQL
  tests/
    roster_import_test.sql  取込の回帰テスト(53件)
js/
  supabase.js               接続レイヤー(依存ゼロ・未設定ならデモモード)
  store.js                  データ入口(画面はここだけを見る)
  sync.js                   背面同期(送信キュー・取得・再送)
  remote.js                 コレクション ⇄ テーブルの対応表
  login.js                  ログイン画面と、名簿との突き合わせ
  roster.js                 シート解釈エンジン(SQL側と同じ判定をブラウザでも行う)
  pages/orgimport.js        「メンバー・組織図の一括登録」画面
scripts/
  gen-config.js             環境変数から config.js を生成(Vercel のビルドコマンド)
```

---

## 2. セットアップ

### 2-1. マイグレーションを流す

Supabase ダッシュボードの **SQL Editor** に `0001` から順に貼って実行するか、
CLI があれば次のとおりです。

```bash
# Supabase CLI の場合
supabase db push

# 直接つなぐ場合(Settings → Database → Connection string)
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

### 2-2. 組織図を登録する

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/0001_roster.sql
```

結果が JSON で返ります。

```json
{
  "rows": 23,
  "roots": ["日野 碧人"],
  "orphans": [],
  "stores_created": 23,
  "members_created": 103,
  "assignments": 157,
  "unknown_license": 46,
  "unknown_gender": 0,
  "duplicate_names": []
}
```

見るべきは次の 3 つです。

| 項目 | 意味 | あるべき状態 |
|---|---|---|
| `roots` | 組織のトップ | 統括MG が 1 人だけ |
| `orphans` | 上司が付かなかった人 | 空 |
| `duplicate_names` | 同姓同名の疑い | 空(あれば `@2` で区別する) |

### 2-3. 確認する

```sql
-- 組織ツリー(インデント付き)
select repeat('  ', depth) || full_name || ' 【' || role_title || '】'
  from public.v_org_tree order by sort_path, name_path;

-- 店舗ごとの体制表 — 元のシートと同じ並びに戻して検算する
select * from public.v_store_roster order by name;

-- 資格・性別が未確認のまま残っている人
select full_name, store_name, role_title, license, gender
  from public.v_member_directory
 where license = 'unknown' or gender = 'unknown'
 order by store_name, full_name;
```

### 2-4. テスト

```bash
# 空のDBに 0001〜0006 を適用してから
psql "$TEST_DATABASE_URL" -f supabase/tests/roster_import_test.sql
```

`すべて成功しました` が出れば OK です。テストは最後に `rollback` するのでデータは残りません。

---

## 3. シートの書き方

貼り付ける表は、いまお使いの組織図スプレッドシートそのままで構いません。

```
                              整体部門                       受付スタッフ  美容部門
統括MG   MG        統括院長    店舗          院長                                      店長
日野 碧人 竹内 香織  小村 将真   越谷駅前院    嶋田 勇輝  福井 仁太  佐藤 真夢            増渕 香澄
                              新三郷院      小村 将真
```

### 見出し

`統括MG / MG / 統括院長 / 店舗 / 院長 / 整体部門 / 受付スタッフ / 店長 / 美容部門`
を見出しから探して列の役割を決めます。

- **1行見出しでも2行見出し(部門グループ+列名)でも自動で判別します**
- 列の並び順・部門ごとの列数が変わっても、見出しさえ合っていれば直す必要はありません
- 「院名」「拠点」「エリア長」など、よくある言い換えも認識します

### 結合セル

`統括MG` `MG` `統括院長` は空欄なら **上の行の値を引き継ぎます**(結合セルと同じ扱い)。

その階層が **いない** 店舗は、空欄ではなく **`-`** を入れてください。
空欄だと「上と同じ」の意味になってしまいます。

```
   松本 英樹   前田 耕作   池袋東口院    仁藤 雄斗     ← 統括院長=前田
   松本 英樹   -          アリオ鷲宮院  松本 英樹     ← 統括院長は不在
```

### 氏名セル

| 書き方 | 解釈 |
|---|---|
| `福井 仁太` | 資格・性別は「未確認」 |
| `福井 仁太(柔整/男)` | 末尾の括弧が資格・性別トークンだけなら注記として解釈 |
| `浅見(山村) 彩雅` | トークン以外の括弧は**旧姓**。氏名はそのまま保持する |
| `佐藤 真夢@2` | 同姓同名の別人。`@` 以降は DB の氏名には入らない |
| `-` / `なし` / 空欄 | 人はいない |

使えるトークン:

- 資格 … `柔整` `鍼灸` `整体` `エステ` `受付` `無資格`
- 性別 … `男` `女`

### 店舗の区分

店舗名から `美容・エステ` / `鍼灸院` / `整体院` / `整骨院` を推測します。
明示したいときは見出しに `区分` の列を足してください。
区分によって責任者の呼称が `院長` / `店長` に切り替わります。

---

## 4. 傘(上司)の決まり方

役割ごとに上司候補を順に見て、**自分自身でない最初の1人**を上司にします。

| その人の役割 | 上司の候補(左から順に) |
|---|---|
| 統括MG | (なし=組織のトップ) |
| MG | 統括MG |
| 統括院長 | MG → 統括MG |
| 院長 | 統括院長 → MG → 統括MG |
| 店長 | 院長 → 統括院長 → MG → 統括MG |
| 整体部門・受付 | 院長 → 統括院長 → MG → 統括MG |
| 美容部門 | 店長 → 院長 → 統括院長 → MG → 統括MG |

**兼務している人は1人にまとめ、いちばん上位の役職で配置します。**

例:松本 英樹さんは MG であり アリオ鷲宮院の院長でもあります。

- 松本さん本人 … MG として **統括MG の下**(院長としての上司=自分、は飛ばす)
- アリオ鷲宮院のスタッフ … 院長である **松本さんの下**

同じ理由で、日野 碧人さん(統括MG 兼 MG)は組織のトップになります。

---

## 5. 画面から登録する

`組織運営 → メンバー・組織図の一括登録` を開きます(統括マネージャー以上・本部人事のみ)。

1. **STEP 1** スプレッドシートで範囲を選択 → コピー → 貼り付け欄に貼る
2. **STEP 2** セルの色を資格・性別に対応づける
3. **STEP 3** 取り込む内容を確認・手直しする
4. **STEP 4** SQL をコピー/ダウンロード、または Supabase に直接登録

### 色から資格・性別を読む

**スプレッドシートから直接コピーすると、セルの背景色と文字色も一緒に取り込みます。**
テキストファイル経由では色が失われるので、この方法が最も正確です。

- 背景色 → 資格(白=柔整師 / 緑=鍼灸師 / ピンク=整体師)
- 文字色 → 性別(青字=男性 / 赤字=女性)
- 結合セル(rowspan)もそのまま解決するので、`-` を書き足す必要がありません

実際に使われている色だけが STEP 2 に一覧表示され、自動判定はその場で直せます。
凡例にない色(水色・薄紫など)は決めつけず「未確認」にして、STEP 3 で個別に指定できます。

> **美容部門・受付スタッフは既定では色判定の対象外です。**
> 美容部門は「全員ピンク」のように部門ごとの塗り分けであることが多く、
> 資格の凡例とは別物だからです。同じ色を資格として使っている場合は、
> STEP 2 のチェックボックスで対象に含められます。

### 画面とSQLは同じ判定をする

`js/roster.js` と `supabase/migrations/0003_roster_import.sql` は同じ規則で実装しています。
プレビューに出ている内容が、そのまま登録される内容です。

---

## 6. 毎月の組織変更

管轄は毎月変わる前提です。運用は 2 通りあります。

**A. シートを貼り直す(大きく変わったとき)**

更新したシートを一括登録画面に貼って再実行します。氏名をキーに UPSERT するので、
同じ人が二重に登録されることはありません。

**B. 組織図ページでドラッグする(1〜2人動かすとき)**

`組織運営 → 組織図` でカードをドラッグすると上司が変わり、
`org_change_log` に履歴が残ります。ワンクリックで元に戻せます。

いずれの場合も変更は `org_change_log` に記録されます。

```sql
select l.changed_at, m.full_name,
       f.full_name as 変更前の上司, t.full_name as 変更後の上司, l.source
  from public.org_change_log l
  join public.members m on m.id = l.member_id
  left join public.members f on f.id = l.from_manager_id
  left join public.members t on t.id = l.to_manager_id
 order by l.changed_at desc limit 50;
```

### シートから消えた人を退職扱いにする

既定では**消えても何もしません**(誤って一部だけコピーした場合に全員が消えるのを防ぐため)。
差分を確認したうえで有効にしてください。

```sql
select public.import_roster_sheet($sheet$ … $sheet$,
  jsonb_build_object('deactivate_missing', true));
```

---

## 7. 社員アカウントを配る

組織図にはメールアドレスが無いので、氏名を橋渡しにして紐付けます。

```sql
-- 1) メールアドレスを登録する
select public.set_member_emails('[
  {"name": "日野 碧人", "email": "hino@example.co.jp"},
  {"name": "竹内 香織", "email": "takeuchi@example.co.jp"}
]'::jsonb);

-- 2) Supabase Auth で社員を招待する(ダッシュボード → Authentication → Invite)

-- 3) 突き合わせる。招待を受けた人から順に紐付く(何度実行してもよい)
select public.link_member_accounts();

-- 進捗を見る
select status, count(*) from public.v_account_status group by status;
```

`メール未登録` → `招待待ち` → `ログイン可` の順に進みます。

### 社員番号を振る(アプリ側の安定キー)

アプリは uuid ではなく **社員番号** で人を識別します(`js/remote.js` の `key: "employee_no"`)。
シートに番号が無い場合は、取込のあとに一度だけ採番してください。

```sql
select public.fill_employee_numbers();        -- 'K0001' 形式
select public.fill_employee_numbers('S', 3);  -- 'S001' 形式
-- 既に番号が入っている人は触りません。何度実行しても安全です。

-- 未採番が残っていないか確認
select count(*) from public.members where employee_no is null;
```

### ログイン

`config.js` に接続先が入っていれば、アプリは起動時にログイン画面を出します
(未設定のあいだはデモモードのままログイン不要)。

1. 社員がメールアドレスとパスワードでログイン
2. アプリが `public.me()` を呼び、自分が名簿のどの行かを社員番号で特定
3. その人の権限で画面が組み上がる

紐付いていないアカウントでログインすると、**別人として入らせず**に
「名簿と紐付いていません」と表示してログアウトします。
アクセストークンは期限が近づくと自動で更新されるので、
業務中に勝手にログアウトされることはありません。

---

## 8. 権限(RLS)

`js/auth.js` と同じ考え方を SQL 側にも置いています。

| 対象 | 閲覧 | 編集 |
|---|---|---|
| 店舗マスタ | 全社員 | 統括マネージャー以上・本部人事 |
| メンバー名簿 | 全社員 | 自分のプロフィールは本人 / それ以外は統括マネージャー以上・本部人事 |
| 所属・組織 | 全社員 | 統括マネージャー以上・本部人事 |
| メンター関係 | 全社員 | 院長・店長以上(自分の傘の中のみ) |
| 取込バッチ | 統括マネージャー以上・本部人事 | 同左 |

判定関数はすべて `app` スキーマにあり、PostgREST には公開されません。

| 関数 | 用途 |
|---|---|
| `app.current_member_id()` | `auth.uid()` → `members.id` |
| `app.subtree_ids(id)` | 配下全員 |
| `app.is_descendant(target, base)` | 傘の下にいるか |
| `app.managed_store_ids(id)` | シフト編集・勤怠承認ができる店舗 |
| `app.can_see_member(viewer, target)` | 日報などを見られるか(傘+メンター) |
| `app.can_edit_org()` | 組織を編集できるか |

一括取込 `import_roster_sheet()` は RLS を迂回する `security definer` なので、
`authenticated` からは実行できないようにしてあります。
画面からはランクを検査する `import_roster_sheet_as_admin()` を経由します。

---

## 9. 画面から Supabase につなぐ

ビルドツールも CDN も使わない方針のため、`js/supabase.js` は
PostgREST / GoTrue の REST API を `fetch` で直接叩く最小クライアントです。

設定は次の順に読み、どちらも無ければ**デモモード**(これまで通り localStorage だけ)で動きます。

1. `window.KUMANOMI_CONFIG` — `config.js` を置いて埋め込む(Git 管理外)
2. `localStorage["kumanomi.supabase"]` — 画面の「接続設定」から入力した値

**Vercel では手作業は要りません。** 環境変数を 2 つ入れると、
ビルド時に `scripts/gen-config.js` が `config.js` を書き出します。

| 変数名 | 値 |
| --- | --- |
| `SUPABASE_URL` | Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Settings → API → Project API keys → **anon public** |

ローカルで動かすときは同じスクリプトを手で実行します。

```bash
SUPABASE_URL=https://xxxxxxxx.supabase.co \
SUPABASE_ANON_KEY=eyJhbGciOi... \
node scripts/gen-config.js
```

> **`service_role` キーは絶対にブラウザに置かないでください。**
> RLS を迂回するキーなので、置いた時点で誰でも全データにアクセスできます。
> `scripts/gen-config.js` は `service_role` キーを渡されるとビルドを失敗させ、
> `js/supabase.js` は画面から入力されても保存を拒否します。

### データの流れ

画面は `js/store.js` だけを見ます。localStorage も Supabase も直接は触りません。

- 入力はまず端末に保存され、送信は `js/sync.js` が裏で行います(電波が切れても操作を続けられます)
- 更新は **変えた項目だけ** を PATCH で送るので、同じレコードを別々の項目で直しても打ち消し合いません
- どのコレクションがサーバー化済みかは `js/remote.js` の `REMOTE` / `PENDING_TABLES` を見てください

---

## 10. 添付の組織図から起こしたデータについて

`supabase/seed/roster_sheet.tsv` は、共有いただいた組織図の画像から書き起こしたものです。
**本番に入れる前に、次の点を実データで確認してください。**

1. **資格・性別** — 画像のセル色・文字色から読み取った暫定値です。
   一括登録画面にスプレッドシートを直接貼り付ければ、色から正確に取り込めます。
2. **「店長」列の範囲** — 美容部門の先頭の人を店長として読んでいます
   (越谷駅前院=増渕さん、熊谷=台さん、上尾=三橋さん、川越駅前=瀧本さん、大宮駅前=野田さん)。
   店長不在の店舗があれば、その列を空にしてください。
3. **最終行** — 画像の一番下の行(大宮駅前院の次)は見切れていたため入っていません。
   シートに追記して再実行してください。
4. **統括院長の担当範囲** — 結合セルの範囲が画像から読み取りにくい箇所がありました。
   スプレッドシートから直接コピーすれば結合セルは正確に解決されます。

資格・性別だけを未確認に戻したいときは次のとおりです。

```sql
update public.members set license = 'unknown', gender = 'unknown';
```

---

## 11. 次のステップ

この上に載せていくテーブルの想定です。RLS は `app.can_see_member()` と
`app.managed_store_ids()` を使えば同じ形で書けます。

アプリ側の受け口(`js/sync.js` の送信キューと取得)は共通なので、
テーブルを作って `js/remote.js` の `REMOTE` に 1 行足せば、その画面はサーバー化されます。

1. 勤怠 `attendance` — 店舗の GPS(`stores.lat/lng/radius_m`)で打刻を判定
2. シフト `shifts` / `shift_requests` — 編集は `app.managed_store_ids()` の範囲
3. 日報 `daily_reports` — 閲覧は `app.can_see_member()`
4. 患者・カルテ — 出勤打刻との連動、店舗単位の分離。**要配慮個人情報**のため取扱方針を別途定める
5. 画像(経費レシート・姿勢分析写真)を Supabase Storage へ
6. LINE Messaging API 連携、mPOP レジ連携

現在の進捗は 2 / 35 コレクション(`stores` / `staff`)。
アプリの「接続とデータ」画面でも確認できます。
