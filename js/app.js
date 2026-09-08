/* ============================================================
   KUMANOMI App — シェル(サイドバー/トップバー)とページ登録
   ============================================================ */

import { store } from "./store.js";
import { router } from "./router.js";
import { el, icon, avatar, badge, toast, relTime, fmtDate, confirmDialog, drawer, clear } from "./ui.js";
import { canSeePage, rankLabel, scopeLabel, RANKS, rankOf } from "./auth.js";
import { syncAutoTasks } from "./autotasks.js";

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

  // --- 設定 ---
  const settingsBtn = el("button", { class: "icon-btn", "aria-label": "設定", onclick: async () => {
    const ok = await confirmDialog({
      title: "デモデータのリセット",
      message: "このデモで加えた変更(投稿・打刻・予約など)をすべて破棄して、初期状態に戻します。よろしいですか?",
      okLabel: "リセットする", danger: true,
    });
    if (ok) { store.reset(); location.reload(); }
  } }, icon("settings", 19));

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
    el("div", { class: "topbar-actions" }, bellBtn, themeBtn, settingsBtn, userBtn));

  const main = el("div", { class: "main", id: "outlet" });
  const scrim = el("div", { class: "mobile-scrim", onclick: closeMobileNav });

  clear(app).append(sidebar, topbar, main, scrim);

  return { titleEl, main, bellBtn };
}

function closeMobileNav() { app.classList.remove("nav-open"); }

/* ---- ログインユーザー切替(デモ用:権限の違いを体験できる) ---- */
function openUserSwitcher() {
  const me = store.me();
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

// サイドバーの未完了バッジを正しく出すため、シェルより先に一度同期しておく
syncAutoTasks();

const built = buildShell();
titleRef.el = built.titleEl;
router.init(built.main, onNavigate);

function refreshBell() {
  const dot = document.querySelector(".icon-btn .dot");
  if (dot && store.unreadCount() === 0) dot.remove();
}

// スプラッシュを閉じる
setTimeout(() => {
  const splash = document.getElementById("splash");
  if (splash) { splash.classList.add("hide"); setTimeout(() => splash.remove(), 500); }
}, 650);

// 初回訪問メッセージ
if (!sessionStorage.getItem("kumanomi.welcomed")) {
  sessionStorage.setItem("kumanomi.welcomed", "1");
  setTimeout(() => toast(`おはようございます、${store.me().name.split(" ")[0]}さん!今日も一日よろしくお願いします`, "info", { fish: true }), 1200);
}
