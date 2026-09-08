#!/usr/bin/env node
/* ============================================================
   config.js を環境変数から生成する(Vercel のビルドコマンド)

   このアプリはビルドツールを使わない方針のため、
   「デプロイのたびに 1 ファイルだけ書き出す」この小さな Node
   スクリプトが唯一のビルド工程になる。

     Vercel → Settings → Environment Variables
       SUPABASE_URL       https://xxxxxxxx.supabase.co
       SUPABASE_ANON_KEY  eyJhbGciOi...(anon / public キー)

   ローカルでも同じコマンドで動く:
     SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/gen-config.js
   環境変数なしで実行すると「デモモードの config.js」を書き出すので、
   ローカル開発では引数なしで一度実行しておけばよい。

   ※ service_role キーを渡した場合はビルドを失敗させる。
      RLS を迂回するキーなので、ブラウザに配ってはいけない。
   ============================================================ */

const fs = require("node:fs");
const path = require("node:path");

const OUT = path.resolve(__dirname, "..", "config.js");

/* 環境変数名のゆれを吸収する(他ホスティングからの移設を楽にするため) */
const URL_KEYS = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL", "PUBLIC_SUPABASE_URL"];
const KEY_KEYS = ["SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY", "PUBLIC_SUPABASE_ANON_KEY"];

function pick(names) {
  for (const n of names) {
    const v = (process.env[n] || "").trim();
    if (v) return { name: n, value: v };
  }
  return null;
}

/** JWT の payload を覗いて service_role キーを見分ける */
function roleOf(jwt) {
  const parts = String(jwt).split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json).role || null;
  } catch {
    return null;
  }
}

function banner() {
  return [
    "/* このファイルは scripts/gen-config.js が自動生成しています。",
    "   直接編集しても次のデプロイで上書きされます。",
    `   生成: ${new Date().toISOString()} */`,
  ].join("\n");
}

function writeDemo(reason) {
  fs.writeFileSync(OUT, `${banner()}\n// ${reason}\nwindow.KUMANOMI_CONFIG = null;\n`, "utf8");
}

function main() {
  const url = pick(URL_KEYS);
  const key = pick(KEY_KEYS);

  if (!url || !key) {
    const missing = [!url && URL_KEYS[0], !key && KEY_KEYS[0]].filter(Boolean).join(" / ");
    const reason = `環境変数(${missing})が未設定のためデモモードで生成しました。`;
    if (process.env.KUMANOMI_REQUIRE_SUPABASE === "1") {
      console.error(`[gen-config] ${reason} KUMANOMI_REQUIRE_SUPABASE=1 のためビルドを中止します。`);
      process.exit(1);
    }
    writeDemo(reason);
    console.warn(`[gen-config] ${reason}`);
    console.warn("[gen-config] Supabase につなぐには Vercel の環境変数に SUPABASE_URL と SUPABASE_ANON_KEY を設定してください。");
    return;
  }

  if (!/^https:\/\/[^/\s]+/.test(url.value)) {
    console.error(`[gen-config] ${url.name} は https:// から始まるプロジェクトURLを指定してください(現在: ${url.value.slice(0, 40)})。`);
    process.exit(1);
  }

  const role = roleOf(key.value);
  if (role === "service_role") {
    console.error(`[gen-config] ${key.name} に service_role キーが設定されています。`);
    console.error("[gen-config] service_role キーは RLS を迂回するため、ブラウザに配ると全データが誰にでも読めてしまいます。");
    console.error("[gen-config] Supabase ダッシュボード → Settings → API → anon (public) キーに差し替えてください。");
    process.exit(1);
  }
  if (role && role !== "anon") {
    console.warn(`[gen-config] ${key.name} の role が "${role}" です。anon (public) キーかどうか確認してください。`);
  }

  const cfg = { url: url.value.replace(/\/+$/, ""), anonKey: key.value };
  fs.writeFileSync(OUT, `${banner()}\nwindow.KUMANOMI_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`, "utf8");
  console.log(`[gen-config] ${path.relative(process.cwd(), OUT)} を生成しました(${cfg.url} / anon キー末尾 …${cfg.anonKey.slice(-6)})。`);
}

main();
