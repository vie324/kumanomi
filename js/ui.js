/* ============================================================
   KUMANOMI UI — DOM ヘルパーと共通コンポーネント
   すべてのページはここの部品だけで UI を組める。
   ============================================================ */

import { store } from "./store.js";

/* ---------------- DOM helpers ---------------- */

/**
 * el("div", {class:"card", onclick:fn, dataset:{id:"x"}, html:"<b>raw</b>"}, child1, "text", ...)
 * 子は Node / string / number / 配列 / null(無視)。
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(node, c);
    else if (c instanceof Node) node.appendChild(c);
    else node.appendChild(document.createTextNode(String(c)));
  }
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

/* ---------------- Formatters ---------------- */

export function fmtYen(n) { return "¥" + Math.round(Number(n) || 0).toLocaleString("ja-JP"); }

export function fmtNum(n) { return (Number(n) || 0).toLocaleString("ja-JP"); }
export function fmtPct(n, digits = 0) { return `${Number(n ?? 0).toFixed(digits)}%`; }

/**
 * CSV を書き出してダウンロードさせる(Excel でそのまま開ける BOM 付き UTF-8)。
 * rows は配列の配列: [["見出し1","見出し2"], [値, 値], ...]
 */
export function downloadCSV(filename, rows) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = "\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** '2026-07-30' → '7/30(木)' */
const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];
export function fmtDate(dateStr, { withDow = true, withYear = false } = {}) {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  const w = new Date(y, m - 1, d).getDay();
  return `${withYear ? y + "/" : ""}${m}/${d}${withDow ? `(${DOW_JA[w]})` : ""}`;
}

/** ISO日時 → 相対表現 */
export function relTime(isoStr) {
  if (!isoStr) return "";
  const t = new Date(isoStr).getTime();
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}日前`;
  return fmtDate(isoStr.slice(0, 10));
}

/* ---------------- Icons(手書きSVG・stroke系)---------------- */

const ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.5-.8L3 20l1-4.3A8.4 8.4 0 1 1 21 11.5z"/>',
  report: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 9h18"/>',
  book: '<path d="M4 4a2 2 0 0 1 2-2h14v18H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 1 2-2h14"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.6a5.4 5.4 0 0 1 6 4.9"/>',
  clipboard: '<rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 4a3 3 0 0 1 6 0"/><path d="M9 11h6M9 15h6"/>',
  box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/>',
  x: '<path d="M5 5l14 14M19 5 5 19"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevR: '<path d="m9 5 7 7-7 7"/>',
  chevL: '<path d="m15 5-7 7 7 7"/>',
  chevD: '<path d="m6 9 6 6 6-6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  pin: '<path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  gift: '<rect x="3" y="9" width="18" height="12" rx="1.5"/><path d="M12 9v12M3 13h18"/><path d="M12 9s-4 0-5-2 1-4 3-3 2 5 2 5zm0 0s4 0 5-2-1-4-3-3-2 5-2 5z"/>',
  heart: '<path d="M12 20.5s-8-4.9-8-11A4.6 4.6 0 0 1 12 6.7 4.6 4.6 0 0 1 20 9.5c0 6.1-8 11-8 11z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1.5 1.5 0 0 1 1.5 1.5V19a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 19V9.5A1.5 1.5 0 0 1 4 8z"/><circle cx="12" cy="13.5" r="3.5"/>',
  send: '<path d="M22 2 11 13M22 2 15 22l-4-9-9-4z"/>',
  line: '<rect x="2.5" y="3.5" width="19" height="17" rx="5"/><path d="M7 10.5h.01M12 10.5h.01M17 10.5h.01" stroke-width="2.6"/><path d="M9 20.5 7 23v-2.5"/>',
  gps: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3.3M12 18.7V22M2 12h3.3M18.7 12H22"/><circle cx="12" cy="12" r="8"/>',
  edit: '<path d="M16.8 3.7a2.4 2.4 0 0 1 3.5 3.5L8 19.5 3.5 20.5 4.5 16z"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13.5h9l1-13.5"/><path d="M10 11v6M14 11v6"/>',
  download: '<path d="M12 3v11M7 10l5 5 5-5"/><path d="M4 20h16"/>',
  print: '<path d="M7 8V3h10v5"/><rect x="3" y="8" width="18" height="9" rx="1.5"/><path d="M7 14h10v7H7z"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 9.5h.01M18 14.5h.01"/>',
  register: '<path d="M4 10h16l1.5 10.5h-19z"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>',
  award: '<circle cx="12" cy="9" r="6"/><path d="M8.5 14 7 22l5-2.6L17 22l-1.5-8"/>',
  grad: '<path d="M2.5 9.5 12 5l9.5 4.5L12 14z"/><path d="M6.5 11.7V17c0 1.4 2.5 2.8 5.5 2.8s5.5-1.4 5.5-2.8v-5.3"/><path d="M21.5 9.5V15"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  refresh: '<path d="M20 5v5h-5"/><path d="M4 19v-5h5"/><path d="M20 10a8 8 0 0 0-14.9-3M4 14a8 8 0 0 0 14.9 3"/>',
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 9.5V14M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5h.01"/>',
  phone: '<path d="M5 3h4l2 5-2.5 1.5a12 12 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
  eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2.5a2 2 0 0 0 0 3V16a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2.5a2 2 0 0 0 0-3z"/><path d="M14 6v12" stroke-dasharray="2.5 2.5"/>',
  body: '<circle cx="12" cy="4.5" r="2.3"/><path d="M12 7v7M12 14l-3.5 6M12 14l3.5 6M6.5 9.5 12 8.5l5.5 1"/>',
  org: '<rect x="8.5" y="2.5" width="7" height="5.5" rx="1.5"/><rect x="2.5" y="16" width="7" height="5.5" rx="1.5"/><rect x="14.5" y="16" width="7" height="5.5" rx="1.5"/><path d="M12 8v3.5M6 16v-2h12v2M12 11.5v2.5"/>',
};

/** icon("home", 20) → SVG element */
export function icon(name, size = 20) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = ICON_PATHS[name] || ICON_PATHS.info;
  svg.style.flexShrink = "0";
  return svg;
}

/* ---------------- ブランドマーク(くまのみ) ---------------- */

/**
 * クマノミのロゴマーク。用途に応じて動きが変わる。
 * motion: "float"(ゆらゆら) | "swim"(泳いで登場) | "wiggle"(ホバーで反応) | "none"
 */
export function fishMark(size = 40, motion = "float") {
  return el("img", {
    class: `fish-mark m-${motion}`,
    src: "assets/kumanomi-mark.png",
    alt: "",
    width: size, height: size,
    style: { width: size + "px", height: size + "px" },
  });
}

/** 横ロゴ(ロックアップ) */
export function brandLockup(width = 180) {
  return el("img", {
    class: "brand-lockup",
    src: "assets/kumanomi-wide.png",
    alt: "くまのみ 整骨院・整体院グループ",
    style: { width: width + "px" },
  });
}

/**
 * お祝い演出。サンクス送信・テスト合格など「嬉しい瞬間」に呼ぶ。
 * クマノミが画面を泳いで横切り、泡がふわっと上がる。1.6秒で自動消滅。
 */
export function celebrate(message) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    if (message) toast(message, "success", { fish: true });
    return;
  }
  const layer = el("div", { class: "celebrate-layer", "aria-hidden": "true" });
  layer.appendChild(el("img", { class: "celebrate-fish", src: "assets/kumanomi-mark.png", alt: "" }));
  for (let i = 0; i < 9; i++) {
    layer.appendChild(el("span", {
      class: "celebrate-bub",
      style: {
        left: 8 + Math.random() * 84 + "%",
        width: 6 + Math.random() * 12 + "px",
        height: 6 + Math.random() * 12 + "px",
        animationDelay: Math.random() * 0.5 + "s",
        animationDuration: 1.1 + Math.random() * 0.7 + "s",
      },
    }));
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1900);
  if (message) toast(message, "success", { fish: true });
}

/* ---------------- 小部品 ---------------- */

/** 人物アバター(イニシャル+個人カラー) */
export function avatar(person, size = 36) {
  const initial = (person?.name || "?").trim().charAt(0);
  const photo = person?.photoUrl || null;
  const node = el("span", {
    class: `avatar ${photo ? "has-photo" : ""}`,
    style: {
      width: size + "px", height: size + "px",
      fontSize: Math.round(size * 0.42) + "px",
      background: person?.color || "var(--brand)",
    },
    title: person?.name || "",
  }, initial);
  if (photo) {
    // 写真が読めなかったら頭文字に戻す(リンク切れ・オフライン対策)
    const img = el("img", { src: photo, alt: "", loading: "lazy", draggable: false });
    img.addEventListener("error", () => { img.remove(); node.classList.remove("has-photo"); });
    node.appendChild(img);
  }
  return node;
}

export function badge(text, kind = "", withDot = false) {
  return el("span", { class: `badge ${kind}` }, withDot ? el("span", { class: "badge-dot" }) : null, text);
}

export function chip(text, { on = false, onClick } = {}) {
  return el("button", { class: `chip ${on ? "on" : ""}`, onclick: onClick }, text);
}

/** key-value 行 */
export function kv(label, value) {
  return el("div", { class: "flex between", style: { padding: "5px 0", gap: "16px" } },
    el("span", { class: "muted small" }, label),
    el("span", { style: { fontWeight: "700", fontSize: "var(--fs-sm)", textAlign: "right" } }, value)
  );
}

/* ---------------- Stat tile ---------------- */

/**
 * statTile({label, value, icon:"trend", delta:+4.2, deltaLabel:"前月比", spark:Node, tone:"brand"})
 * delta: 数値(%表示)。up が良い前提。tone: brand|accent|good|warn
 */
export function statTile({ label, value, icon: ic, delta, deltaLabel = "前月比", deltaGoodUp = true, spark, tone = "brand", sub }) {
  const tones = {
    brand: ["var(--brand-soft)", "var(--brand-ink)"],
    accent: ["var(--accent-soft)", "var(--accent-ink)"],
    good: ["var(--good-soft)", "var(--good-text)"],
    warn: ["var(--warn-soft)", "var(--warn-text)"],
    violet: ["color-mix(in srgb,#6d5bd0 14%, var(--surface))", "#6d5bd0"],
  };
  const [bg, fg] = tones[tone] || tones.brand;
  let deltaEl = null;
  if (delta != null) {
    const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    const good = delta === 0 ? "flat" : (delta > 0) === deltaGoodUp ? "up" : "down";
    deltaEl = el("span", { class: `stat-delta ${good}` },
      icon(dir === "up" ? "arrowUp" : dir === "down" ? "arrowDown" : "check", 13),
      `${Math.abs(delta)}%`);
  }
  return el("div", { class: "stat-tile" },
    el("div", { class: "stat-top" },
      el("span", { class: "stat-label" }, label),
      ic ? el("span", { class: "stat-ic", style: { background: bg, color: fg } }, icon(ic, 18)) : null),
    el("div", { class: "stat-value" }, value),
    el("div", { class: "stat-foot" },
      deltaEl,
      deltaEl ? el("span", { class: "stat-vs" }, deltaLabel) : (sub ? el("span", { class: "stat-vs" }, sub) : null),
      spark ? el("span", { class: "stat-spark" }, spark) : null)
  );
}

/** meter(進捗バー) value/max, kind: ""|warn|critical|accent */
export function meter({ label, value, max, fmt = (v) => `${v}`, kind = "" }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return el("div", { class: `meter ${kind}` },
    el("div", { class: "meter-head" },
      el("span", { class: "meter-label" }, label),
      el("span", { class: "meter-val" }, fmt(value, max))),
    el("div", { class: "meter-track" }, el("div", { class: "meter-fill", style: { width: pct + "%" } }))
  );
}

/* ---------------- Card ---------------- */

export function card({ title, sub, actions, body, class: cls = "" }) {
  return el("div", { class: `card ${cls}` },
    title ? el("div", { class: "card-title" },
      el("span", {}, title, sub ? el("span", { class: "card-sub", style: { marginLeft: "8px" } }, sub) : null),
      actions || null) : null,
    body
  );
}

export function sectionHeader(title, desc, actions) {
  return el("div", { class: "page-head" },
    el("div", {},
      el("h1", {}, title),
      desc ? el("div", { class: "page-desc" }, desc) : null),
    actions ? el("div", { class: "page-actions" }, actions) : null
  );
}

/* ---------------- Tabs / segmented ---------------- */

/** tabs([{id,label,badge}], activeId, onChange) */
export function tabs(items, activeId, onChange) {
  const wrap = el("div", { class: "tabs", role: "tablist" });
  for (const it of items) {
    wrap.appendChild(el("button", {
      class: `tab ${it.id === activeId ? "active" : ""}`,
      role: "tab",
      onclick: () => onChange(it.id),
    }, it.label, it.badge != null ? el("span", { class: "tab-badge" }, it.badge) : null));
  }
  return wrap;
}

export function segmented(items, activeId, onChange) {
  const wrap = el("div", { class: "segmented" });
  for (const it of items) {
    wrap.appendChild(el("button", {
      class: `seg ${it.id === activeId ? "on" : ""}`,
      onclick: () => onChange(it.id),
    }, it.label));
  }
  return wrap;
}

/* ---------------- Table ---------------- */

/**
 * table({columns:[{key,label,align:"right"|"center",render:(row)=>Node}], rows, onRowClick})
 */
/**
 * 表を作る。
 *
 * スマホでは横スクロールにせず、1行を1枚のカードに積み替える
 * (CSS 側の .table-wrap.stack が担当)。
 * 列名は各セルの data-label に持たせてあるので、
 * 「数量」「状態」といった右側の列が画面外に消えてしまわない。
 *
 * 列が多い表(既定で 8 列以上)は、積むとかえって長くなるので
 * 横スクロールのままにする。stack: true / false で明示もできる。
 */
export function table({ columns, rows, onRowClick, empty = "データがありません", stack = null }) {
  if (!rows.length) return emptyState({ icon: "🗂", title: empty });
  const alignOf = (c) => (c.align === "right" ? "num" : c.align === "center" ? "center" : "");
  const thead = el("thead", {}, el("tr", {},
    columns.map((c) => el("th", { class: alignOf(c) }, c.label))));
  const tbody = el("tbody", {});
  for (const row of rows) {
    const tr = el("tr", {
      class: onRowClick ? "clickable" : "",
      onclick: onRowClick ? () => onRowClick(row) : null,
    });
    for (const c of columns) {
      const val = c.render ? c.render(row) : row[c.key];
      tr.appendChild(el("td", {
        class: alignOf(c),
        // スマホでカードに積み替えたとき、この値が何の列かを示す
        "data-label": typeof c.label === "string" ? c.label : "",
      }, val));
    }
    tbody.appendChild(tr);
  }
  const stacked = stack === null ? columns.length <= 8 : stack;
  return el("div", { class: `table-wrap${stacked ? " stack" : ""}` },
    el("table", { class: "table" }, thead, tbody));
}

/* ---------------- Empty state ---------------- */

/**
 * 空状態。icon を省略するとクマノミがゆらゆら泳いで待っている絵になる。
 */
export function emptyState({ icon: ic, title = "データがありません", hint = "" }) {
  return el("div", { class: "empty-state" },
    ic ? el("div", { class: "es-ic" }, ic)
       : el("div", { class: "es-fish" }, fishMark(56, "float")),
    el("div", { class: "es-title" }, title),
    hint ? el("div", { class: "es-hint" }, hint) : null);
}

/* ---------------- Modal / Drawer / Confirm ---------------- */

/** modal({title, body, actions:[Node], wide}) → {close, el} */
export function modal({ title, body, actions, wide = false, onClose }) {
  const scrim = el("div", { class: "modal-scrim" });
  const close = () => {
    scrim.remove();
    document.removeEventListener("keydown", onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });

  const m = el("div", { class: `modal ${wide ? "wide" : ""}`, role: "dialog", "aria-modal": "true" },
    el("div", { class: "modal-head" },
      el("h3", {}, title),
      el("button", { class: "icon-btn", onclick: close, "aria-label": "閉じる" }, icon("x", 18))),
    el("div", { class: "modal-body" }, body),
    actions?.length ? el("div", { class: "modal-foot" }, actions) : null
  );
  scrim.appendChild(m);
  document.body.appendChild(scrim);
  return { close, el: m };
}

export function confirmDialog({ title = "確認", message, okLabel = "実行する", danger = false }) {
  return new Promise((resolve) => {
    const ok = el("button", { class: `btn ${danger ? "danger" : "primary"}` }, okLabel);
    const cancel = el("button", { class: "btn ghost" }, "キャンセル");
    const m = modal({ title, body: el("p", { style: { fontSize: "var(--fs-sm)", lineHeight: "1.7" } }, message), actions: [cancel, ok], onClose: () => resolve(false) });
    // close() が onClose → resolve(false) を先に呼ぶので、「実行する」は先に true で確定させる
    // (順番が逆だと、どのボタンを押しても false になってしまう)
    ok.addEventListener("click", () => { resolve(true); m.close(); });
    cancel.addEventListener("click", () => { resolve(false); m.close(); });
  });
}

export function drawer({ title, body }) {
  const scrim = el("div", { class: "drawer-scrim" });
  const close = () => { scrim.remove(); dr.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  scrim.addEventListener("click", close);
  const dr = el("div", { class: "drawer" },
    el("div", { class: "drawer-head" },
      el("h3", {}, title),
      el("button", { class: "icon-btn", onclick: close, "aria-label": "閉じる" }, icon("x", 18))),
    el("div", { class: "drawer-body" }, body));
  document.body.appendChild(scrim);
  document.body.appendChild(dr);
  return { close, el: dr };
}

/* ---------------- Toast ---------------- */

let toastZone = null;
export function toast(message, kind = "success", { fish = false } = {}) {
  if (!toastZone) {
    toastZone = el("div", { class: "toast-zone" });
    document.body.appendChild(toastZone);
  }
  const icName = kind === "success" ? "check" : kind === "error" ? "alert" : "info";
  const t = el("div", { class: `toast ${kind}` },
    fish ? el("span", { class: "t-fish" }, fishMark(24, "swim"))
         : el("span", { class: "t-ic" }, icon(icName, 17)),
    message);
  toastZone.appendChild(t);
  setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 350);
  }, 3200);
}

/* ---------------- AI パーツ ---------------- */

/**
 * AI 実行ボタン。onRun が Promise を返す間はスピナー表示。
 * aiButton("AIでシフトを作成", async () => {...})
 */
export function aiButton(label, onRun, { small = false } = {}) {
  const btn = el("button", { class: `btn ai ${small ? "sm" : ""}` }, icon("sparkle", small ? 14 : 17), label);
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    const original = [...btn.childNodes];
    clear(btn);
    const sp = icon("refresh", small ? 14 : 17);
    sp.classList.add("spin");
    btn.append(sp, "生成中…");
    try {
      await onRun();
    } finally {
      clear(btn);
      btn.append(...original);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * AI 出力パネル。 const p = aiPanel("AI要約"); p.thinking(); p.setHTML("<ul>..</ul>");
 */
export function aiPanel(title = "AIによる生成結果") {
  const body = el("div", { class: "ai-body" });
  const root = el("div", { class: "ai-panel" },
    el("div", { class: "ai-head" }, icon("sparkle", 16), title),
    body);
  return {
    el: root,
    thinking(msg = "AIが分析しています") {
      clear(body).appendChild(el("span", { class: "ai-thinking" },
        el("span", { class: "th-fish" }, fishMark(26, "swim")),
        msg + "…",
        el("span", { class: "th-dots" }, el("i"), el("i"), el("i"))));
    },
    setHTML(html) { body.innerHTML = html; },
    setNode(node) { clear(body).appendChild(node); },
    clear() { clear(body); },
  };
}

/* ---------------- ヘルパー(ドメイン共通)---------------- */

/** スタッフのミニ表示(アバター+名前+役職) */
export function staffChip(staffId, { size = 30, withRole = true } = {}) {
  const s = store.byId("staff", staffId);
  if (!s) return el("span", { class: "muted" }, "—");
  return el("span", { class: "flex", style: { gap: "8px" } },
    avatar(s, size),
    el("span", { style: { lineHeight: "1.25" } },
      el("span", { style: { display: "block", fontSize: "var(--fs-sm)", fontWeight: "700" } }, s.name),
      withRole ? el("span", { class: "small muted" }, `${store.storeName(s.storeId)}・${s.role}`) : null));
}

/* ---------------- ボイス入力 ---------------- */

/**
 * テキストエリア用のボイス入力ボタン。
 * 対応ブラウザでは Web Speech API(ja-JP)で書き起こし、
 * 非対応環境ではサンプル文を1文字ずつ流し込んで動作を再現する(デモ)。
 * micButton(textarea, { samples: ["…"], label })
 */
export function micButton(ta, { samples = [], label = "ボイス入力" } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let timer = null;
  let sampleIdx = 0;
  let listening = false;

  const btn = el("button", { class: "btn soft sm mic-btn", type: "button" }, icon("mic", 14), label);

  const emitInput = () => ta.dispatchEvent(new Event("input", { bubbles: true }));

  const setUI = (on) => {
    listening = on;
    btn.classList.toggle("rec", on);
    clear(btn).append(icon("mic", 14), on ? "録音中…(タップで停止)" : label);
  };

  const stop = () => {
    if (rec) { try { rec.stop(); } catch (e) { /* noop */ } rec = null; }
    if (timer) { clearInterval(timer); timer = null; }
    setUI(false);
  };

  const startNative = () => {
    rec = new SR();
    rec.lang = "ja-JP";
    rec.interimResults = true;
    rec.continuous = true;
    const base = ta.value ? ta.value.replace(/\s+$/, "") + "\n" : "";
    rec.onresult = (e) => {
      let fin = "", interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript;
        else interim += r[0].transcript;
      }
      ta.value = base + fin + interim;
      emitInput();
    };
    rec.onerror = () => { stop(); startSample(); }; // マイク不可ならデモ入力へ
    rec.onend = () => { if (listening) setUI(false); };
    rec.start();
    setUI(true);
    toast("マイクに向かって話してください(ja-JP)", "info");
  };

  const startSample = () => {
    const text = samples.length ? samples[sampleIdx++ % samples.length] : "";
    if (!text) { toast("この環境では音声認識を利用できません", "info"); return; }
    const base = ta.value ? ta.value.replace(/\s+$/, "") + "\n" : "";
    let pos = 0;
    setUI(true);
    toast("デモ用のボイス入力を再生しています(実運用ではマイク音声を書き起こします)", "info");
    timer = setInterval(() => {
      pos += 4;
      ta.value = base + text.slice(0, pos);
      emitInput();
      ta.scrollTop = ta.scrollHeight;
      if (pos >= text.length) stop();
    }, 34);
  };

  btn.addEventListener("click", () => {
    if (listening) { stop(); return; }
    if (SR) startNative(); else startSample();
  });
  return btn;
}

/* ---------------- 画像添付ヘルパー ---------------- */

/**
 * 画像ファイル → 縮小済み dataURL。
 * localStorage 永続化のため長辺 maxSize px・JPEG に圧縮する。
 */
export function fileToDataURL(file, { maxSize = 1080, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("読み込みに失敗しました"));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("画像として読み込めませんでした"));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        if (scale >= 1 && String(fr.result).length < 400000) { resolve(fr.result); return; }
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(img.width * scale));
        cv.height = Math.max(1, Math.round(img.height * scale));
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL("image/jpeg", quality));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

/** 画像プレビューを大きく開くだけのモーダル */
export function openImageModal(src, title = "画像プレビュー") {
  const m = modal({
    title,
    body: el("div", { class: "img-modal-body" },
      el("img", { src, alt: title, class: "img-modal-img" })),
  });
  return m;
}

/** ステータス→バッジ */
export function statusBadge(status) {
  const map = {
    confirmed: ["確定", "brand"], done: ["来院済", "good"], cancelled: ["キャンセル", ""], noshow: ["無断キャンセル", "critical"],
    submitted: ["提出済", "good"], draft: ["下書き", "warn"],
    normal: ["正常", "good"], late: ["遅刻", "warn"], missing: ["打刻漏れ", "critical"],
    pending: ["承認待ち", "warn"], approved: ["承認済", "good"], rejected: ["却下", "critical"],
    todo: ["未着手", ""], doing: ["進行中", "brand"], doneTask: ["完了", "good"],
  };
  const [label, kind] = map[status] || [status, ""];
  return badge(label, kind);
}
