/* ============================================================
   Supabase 接続設定のひな形

   このファイルを config.js としてコピーし、index.html の
   <script type="module" src="js/app.js"> より前に読み込んでください。

     <script src="config.js"></script>

   config.js は .gitignore で除外しています(キーをコミットしないため)。
   設定しなければアプリはデモモード(localStorage のみ)で動きます。

   ※ service_role キーは絶対にここへ書かないこと。
      RLS を迂回するキーなので、置いた時点で誰でも全データにアクセスできます。
      ブラウザに置いてよいのは anon (public) キーだけです。
   ============================================================ */

window.KUMANOMI_CONFIG = {
  // Supabase ダッシュボード → Settings → API → Project URL
  url: "https://xxxxxxxx.supabase.co",
  // 同 → Project API keys → anon public
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
};
