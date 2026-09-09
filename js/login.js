/* ============================================================
   ログイン画面

   Supabase の接続先が設定されているときだけ出る。
   未設定(デモモード)では、これまで通りログイン無しで開く。

   ログインしたあとの流れ:
     1. GoTrue でトークンを得る          … supabase.signIn()
     2. 自分が名簿のどの行かを聞く        … public.me()(0005 / 0006)
     3. 社員番号でアプリ側の自分を決める  … store.switchUser()

   auth.users と members が紐付いていない場合は、そのことを
   はっきり伝える。黙って別人として入らせないため。
   ============================================================ */

import { supabase } from "./supabase.js";
import { store } from "./store.js";
import { el, icon, clear } from "./ui.js";

/** ログイン画面を出す必要があるか */
export function needsLogin() {
  return supabase.isConfigured() && !supabase.user();
}

/**
 * ログイン後に「自分が誰か」を確定させる。
 * 返り値: { ok, staffId, reason }
 */
export async function resolveMe() {
  let profile = null;
  try {
    profile = await supabase.rpc("me");
  } catch (err) {
    // me() がまだ無いスキーマでも動くように、メールで照合する道を残す
    console.warn("[login] me() を呼べませんでした。メールで照合します:", err);
  }

  await store.load("staff", "stores");
  const list = store.get("staff") || [];

  const key = profile?.employee_no || null;
  if (key) {
    const hit = list.find((s) => s.id === key || s.empCode === key);
    if (hit) return { ok: true, staffId: hit.id, profile };
    return { ok: false, reason: "notInDirectory", profile };
  }

  // me() が null = auth ユーザーが名簿と紐付いていない
  if (profile === null) return { ok: false, reason: "notLinked" };

  const email = (supabase.user()?.email || "").toLowerCase();
  const byMail = email ? list.find((s) => (s.email || "").toLowerCase() === email) : null;
  if (byMail) return { ok: true, staffId: byMail.id };
  return { ok: false, reason: "notLinked" };
}

const REASON_TEXT = {
  notLinked:
    "ログインはできましたが、このアカウントがまだ社員名簿と紐付いていません。管理者に「メンバー・組織図の一括登録」からの紐付けを依頼してください。",
  notInDirectory:
    "社員名簿にあなたの行が見つかりませんでした。名簿の取り込みが済んでいない可能性があります。管理者にご連絡ください。",
};

/**
 * ログイン画面を描く。
 * @param {HTMLElement} host  画面全体の入れ物(#app)
 * @param {(staffId:string)=>void} onSignedIn  ログイン成功時
 */
export function renderLogin(host, onSignedIn) {
  const msg = el("p", { class: "lg-msg", role: "alert", hidden: true });
  const mail = el("input", {
    type: "email", id: "lg-mail", autocomplete: "username",
    placeholder: "you@kumanomi.co.jp", required: true,
  });
  const pass = el("input", {
    type: "password", id: "lg-pass", autocomplete: "current-password",
    placeholder: "パスワード", required: true,
  });
  const submit = el("button", { class: "btn primary lg block", type: "submit" }, "ログイン");

  const showError = (text) => {
    msg.hidden = false;
    msg.dataset.tone = "bad";
    clear(msg).append(icon("alert", 15), el("span", {}, text));
  };
  const showInfo = (text) => {
    msg.hidden = false;
    msg.dataset.tone = "info";
    clear(msg).append(icon("info", 15), el("span", {}, text));
  };

  const form = el("form", {
    class: "lg-form", novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      const email = mail.value.trim();
      if (!email || !pass.value) { showError("メールアドレスとパスワードを入力してください。"); return; }

      submit.disabled = true;
      clear(submit).append(icon("refresh", 16), "確認しています…");
      submit.classList.add("busy");
      msg.hidden = true;

      try {
        await supabase.signIn(email, pass.value);
      } catch (err) {
        submit.disabled = false;
        submit.classList.remove("busy");
        clear(submit).append("ログイン");
        const raw = String(err?.message || err);
        showError(/Invalid login|invalid_grant/i.test(raw)
          ? "メールアドレスまたはパスワードが違います。"
          : /接続できません/.test(raw)
            ? "サーバーに接続できませんでした。通信環境をご確認ください。"
            : raw);
        pass.select();
        return;
      }

      const who = await resolveMe();
      if (!who.ok) {
        await supabase.signOut();
        submit.disabled = false;
        submit.classList.remove("busy");
        clear(submit).append("ログイン");
        showError(REASON_TEXT[who.reason] || "アカウントの確認ができませんでした。");
        return;
      }
      onSignedIn(who.staffId);
    },
  },
    el("div", { class: "lg-field" },
      el("label", { for: "lg-mail" }, "メールアドレス"), mail),
    el("div", { class: "lg-field" },
      el("label", { for: "lg-pass" }, "パスワード"), pass),
    msg,
    submit,
  );

  const info = supabase.info();

  const card = el("div", { class: "lg-card" },
    el("img", { class: "lg-logo", src: "assets/kumanomi-wide.png", alt: "くまのみ 整骨院・整体院グループ" }),
    el("h1", { class: "lg-title" }, "統合ポータル"),
    el("p", { class: "lg-lead" }, "社員アカウントでログインしてください。"),
    form,
    // 接続先が設定されているときは、見せられるデモデータがそもそも無い
    // (本番では記録を空から始めるため)。逃げ道は出さない。
    el("div", { class: "lg-foot" },
      el("p", { class: "lg-host" }, info ? `接続先 ${info.url.replace(/^https?:\/\//, "")}` : ""),
    ),
  );

  clear(host).append(
    el("div", { class: "login-screen" },
      el("div", { class: "lg-sea" },
        el("span", { class: "bub b1" }), el("span", { class: "bub b2" }), el("span", { class: "bub b3" })),
      card));

  // ログイン画面ではアプリのレイアウト(サイドバー等)を効かせない
  host.classList.add("is-login");
  setTimeout(() => mail.focus(), 60);
}

/** ログイン画面を閉じるときの後片付け */
export function teardownLogin(host) { host.classList.remove("is-login"); }

/** ログアウトして最初からやり直す */
export async function signOutAndReload() {
  await supabase.signOut();
  location.reload();
}
