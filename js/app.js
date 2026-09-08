/* ============================================================
   KUMANOMI App — シェル(サイドバー/トップバー)とページ登録
   ============================================================ */

import { store } from "./store.js";
import { router } from "./router.js";
import { el, icon, avatar, badge, toast, relTime, fmtDate, confirmDialog, drawer, clear } from "./ui.js";
import { canSeePage, rankLabel, scopeLabel, RANKS, rankOf } from "./auth.js";
import { syncAutoTasks } from "./autotasks.js";
import { supabase } from "./supabase.js";
import { migrationProgress, remoteCollections } from "./remote.js";
import { needsLogin, renderLogin, teardownLogin, isDemoBypass, signOutAndReload } from "./login.js";

import dashboard from "./pages/dashboard.js";
import sns from "./pages/sns.js";
import chat from "./pages/chat.js";
import nippo from "./pages/nippo.js";
import uriage from "./pages/uriage.js";
import kintai from "./pages/kintai.js";
import shift from "./pages/shift.js";
import reserve from "./pages/reserve.js";
import patients from "./pages/patients.js";
import staffPage from "./pages/staff.js";
import roleplay from "./pages/roleplay.js";
import meetings from "./pages/meetings.js";
import tasksPage from "./pages/tasks.js";
import backoffice from "./pages/backoffice.js";
import hr from "./pages/hr.js";
import payroll from "./pages/payroll.js";
import org from "./pages/org.js";
import orgimport from "./pages/orgimport.js";
import assistant from "./pages/assistant.js";

/* ---- ナビゲーション構成 ---- */
const NAV_GROUPS = [
  { label: "ホーム", pages: [dashboard] },
  { label: "コミュニケーション", pages: [chat, sns, meetings, tasksPage] },
  { label: "毎日の業務", pages: [nippo, uriage, kintai, shift] },
  { label: "患者様", pages: [reserve, patients] },
  { label: "組織運営", pages: [org, orgimport, staffPage, roleplay, backoffice, hr, payroll] },
  { label: "サポート", pages: [assistant] },
];

NAV_GROUPS.flatMap((g) => g.pages).forEach((p) => router.register(p));

/* ---- テーマ ---- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.setSetting("theme", theme);
}
const savedTheme = store.state.settings.theme || "light";
document.documentElement.dataset.theme = savedTheme;

/* ---- シェル構築 ---- */
const app = document.getElementById("app");

function buildShell() {
  const me = store.me();

  // --- Sidebar(権限で表示するページを絞る) ---
  const nav = el("nav", { class: "sidebar-nav" });
  for (const group of NAV_GROUPS) {
    const visible = group.pages.filter((p) => canSeePage(p.id, me));
    if (!visible.length) continue;
    nav.appendChild(el("div", { class: "nav-group-label" }, group.label));
    for (const p of visible) {
      const badgeCount = p.id === "chat"
        ? store.unreadChatCount()
        : p.id === "tasks"
          ? (store.get("tasks") || []).filter((t) => t.ownerId === me.id && t.status !== "done").length
          : 0;
      const item = el("button", {
        class: "nav-item", dataset: { page: p.id },
        onclick: () => { router.navigate(p.id); closeMobileNav(); },
      },
        el("span", { class: "nav-ic" }, icon(p.icon, 19)),
        el("span", { class: "nav-label" }, p.title),
        badgeCount > 0 ? el("span", { class: "nav-badge", dataset: { role: p.id === "chat" ? "chat-badge" : `${p.id}-badge` } }, String(badgeCount)) : null,
      );
      nav.appendChild(item);
    }
  }

  const sidebar = el("aside", { class: "sidebar" },
    el("button", {
      class: "sidebar-logo", "aria-label": "ダッシュボードへ",
      onclick: () => { router.navigate("dashboard"); closeMobileNav(); },
    },
      el("img", { class: "logo-lockup", src: "assets/kumanomi-wide.png", alt: "くまのみ 整骨院・整体院グループ" }),
      el("img", { class: "logo-mark", src: "assets/kumanomi-mark.png", alt: "" })),
    nav,
    el("div", { class: "sidebar-foot" },
      el("img", { class: "foot-fish", src: "assets/kumanomi-mark.png", alt: "" }),
      el("span", {}, "成増店 先行導入版 v1.0", el("br"), "SaaS一体化プロジェクト")),
  );

  // --- Topbar ---
  const titleEl = el("span", { class: "topbar-title" }, "ダッシュボード");
  const today = new Date();
  const dateEl = el("span", { class: "topbar-date" },
    `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日(${"日月火水木金土"[today.getDay()]})`);

  // --- グローバル検索 ---
  const searchWrap = el("div", { class: "topbar-search" });
  const searchInput = el("input", { type: "search", placeholder: "患者様・スタッフ・投稿を検索…", "aria-label": "検索" });
  const searchIc = el("span", { class: "search-ic" }, icon("search", 17));
  let resultsEl = null;
  const closeResults = () => { resultsEl?.remove(); resultsEl = null; };
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim();
    closeResults();
    if (q.length < 1) return;
    const hits = [];
    for (const p of store.get("patients")) {
      if (p.name.includes(q) || p.kana.includes(q) || p.tags.some((t) => t.includes(q)))
        hits.push({ kind: "患者", name: p.name, sub: `${store.storeName(p.storeId)}・${p.tags.join("/")}`, link: `patients/${p.id}` });
    }
    for (const s of store.get("staff")) {
      if (s.name.includes(q) || s.kana.includes(q))
        hits.push({ kind: "スタッフ", name: s.name, sub: `${store.storeName(s.storeId)}・${s.role}`, link: "staff" });
    }
    for (const po of store.get("posts")) {
      if ((po.title || "").includes(q) || po.body.includes(q))
        hits.push({ kind: "投稿", name: po.title || po.body.slice(0, 24), sub: relTime(po.date), link: "sns" });
    }
    if (!hits.length) return;
    resultsEl = el("div", { class: "search-results" },
      hits.slice(0, 8).map((h) => el("button", {
        class: "search-hit",
        onclick: () => { router.navigate(h.link); searchInput.value = ""; closeResults(); },
      },
        el("span", { class: "hit-kind" }, h.kind),
        el("span", {},
          el("span", { class: "hit-name", style: { display: "block" } }, h.name),
          el("span", { class: "hit-sub" }, h.sub)))));
    searchWrap.appendChild(resultsEl);
  });
  document.addEventListener("click", (e) => { if (!searchWrap.contains(e.target)) closeResults(); });
  searchWrap.append(searchIc, searchInput);

  // --- 通知 ---
  const bellBtn = el("button", { class: "icon-btn", "aria-label": "通知", onclick: openNotifications },
    icon("bell", 19),
    store.unreadCount() > 0 ? el("span", { class: "dot" }) : null);

  // --- テーマ切替 ---
  const themeBtn = el("button", { class: "icon-btn", "aria-label": "テーマ切替", onclick: () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    clear(themeBtn).appendChild(icon(next === "dark" ? "sun" : "moon", 19));
    router.render(); // チャート色をテーマに追従させる
  } }, icon(savedTheme === "dark" ? "sun" : "moon", 19));

  // --- 同期状態(言うことがあるときだけ出る) ---
  const syncChip = el("button", {
    class: "sync-chip", hidden: true, "aria-label": "同期の状態", onclick: openSyncPanel,
  });
  paintSyncChip(syncChip);
  store.onSync(() => paintSyncChip(syncChip));

  // --- 設定 ---
  const settingsBtn = el("button", { class: "icon-btn", "aria-label": "設定", onclick: openSyncPanel },
    icon("settings", 19));

  const userBtn = el("button", { class: "topbar-user", "aria-label": "ログインユーザーの切替", onclick: openUserSwitcher },
    avatar(me, 34),
    el("span", { class: "user-meta" },
      el("span", { class: "user-name" }, me.name),
      el("span", { class: "user-role" }, `${store.storeName(me.storeId)}・${me.role}`)),
    icon("chevD", 14));

  const mobileBtn = el("button", { class: "icon-btn mobile-nav-btn", "aria-label": "メニュー", onclick: () => app.classList.toggle("nav-open") }, icon("menu", 20));

  const topbar = el("header", { class: "topbar" },
    mobileBtn,
    el("span", {}, titleEl, el("br"), dateEl),
    searchWrap,
    el("div", { class: "topbar-actions" }, syncChip, bellBtn, themeBtn, settingsBtn, userBtn));

  const main = el("div", { class: "main", id: "outlet" });
  const scrim = el("div", { class: "mobile-scrim", onclick: closeMobileNav });

  clear(app).append(sidebar, topbar, main, scrim);

  return { titleEl, main, bellBtn };
}

function closeMobileNav() { app.classList.remove("nav-open"); }

/* ---- 本番ログイン中のアカウント画面(切替はできない) ---- */
function openAccountPanel(me) {
  const rows = [
    ["氏名", me.name],
    ["社員コード", me.empCode || me.id],
    ["所属", `${store.storeName(me.storeId)}・${me.role}`],
    ["権限", `${rankLabel(me)}(${scopeLabel(me)})`],
    ["メール", supabase.user()?.email || "—"],
  ];
  const d = drawer({
    title: "アカウント",
    body: el("div", { class: "sync-panel" },
      el("div", { class: "sp-kv" },
        rows.map(([k, v]) => el("div", { class: "sp-row" },
          el("span", { class: "sp-k" }, k),
          el("span", { class: "sp-v" }, String(v))))),
      el("div", { class: "sp-actions" },
        el("button", {
          class: "btn ghost",
          onclick: async () => {
            const ok = await confirmDialog({
              title: "ログアウト",
              message: "この端末からログアウトします。未送信の変更が残っている場合は、先に同期してください。",
              okLabel: "ログアウトする",
            });
            if (ok) { d.close(); await signOutAndReload(); }
          },
        }, icon("user", 16), "ログアウト")),
      el("div", { class: "sp-note" }, icon("info", 14),
        el("span", {}, "見える範囲は組織図(だれの傘の下にいるか)で決まります。変更は管理者にご依頼ください。"))),
  });
}

/* ---- 同期の状態表示 ----
   ふだんは何も出さない。伝えることがあるときだけチップを出す。 */
function syncLook() {
  const s = store.syncState();
  if (s.rejected > 0) return { tone: "bad", ic: "alert", text: `送信できず ${s.rejected}件` };
  if (s.mode === "offline") return { tone: "warn", ic: "alert", text: "オフライン" };
  if (s.state === "error") return { tone: "warn", ic: "refresh", text: "再送を待機中" };
  if (s.state === "syncing") return { tone: "busy", ic: "refresh", text: "同期中" };
  if (s.pending > 0) return { tone: "warn", ic: "clock", text: `未送信 ${s.pending}件` };
  return null;
}

function paintSyncChip(chip) {
  const look = syncLook();
  chip.hidden = !look;
  if (!look) return;
  chip.dataset.tone = look.tone;
  clear(chip).append(icon(look.ic, 14), el("span", {}, look.text));
}

/* ---- 接続とデータの設定 ---- */
function openSyncPanel() {
  const s = store.syncState();
  const info = supabase.info();
  const prog = migrationProgress();

  const modeLabel = { demo: "デモモード(端末内のみ)", online: "接続中", offline: "オフライン" }[s.mode] || s.mode;
  const rows = [
    ["接続先", info ? info.url : "未設定"],
    ["状態", modeLabel],
    ["ログイン", supabase.user()?.email || (info ? "未ログイン" : "—")],
    ["未送信の変更", `${s.pending}件`],
    ["送信できず", `${s.rejected}件`],
    ["最終同期", s.lastSyncAt ? relTime(s.lastSyncAt) : "—"],
    ["サーバー化済み", `${prog.done} / ${prog.total} コレクション(${remoteCollections().join("・")})`],
  ];

  const table = el("div", { class: "sp-kv" },
    rows.map(([k, v]) => el("div", { class: "sp-row" },
      el("span", { class: "sp-k" }, k),
      el("span", { class: "sp-v" }, String(v)))));

  const rejected = store.syncRejected();
  const rejectedCard = rejected.length
    ? el("div", { class: "card mt-12", style: { borderColor: "var(--critical)" } },
        el("div", { class: "card-title" }, `送信できなかった変更(${rejected.length}件)`),
        el("p", { class: "muted", style: { fontSize: "var(--fs-sm)" } },
          "権限や入力内容の問題で、サーバーに反映できませんでした。端末内には残っています。"),
        el("div", { class: "row-list" },
          rejected.slice(0, 8).map((r) => el("div", { class: "row-item" },
            el("span", { class: "row-main" },
              el("span", { class: "row-title" }, `${r.coll} / ${r.id}`),
              el("span", { class: "row-sub", style: { whiteSpace: "normal" } }, r.error))))),
        el("div", { class: "sp-actions" },
          el("button", {
            class: "btn ghost sm",
            onclick: () => { store.clearSyncRejected(); d.close(); toast("記録を消しました"); },
          }, "この記録を消す")))
    : null;

  const actions = el("div", { class: "sp-actions" },
    el("button", {
      class: "btn primary", disabled: s.mode !== "online",
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        await store.flushSync();
        await store.refresh();
        toast("同期しました", "success");
        d.close();
      },
    }, icon("refresh", 16), "今すぐ同期する"),
    el("button", {
      class: "btn ghost",
      onclick: async () => {
        const ok = await confirmDialog({
          title: "デモデータのリセット",
          message: "この端末で加えた変更(投稿・打刻・予約など)をすべて破棄して、初期状態に戻します。よろしいですか?",
          okLabel: "リセットする", danger: true,
        });
        if (ok) { store.reset(); location.reload(); }
      },
    }, icon("trash", 16), "デモデータをリセット"),
  );

  const note = el("div", { class: "sp-note" }, icon("info", 14),
    el("span", {}, s.mode === "demo"
      ? "Supabase の接続先が未設定のため、データはこの端末のなかだけに保存されています。Vercel の環境変数に SUPABASE_URL と SUPABASE_ANON_KEY を設定すると、サーバーとの同期が始まります。"
      : "入力はまず端末に保存され、通信は裏側で行われます。電波が切れても操作を続けられ、つながり次第まとめて送信されます。"));

  const d = drawer({
    title: "接続とデータ",
    body: el("div", { class: "sync-panel" }, table, rejectedCard, actions, note),
  });
}

/* ---- ログインユーザー切替(デモ用:権限の違いを体験できる) ----
   本番ログイン中は切り替えさせない。自分のアカウントとログアウトだけを出す。 */
function openUserSwitcher() {
  const me = store.me();
  if (supabase.user()) { openAccountPanel(me); return; }
  const order = { ceo: 0, exec: 1, area: 2, chief: 3, hr: 4, clerk: 5, manager: 6, mentor: 7, staff: 8 };
  const list = [...store.get("staff")].sort(
    (a, b) => (order[rankOf(a)] ?? 9) - (order[rankOf(b)] ?? 9) || a.id.localeCompare(b.id));

  const body = el("div", { class: "user-switch" },
    el("p", { class: "us-lead" },
      "権限によって見える情報が変わります。切り替えて動作をご確認ください。"),
    el("div", { class: "us-list" },
      list.map((s) => el("button", {
        class: `us-item ${s.id === me.id ? "on" : ""}`,
        onclick: () => {
          d.close();
          store.switchUser(s.id);
          rebuild();
          toast(`${s.name}さん(${rankLabel(s)})に切り替えました`, "info");
        },
      },
        avatar(s, 38),
        el("span", { class: "us-meta" },
          el("span", { class: "us-name" }, s.name,
            s.id === me.id ? badge("ログイン中", "brand") : null),
          el("span", { class: "us-role" }, `${store.storeName(s.storeId)}・${s.role}`),
          el("span", { class: "us-scope" }, icon("eye", 12), scopeLabel(s))),
        el("span", { class: "us-rank" }, RANKS[rankOf(s)]?.label || "スタッフ")))),
    el("div", { class: "us-note" },
      icon("info", 14),
      el("span", {}, "実運用では社員アカウントでのログインになります。この切替はデモ専用の機能です。")),
  );
  const d = drawer({ title: "ログインユーザーを切り替える", body });
}

/** ユーザー切替やデータ変更後にシェルとページを作り直す */
function rebuild() {
  const built = buildShell();
  titleRef.el = built.titleEl;
  router.init(built.main, onNavigate);
}

/* ---- 通知ドロワー ---- */
function openNotifications() {
  const list = el("div", { class: "row-list" });
  const items = [...store.get("notifications")].sort((a, b) => (a.date < b.date ? 1 : -1));
  const kindIc = { alert: "alert", info: "info", thanks: "gift", test: "grad" };
  for (const n of items) {
    list.appendChild(el("div", {
      class: "row-item clickable",
      style: n.read ? { opacity: 0.62 } : {},
      onclick: () => {
        store.update("notifications", n.id, { read: true });
        d.close();
        if (n.link) router.navigate(n.link.replace(/^#\//, ""));
      },
    },
      el("span", {
        class: "stat-ic",
        style: { width: "36px", height: "36px", borderRadius: "10px", background: n.type === "alert" ? "var(--critical-soft)" : "var(--brand-soft)", color: n.type === "alert" ? "var(--critical-text)" : "var(--brand-ink)", display: "grid", placeItems: "center", flex: "none" },
      }, icon(kindIc[n.type] || "info", 17)),
      el("span", { class: "row-main" },
        el("span", { class: "row-title", style: { whiteSpace: "normal" } }, n.title),
        el("span", { class: "row-sub", style: { whiteSpace: "normal" } }, n.body),
        el("span", { class: "small muted" }, relTime(n.date))),
      !n.read ? el("span", { style: { width: "9px", height: "9px", borderRadius: "50%", background: "var(--accent)", flex: "none" } }) : null,
    ));
  }
  const markAll = el("button", { class: "btn ghost sm", onclick: () => {
    store.get("notifications").forEach((n) => { n.read = true; });
    store.notify("notifications");
    d.close();
    refreshBell();
    toast("すべて既読にしました");
  } }, "すべて既読にする");
  const d = drawer({ title: `通知(未読 ${store.unreadCount()}件)`, body: el("div", {}, el("div", { class: "mb-12", style: { textAlign: "right" } }, markAll), list) });
}

/* ---- 起動 ---- */
const titleRef = { el: null };

function onNavigate(page) {
  if (titleRef.el) titleRef.el.textContent = page.title;
  document.title = `${page.title} | くまのみ ポータル`;
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.page === page.id));
}

router.setGuard((pageId) => canSeePage(pageId));
// 業務のなかで発生したタスク(発注・承認待ち・日報など)を毎回の描画前に積み直す
router.setBeforeRender(syncAutoTasks);
// 各ページが needs で宣言したデータを、描画前にそろえる
router.setLoader((needs) => store.load(needs));

function closeSplash() {
  const splash = document.getElementById("splash");
  if (splash) { splash.classList.add("hide"); setTimeout(() => splash.remove(), 500); }
}

/** アプリ本体を立ち上げる(ログイン済み、またはデモモード) */
async function bootApp() {
  teardownLogin(app);

  // シェル自体がスタッフと店舗を使うので、先にそろえてから組み立てる
  await store.load("staff", "stores");

  // サイドバーの未完了バッジを正しく出すため、シェルより先に一度同期しておく
  syncAutoTasks();

  const built = buildShell();
  titleRef.el = built.titleEl;
  router.init(built.main, onNavigate);

  // 本番につながっているのに種データを見ている、という取り違えを防ぐ
  if (supabase.isConfigured() && isDemoBypass()) showDemoBanner();

  setTimeout(closeSplash, 650);

  // 初回訪問メッセージ
  if (!sessionStorage.getItem("kumanomi.welcomed")) {
    sessionStorage.setItem("kumanomi.welcomed", "1");
    setTimeout(() => toast(`おはようございます、${store.me().name.split(" ")[0]}さん!今日も一日よろしくお願いします`, "info", { fish: true }), 1200);
  }
}

function showDemoBanner() {
  document.querySelector(".demo-banner")?.remove();
  document.body.appendChild(el("div", { class: "demo-banner" },
    icon("alert", 15),
    el("span", {}, "デモデータを表示中(サーバー未接続)"),
    el("button", { class: "db-out", onclick: signOutAndReload }, "ログインする")));
}

if (needsLogin()) {
  closeSplash();
  renderLogin(app, async (staffId) => {
    if (staffId) store.switchUser(staffId);
    await bootApp();
  });
} else {
  // 期限切れのトークンで起動すると全画面が権限エラーになるので、先に確かめる
  if (supabase.isConfigured() && supabase.session()) await supabase.ensureSession();
  await bootApp();
}

function refreshBell() {
  const dot = document.querySelector(".icon-btn .dot");
  if (dot && store.unreadCount() === 0) dot.remove();
}
