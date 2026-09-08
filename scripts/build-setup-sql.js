#!/usr/bin/env node
/* ============================================================
   supabase/setup.sql を組み立てる

   マイグレーション(supabase/migrations/*.sql)を正本として、
   Supabase の SQL Editor に一度で貼れる 1 ファイルにまとめる。

     node scripts/build-setup-sql.js

   マイグレーションを直したら、このコマンドを実行して
   setup.sql を作り直すこと(`--check` で差分の有無だけ確認できる)。

   なぜ 2 つ持つのか:
     ・migrations/  … 既に動いている DB に「差分だけ」当てるため
     ・setup.sql    … これから作る DB に「一度で」当てるため
   中身は同じで、setup.sql はここから自動生成する。
   ============================================================ */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MIG_DIR = path.join(ROOT, "supabase", "migrations");
const OUT = path.join(ROOT, "supabase", "setup.sql");

const HEADER = `-- ============================================================
-- くまのみ 統合ポータル — セットアップ SQL(全部入り)
--
-- このファイルは scripts/build-setup-sql.js が
-- supabase/migrations/*.sql から自動生成しています。
-- 直接編集せず、マイグレーション側を直してから作り直してください。
--
--   node scripts/build-setup-sql.js
--
-- ------------------------------------------------------------
-- 使い方(どちらか一方でよい)
--
--   A. Supabase ダッシュボード
--      SQL Editor を開き、このファイルの中身を全部貼って Run。
--      1 回で店舗・メンバー・組織図・権限・勤怠・シフト・希望休・日報が
--      すべて出来上がります。
--
--   B. psql
--      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/setup.sql
--
-- ------------------------------------------------------------
-- 何度実行しても壊れません(作成済みのものは飛ばします)。
-- スキーマだけを作ります。組織図データの取り込みは
--   supabase/seed/0001_roster.sql
-- を続けて実行するか、画面の「メンバー・組織図の一括登録」から行ってください。
--
-- 実行後にやること:
--   1. select public.fill_employee_numbers();   -- 社員番号を振る
--   2. select public.set_member_emails('[...]'); -- メールを登録
--   3. Supabase Auth で社員を招待
--   4. select public.link_member_accounts();     -- アカウントと名簿を紐付け
-- 詳しくは docs/supabase-migration.md を参照。
-- ============================================================

`;

function build() {
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
  if (!files.length) throw new Error(`マイグレーションが見つかりません: ${MIG_DIR}`);

  const parts = [HEADER];
  parts.push("-- 収録しているマイグレーション\n");
  for (const f of files) parts.push(`--   ${f}\n`);
  parts.push("\n");

  for (const f of files) {
    const body = fs.readFileSync(path.join(MIG_DIR, f), "utf8").replace(/\s+$/, "");
    parts.push(
      "\n-- ############################################################\n" +
      `-- # ${f}\n` +
      "-- ############################################################\n\n" +
      body + "\n"
    );
  }

  return { text: parts.join(""), files };
}

function main() {
  const { text, files } = build();
  const check = process.argv.includes("--check");
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;

  if (check) {
    if (current === text) {
      console.log(`[build-setup-sql] setup.sql は最新です(${files.length} ファイル)。`);
      return;
    }
    console.error("[build-setup-sql] setup.sql がマイグレーションと食い違っています。");
    console.error("[build-setup-sql] `node scripts/build-setup-sql.js` を実行して作り直してください。");
    process.exit(1);
  }

  fs.writeFileSync(OUT, text, "utf8");
  const lines = text.split("\n").length;
  console.log(`[build-setup-sql] supabase/setup.sql を生成しました(${files.length} ファイル / ${lines} 行)。`);
  console.log(`[build-setup-sql] 収録: ${files.join(", ")}`);
}

main();
