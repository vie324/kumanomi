/* ============================================================
   メンバー・組織図の一括登録

   組織図スプレッドシートをそのまま貼り付けて、
   店舗・メンバー・傘(上司)を SQL 一発で登録できる状態にする画面。

   ・スプレッドシートから範囲コピーして貼ると、結合セル(rowspan)も
     セルの色も一緒に取り込む。色から資格(白=柔整/緑=鍼灸/ピンク=整体)と
     性別(青字=男性/赤字=女性)を自動判定する。
   ・判定結果はプレビューで確認・手直しできる。
   ・出力は「実行できる SQL」と「正規化した TSV」。
     Supabase の接続設定があれば、この画面から直接投入もできる。

   判定ロジックは supabase/migrations/0003_roster_import.sql と同じ
   (js/roster.js に集約)。プレビューと取込結果は必ず一致する。
   ============================================================ */

import {
  el, clear, icon, badge, card, statTile, tabs, toast, modal,
  emptyState, confirmDialog, avatar,
} from "../ui.js";
import { store } from "../store.js";
import { can, rankLabel } from "../auth.js";
import { supabase } from "../supabase.js";
import {
  gridFromPaste, parseSheet, buildRoster, toTree, toSQL, collectColors,
  guessLicenseFromBg, guessGenderFromColor, DEFAULT_LEGEND_SKIP,
  LICENSE_LABELS, GENDER_LABELS, ROLE_LABELS, directorTitleOf,
} from "../roster.js";

const SAMPLE_TSV = [
  "\t\t\t\t\t整体部門\t\t\t受付スタッフ\t美容部門\t\t",
  "統括MG\tMG\t統括院長\t店舗\t院長\t\t\t\t\t店長\t\t",
  "日野 碧人(男)\t竹内 香織(女)\t小村 将真(男)\t越谷駅前院\t嶋田 勇輝(男)\t福井 仁太(柔整/男)\t佐藤 真夢(柔整/女)\t\t\t増渕 香澄(女)\t楢苅 芽依(女)",
  "\t\t\t新三郷院\t小村 将真(男)",
  "\t\t田名邊 要助(男)\t銀座院\t田名邊 要助(男)\t\t\t\t\t\t鈴木 美咲樹(女)\t蔵内 加蓮(女)",
  "\t松本 英樹(男)\t前田 耕作(男)\t池袋東口院\t仁藤 雄斗(男)\t今村 華音(鍼灸/女)\t青木 円夏(整体/女)",
  "\t\t-\tアリオ鷲宮院\t松本 英樹(男)\t石橋 愛理(整体/女)\t嵐 健太(柔整/男)\t浅見(山村) 彩雅(女)",
].join("\n");

/* ---- 画面の状態(ページ再描画をまたいで保持する) ---- */
const state = {
  raw: "",             // 貼り付けた原文(再描画しても消えないように保持)
  source: null,        // {grid, hasColor}
  sheet: null,         // parseSheet の結果
  roster: null,        // buildRoster の結果
  legend: null,        // {bgMap, fgMap}
  colors: null,        // collectColors の結果
  overrides: {},       // {nameKey: {license, gender}} 手直し
  applyBgToBeauty: false,  // 美容部門・受付にも背景色の資格判定を使うか
  tab: "stores",
  onlyUnknown: false,
  error: null,
};

const LICENSE_OPTIONS = ["unknown", "judo", "acupuncture", "seitai", "esthetic", "reception", "none"];
const GENDER_OPTIONS = ["unknown", "male", "female", "other"];

/** 貼り付け内容を解析して state を更新する */
function analyze({ html, text }) {
  state.error = null;
  state.raw = text || "";
  try {
    const source = gridFromPaste({ html, text });
    if (!source.grid.length) throw new Error("読み取れる表がありませんでした。");
    const sheet = parseSheet(source.grid);
    // HTML だけが来た場合(text/plain が空)でも、読み取った内容を欄に見せる
    if (!state.raw.trim()) {
      state.raw = source.grid.map((row) => row.map((c) => c.text).join("\t").replace(/\t+$/, "")).join("\n");
    }
    state.source = source;
    state.sheet = sheet;

    // 色 → 資格・性別 の対応表を作る(初期値は自動推定、あとで手直しできる)
    if (source.hasColor) {
      state.colors = collectColors(source.grid, sheet.columns, sheet.headerRows);
      const bgMap = {};
      for (const c of state.colors.bg) bgMap[c.key] = guessLicenseFromBg(c.key === "__none__" ? null : c.key);
      const fgMap = {};
      for (const c of state.colors.fg) fgMap[c.key] = guessGenderFromColor(c.key === "__none__" ? null : c.key);
      state.legend = { bgMap, fgMap, skipRoles: DEFAULT_LEGEND_SKIP };
    } else {
      state.colors = null;
      state.legend = null;
    }
    rebuild();
  } catch (e) {
    state.error = e.message || String(e);
    state.sheet = null;
    state.roster = null;
  }
}

/** 凡例や手直しを反映して roster を作り直す */
function rebuild() {
  if (!state.sheet) return;
  const legend = state.legend
    ? { ...state.legend, skipRoles: state.applyBgToBeauty ? [] : DEFAULT_LEGEND_SKIP }
    : null;
  state.roster = buildRoster(state.sheet.rows, { legend, overrides: state.overrides });
}

function download(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default {
  id: "orgimport",
  title: "メンバー・組織図の一括登録",
  icon: "users",

  // このページが必要とするデータ。ルーターがそろえてから render() を呼ぶ
  needs: ["staff", "stores"],
  render(root) {
    const me = store.me();
    const editable = can("org.edit");

    const draw = () => { clear(root); build(); };

    /* ================= 接続設定 ================= */

    function openConnectionModal() {
      const info = supabase.info();
      const urlInput = el("input", {
        class: "input", type: "url", placeholder: "https://xxxxxxxx.supabase.co",
        value: info?.url || "",
      });
      const keyInput = el("input", {
        class: "input", type: "password", placeholder: "anon(public)キー",
        autocomplete: "off",
      });
      const emailInput = el("input", { class: "input", type: "email", placeholder: "メールアドレス", value: me.email || "" });
      const passInput = el("input", { class: "input", type: "password", placeholder: "パスワード", autocomplete: "current-password" });
      const status = el("p", { class: "oi-status" });

      const save = el("button", { class: "btn primary", onclick: async () => {
        try {
          supabase.configure({ url: urlInput.value.trim(), anonKey: keyInput.value.trim() });
          status.className = "oi-status ok";
          clear(status).append(icon("check", 14), "接続先を保存しました。続けてログインしてください。");
        } catch (e) {
          status.className = "oi-status ng";
          clear(status).append(icon("alert", 14), e.message);
        }
      } }, icon("check", 15), "接続先を保存");

      const login = el("button", { class: "btn", onclick: async () => {
        if (!supabase.isConfigured()) {
          status.className = "oi-status ng";
          clear(status).append(icon("alert", 14), "先に接続先を保存してください。");
          return;
        }
        login.disabled = true;
        try {
          await supabase.signIn(emailInput.value.trim(), passInput.value);
          const c = await supabase.ping();
          status.className = "oi-status ok";
          clear(status).append(icon("check", 14),
            `ログインしました(店舗 ${c.stores}件 / メンバー ${c.members}名)`);
          draw();
        } catch (e) {
          status.className = "oi-status ng";
          clear(status).append(icon("alert", 14), e.message);
        } finally {
          login.disabled = false;
        }
      } }, icon("user", 15), "ログイン");

      const clearBtn = el("button", { class: "btn ghost", onclick: async () => {
        const ok = await confirmDialog({
          title: "接続設定の解除",
          message: "保存した接続先とログイン状態を削除します。デモモード(この端末のデータのみ)に戻ります。",
          okLabel: "解除する", danger: true,
        });
        if (!ok) return;
        supabase.clearConfig();
        m.close();
        draw();
        toast("接続設定を解除しました");
      } }, "接続設定を解除");

      const m = modal({
        title: "Supabase の接続設定",
        wide: true,
        body: el("div", { class: "page-orgimport oi-conn" },
          el("p", { class: "oi-lead" },
            "Supabase ダッシュボードの ", el("b", {}, "Settings → API"), " にある Project URL と anon(public)キーを入力します。",
            el("br"),
            el("b", {}, "service_role キーは絶対に入力しないでください。"),
            " ブラウザに置くと誰でも全データにアクセスできてしまいます。"),
          el("label", { class: "oi-field" }, el("span", {}, "プロジェクトURL"), urlInput),
          el("label", { class: "oi-field" }, el("span", {}, "anon キー"), keyInput),
          el("div", { class: "oi-row" }, save),
          el("hr", { class: "oi-hr" }),
          el("p", { class: "oi-lead" }, "登録操作には社員アカウントでのログインが必要です(RLS で権限を判定します)。"),
          el("label", { class: "oi-field" }, el("span", {}, "メールアドレス"), emailInput),
          el("label", { class: "oi-field" }, el("span", {}, "パスワード"), passInput),
          el("div", { class: "oi-row" }, login, clearBtn),
          status,
          el("details", { class: "oi-details" },
            el("summary", {}, "まだ Supabase を用意していない場合"),
            el("p", {},
              "接続設定がなくてもこの画面は使えます。貼り付けたシートから ",
              el("b", {}, "実行できる SQL"),
              " を生成できるので、Supabase の SQL Editor に貼って実行してください。",
              el("br"),
              "先に ", el("code", {}, "supabase/migrations/0001〜0004"), " を適用しておく必要があります。"))),
      });
    }

    /* ================= STEP 1:貼り付け ================= */

    function pasteSection() {
      const ta = el("textarea", {
        class: "oi-paste",
        rows: 6,
        placeholder: "ここにスプレッドシートの範囲をそのまま貼り付けてください(見出し行を含めて選択)",
        oninput: (e) => { state.raw = e.target.value; },
        onpaste: (e) => {
          const html = e.clipboardData?.getData("text/html");
          const text = e.clipboardData?.getData("text/plain");
          if (html || text) {
            e.preventDefault();
            analyze({ html, text });
            ta.value = state.raw;
            draw();
          }
        },
      });
      ta.value = state.raw;

      const parseTyped = () => { analyze({ html: null, text: ta.value }); draw(); };

      const file = el("input", {
        type: "file", accept: ".tsv,.csv,.txt,text/plain", class: "oi-file",
        onchange: async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const text = await f.text();
          // CSV も受け付ける(タブが無ければカンマ区切りとみなす)
          const normalized = text.includes("\t") ? text : text.replace(/,/g, "\t");
          analyze({ html: null, text: normalized });
          draw();
        },
      });

      return card({
        title: "STEP 1 — 組織図シートを貼り付ける",
        sub: "Excel / Google スプレッドシートから範囲コピーして貼ると、結合セルとセルの色ごと読み取ります",
        body: el("div", { class: "oi-paste-wrap" },
          ta,
          el("div", { class: "oi-actions" },
            el("button", { class: "btn primary", onclick: parseTyped }, icon("refresh", 15), "読み取る"),
            el("label", { class: "btn ghost oi-filebtn" }, icon("clipboard", 15), "ファイルを選ぶ", file),
            el("button", { class: "btn ghost", onclick: () => {
              analyze({ html: null, text: SAMPLE_TSV });
              draw();
            } }, "サンプルを入れる"),
            state.sheet ? el("button", { class: "btn ghost", onclick: () => {
              state.raw = "";
              state.source = state.sheet = state.roster = state.colors = state.legend = null;
              state.overrides = {};
              draw();
            } }, icon("trash", 15), "クリア") : null),
          el("div", { class: "oi-hint" }, icon("info", 14),
            el("span", {},
              "見出しは ", el("code", {}, "統括MG / MG / 統括院長 / 店舗 / 院長 / 整体部門 / 受付スタッフ / 店長 / 美容部門"),
              " を認識します(1行でも2行でも可)。列数や並びが変わっても自動で判定します。",
              el("br"),
              "統括院長がいない店舗は、その列に ", el("code", {}, "-"),
              " を入れてください(空欄は「上の行と同じ」の意味になります)。"))),
      });
    }

    /* ================= STEP 2:色の凡例 ================= */

    function legendSection() {
      if (!state.sheet) return null;
      if (!state.colors || !state.legend) {
        return card({
          title: "STEP 2 — セルの色を資格・性別に対応づける",
          sub: "今回の貼り付けには色の情報が含まれていませんでした",
          body: el("div", { class: "oi-hint" }, icon("info", 14),
            el("span", {},
              "テキスト(TSV/CSV)から読み込むと色は取り込めません。",
              "Excel や Google スプレッドシートの画面上で範囲を選択してコピーし、"
              + "STEP 1 の欄に貼り付けると、", el("b", {}, "背景色=資格・文字色=性別"),
              " を自動で判定します。",
              el("br"),
              "色が使えない場合は、氏名のうしろに ", el("code", {}, "(柔整/男)"),
              " と書くか、STEP 3 のメンバー一覧で個別に指定してください。")),
        });
      }

      const swatch = (hex) => el("span", {
        class: `oi-sw ${hex === "__none__" ? "none" : ""}`,
        style: hex === "__none__" ? {} : { background: hex },
        title: hex === "__none__" ? "色の指定なし" : hex,
      });

      const rowsFor = (kind) => {
        const items = state.colors[kind];
        const map = kind === "bg" ? state.legend.bgMap : state.legend.fgMap;
        const options = kind === "bg" ? LICENSE_OPTIONS : GENDER_OPTIONS;
        const labels = kind === "bg" ? LICENSE_LABELS : GENDER_LABELS;
        return items.map((c) => el("div", { class: "oi-legend-row" },
          swatch(c.key),
          el("span", { class: "oi-legend-meta" },
            el("b", {}, c.key === "__none__" ? "色の指定なし" : c.key),
            el("i", {}, `${c.count}セル・例:${c.samples.slice(0, 2).join("、") || "—"}`)),
          el("select", {
            class: "select sm",
            onchange: (e) => { map[c.key] = e.target.value; rebuild(); draw(); },
          }, options.map((o) => el("option", { value: o, selected: map[c.key] === o || null }, labels[o])))));
      };

      return card({
        title: "STEP 2 — セルの色を資格・性別に対応づける",
        sub: "貼り付けたシートで実際に使われている色だけを表示しています。自動判定を直せます",
        body: el("div", {},
          el("div", { class: "oi-legend" },
            el("div", {},
              el("div", { class: "oi-legend-title" }, "背景色 → 資格"),
              el("p", { class: "oi-legend-note" }, "元のシートの凡例:白=柔整師 / 緑=鍼灸師 / ピンク=整体師"),
              rowsFor("bg")),
            el("div", {},
              el("div", { class: "oi-legend-title" }, "文字色 → 性別"),
              el("p", { class: "oi-legend-note" }, "元のシートの凡例:青字=男性 / 赤字=女性"),
              rowsFor("fg"))),
          el("label", { class: "oi-opt" },
            el("input", {
              type: "checkbox", checked: state.applyBgToBeauty || null,
              onchange: (e) => { state.applyBgToBeauty = e.target.checked; rebuild(); draw(); },
            }),
            el("span", {},
              el("b", {}, "美容部門・受付スタッフにも背景色の判定を使う"),
              el("i", {}, "既定ではオフです。美容部門は部門ごとの塗り分け(全員ピンクなど)であることが多く、"
                + "資格の凡例とは別物のためです。オフのときは STEP 3 で個別に指定できます。")))),
      });
    }

    /* ================= STEP 3:プレビュー ================= */

    function warningsBlock(r) {
      if (!r.warnings.length) {
        return el("div", { class: "oi-check ok" }, icon("check", 15),
          el("span", {}, "組織のつながりに問題は見つかりませんでした。"));
      }
      return el("div", { class: "oi-check ng" }, icon("alert", 15),
        el("div", {},
          el("b", {}, `確認してください(${r.warnings.length}件)`),
          el("ul", {}, r.warnings.map((w) => el("li", {}, w)))));
    }

    function storeTable(r) {
      const head = el("tr", {},
        ["店舗", "区分", "統括院長", "院長 / 店長", "整体部門", "受付", "美容部門", "人数"]
          .map((h) => el("th", {}, h)));
      const nameOf = (key) => r.members.find((m) => m.nameKey === key)?.fullName || "—";
      const rowsEl = state.sheet.rows.map((row, i) => {
        const s = r.stores[i];
        const inStore = (dept) => r.members.filter((m) =>
          m.storeName === s.name && m.department === dept && !["director", "beauty_manager"].includes(m.role));
        const list = (arr) => arr.length
          ? el("span", { class: "oi-people" }, arr.map((m) => el("span", { class: `oi-chip lic-${m.license}` }, m.fullName)))
          : el("span", { class: "muted" }, "—");
        return el("tr", {},
          el("td", {}, el("b", {}, s.name)),
          el("td", {}, el("span", { class: "oi-cat" }, s.category)),
          el("td", {}, s.chiefDirectorKey ? nameOf(s.chiefDirectorKey) : el("span", { class: "muted" }, "—")),
          el("td", {},
            s.directorKey ? el("b", {}, nameOf(s.directorKey)) : el("span", { class: "oi-missing" }, `${directorTitleOf(s.category)}なし`),
            s.beautyManagerKey ? el("span", { class: "oi-sub" }, `店長:${nameOf(s.beautyManagerKey)}`) : null),
          el("td", {}, list(inStore("seitai"))),
          el("td", {}, list(inStore("reception"))),
          el("td", {}, list(inStore("beauty"))),
          el("td", { class: "num" }, String(r.members.filter((m) => m.storeName === s.name).length)));
      });
      return el("div", { class: "table-wrap oi-table" }, el("table", { class: "table" },
        el("thead", {}, head), el("tbody", {}, rowsEl)));
    }

    function treeBlock(r) {
      const render = (nodes, depth) => el("ul", { class: "oi-tree-ul" },
        nodes.sort((a, b) => a.sortOrder - b.sortOrder).map((n) => el("li", { class: "oi-tree-li" },
          el("div", { class: `oi-node rk-${n.rank}` },
            el("span", { class: "oi-node-name" }, n.fullName),
            el("span", { class: "oi-node-role" }, n.roleTitle),
            n.storeName ? el("span", { class: "oi-node-store" }, n.storeName) : null,
            n.children.length ? el("span", { class: "oi-node-count" }, `配下 ${countAll(n)}名`) : null),
          n.children.length ? render(n.children, depth + 1) : null)));
      const countAll = (n) => n.children.reduce((a, c) => a + 1 + countAll(c), 0);
      const roots = toTree(r.members);
      return el("div", { class: "oi-tree" }, render(roots, 0));
    }

    function memberTable(r) {
      const list = state.onlyUnknown
        ? r.members.filter((m) => m.license === "unknown" || m.gender === "unknown")
        : r.members;

      const setOverride = (m, field, value) => {
        state.overrides[m.nameKey] = { ...(state.overrides[m.nameKey] || {}), [field]: value };
        rebuild();
        draw();
      };

      const head = el("tr", {}, ["氏名", "所属", "役職", "資格", "性別", "上司"].map((h) => el("th", {}, h)));
      const body = list.map((m) => {
        const manager = r.members.find((x) => x.nameKey === m.managerKey);
        return el("tr", { class: m.license === "unknown" || m.gender === "unknown" ? "oi-unknown" : "" },
          el("td", {},
            el("b", {}, m.fullName),
            m.formerName ? el("span", { class: "oi-sub" }, `旧姓:${m.formerName}`) : null),
          el("td", {}, m.storeName || el("span", { class: "muted" }, "—")),
          el("td", {}, el("span", { class: `oi-rank rk-${m.rank}` }, m.roleTitle)),
          el("td", {}, el("select", {
            class: "select sm",
            onchange: (e) => setOverride(m, "license", e.target.value),
          }, LICENSE_OPTIONS.map((o) => el("option", { value: o, selected: m.license === o || null }, LICENSE_LABELS[o])))),
          el("td", {}, el("select", {
            class: "select sm",
            onchange: (e) => setOverride(m, "gender", e.target.value),
          }, GENDER_OPTIONS.map((o) => el("option", { value: o, selected: m.gender === o || null }, GENDER_LABELS[o])))),
          el("td", {}, manager ? manager.fullName : el("span", { class: "oi-root" }, "組織のトップ")));
      });

      return el("div", {},
        el("div", { class: "oi-filter" },
          el("label", { class: "toggle" },
            el("input", {
              type: "checkbox", checked: state.onlyUnknown || null,
              onchange: (e) => { state.onlyUnknown = e.target.checked; draw(); },
            }),
            el("span", { class: "tg-track" }),
            el("span", { class: "tg-label" }, "未確認だけ表示")),
          el("span", { class: "small muted" }, `${list.length} / ${r.members.length} 名`)),
        el("div", { class: "table-wrap oi-table" }, el("table", { class: "table" },
          el("thead", {}, head), el("tbody", {}, body))));
    }

    function previewSection() {
      const r = state.roster;
      if (!r) return null;

      const tabItems = [
        { id: "stores", label: `店舗別(${r.stores.length})` },
        { id: "tree", label: "組織ツリー" },
        { id: "members", label: `メンバー(${r.members.length})` },
      ];

      return card({
        title: "STEP 3 — 取り込む内容を確認する",
        sub: "ここに表示されている通りに登録されます(判定ロジックは取込SQLと共通です)",
        body: el("div", {},
          el("div", { class: "oi-stats" },
            statTile({ label: "店舗", value: String(r.stores.length), icon: "home", tone: "brand" }),
            statTile({ label: "メンバー", value: String(r.members.length), icon: "users", tone: "accent" }),
            statTile({
              label: "資格が未確認", value: String(r.unknownLicense.length), icon: "grad",
              tone: r.unknownLicense.length ? "warn" : "good", sub: "背景色から判定できなかった人",
            }),
            statTile({
              label: "性別が未確認", value: String(r.unknownGender.length), icon: "user",
              tone: r.unknownGender.length ? "warn" : "good", sub: "文字色から判定できなかった人",
            })),
          warningsBlock(r),
          tabs(tabItems, state.tab, (id) => { state.tab = id; draw(); }),
          state.tab === "stores" ? storeTable(r)
            : state.tab === "tree" ? treeBlock(r)
            : memberTable(r)),
      });
    }

    /* ================= STEP 4:反映 ================= */

    function outputSection() {
      const r = state.roster;
      if (!r) return null;

      const deactivate = el("input", { type: "checkbox" });
      const sqlOf = () => toSQL(state.sheet.rows, r, {
        deactivateMissing: deactivate.checked,
        sourceLabel: "組織図スプレッドシート",
      });

      const pushBtn = el("button", {
        class: "btn primary",
        disabled: !supabase.isConfigured() || !supabase.user() || null,
        onclick: async () => {
          const ok = await confirmDialog({
            title: "Supabase に登録する",
            message: `店舗 ${r.stores.length}件・メンバー ${r.members.length}名 を登録します。`
              + `氏名が一致する既存メンバーは上書き更新されます。`
              + (deactivate.checked ? "\n\nこのシートに載っていないメンバー・店舗は非アクティブになります。" : ""),
            okLabel: "登録する",
          });
          if (!ok) return;
          pushBtn.disabled = true;
          const original = pushBtn.textContent;
          clear(pushBtn).append(icon("refresh", 15), "登録中…");
          try {
            const res = await supabase.rpc("import_roster_sheet_as_admin", {
              p_tsv: extractSheetFromSQL(sqlOf()),
              p_options: {
                deactivate_missing: deactivate.checked,
                default_category: "整骨院",
                preserve_manual_edits: true,
              },
              p_source_label: "ポータルからの一括登録",
            });
            showResult(res);
          } catch (e) {
            toast(e.message, "error");
          } finally {
            pushBtn.disabled = false;
            clear(pushBtn).append(icon("check", 15), original || "Supabase に登録");
          }
        },
      }, icon("check", 15), "Supabase に登録");

      const connNote = !supabase.isConfigured()
        ? el("p", { class: "oi-note" }, icon("info", 14),
            el("span", {}, "Supabase の接続先が未設定です。SQL を生成して SQL Editor から実行してください。"))
        : !supabase.user()
          ? el("p", { class: "oi-note" }, icon("info", 14),
              el("span", {}, "登録するにはログインが必要です。右上の「接続設定」からログインしてください。"))
          : null;

      return card({
        title: "STEP 4 — 登録する",
        sub: "SQL として持ち出すか、この画面から直接投入するかを選べます",
        body: el("div", { class: "oi-output" },
          el("label", { class: "oi-opt" },
            deactivate,
            el("span", {},
              el("b", {}, "このシートに載っていない人・店舗を非アクティブにする"),
              el("i", {}, "初回はオフのままにして、差分を確認してから使ってください"))),
          el("div", { class: "oi-actions" },
            el("button", { class: "btn", onclick: async () => {
              const okc = await copyText(sqlOf());
              toast(okc ? "SQL をコピーしました。Supabase の SQL Editor に貼って実行してください"
                : "コピーできませんでした。ダウンロードをお使いください", okc ? "success" : "error");
            } }, icon("clipboard", 15), "SQL をコピー"),
            el("button", { class: "btn ghost", onclick: () => {
              download("kumanomi_roster.sql", sqlOf(), "application/sql;charset=utf-8");
              toast("SQL をダウンロードしました");
            } }, icon("download", 15), "SQL をダウンロード"),
            el("button", { class: "btn ghost", onclick: () => {
              download("roster_sheet.tsv", extractSheetFromSQL(sqlOf()) + "\n", "text/tab-separated-values;charset=utf-8");
              toast("正規化した TSV をダウンロードしました");
            } }, icon("download", 15), "TSV をダウンロード"),
            pushBtn),
          connNote,
          el("details", { class: "oi-details" },
            el("summary", {}, "生成される SQL を見る"),
            el("pre", { class: "oi-sql" }, sqlOf()))),
      });
    }

    /** 生成SQLから TSV 本体だけを取り出す(RPC にはシートだけを渡す) */
    function extractSheetFromSQL(sql) {
      const m = sql.match(/\$(sheet\d*)\$\n([\s\S]*?)\n\$\1\$/);
      return m ? m[2] : "";
    }

    function showResult(res) {
      const rows = [
        ["取り込んだ行", `${res.rows} 行`],
        ["店舗", `新規 ${res.stores_created} / 更新 ${res.stores_updated}`],
        ["メンバー", `新規 ${res.members_created} / 更新 ${res.members_updated}`],
        ["所属(兼務含む)", `${res.assignments} 件`],
        ["組織のトップ", (res.roots || []).join("、") || "—"],
        ["資格が未確認", `${res.unknown_license} 名`],
        ["性別が未確認", `${res.unknown_gender} 名`],
      ];
      const problems = [
        ...(res.orphans || []).length ? [`上司が付いていない人:${res.orphans.join("、")}`] : [],
        ...(res.duplicate_names || []).length ? [`同姓同名の可能性:${res.duplicate_names.join("、")}`] : [],
      ];
      modal({
        title: "登録が完了しました",
        body: el("div", { class: "page-orgimport" },
          el("div", { class: "oi-result" }, rows.map(([k, v]) =>
            el("div", { class: "oi-result-row" }, el("span", {}, k), el("b", {}, v)))),
          problems.length
            ? el("div", { class: "oi-check ng" }, icon("alert", 15),
                el("ul", {}, problems.map((p) => el("li", {}, p))))
            : el("div", { class: "oi-check ok" }, icon("check", 15), el("span", {}, "未解決の問題はありません。")),
          el("p", { class: "oi-note" }, icon("info", 14),
            el("span", {}, "組織図ページを開くと、登録した傘がそのまま反映されています。"))),
      });
      toast(`メンバー ${res.members_created + res.members_updated}名・店舗 ${res.stores_created + res.stores_updated}件を登録しました`);
    }

    /* ================= 構築 ================= */

    function build() {
      root.appendChild(el("div", { class: "page-head" },
        el("div", {},
          el("h1", {}, "メンバー・組織図の一括登録"),
          el("div", { class: "page-desc" },
            "組織図スプレッドシートを貼り付けて、店舗・メンバー・傘(誰が誰の下か)をまとめて登録します。"
            + "毎月の組織変更も、更新したシートを貼り直して実行するだけです。")),
        el("div", { class: "page-actions" },
          el("button", { class: "btn ghost", onclick: openConnectionModal },
            icon("settings", 15), "接続設定"))));

      // 接続状態
      const connected = supabase.isConfigured();
      const loggedIn = connected && !!supabase.user();
      root.appendChild(el("div", { class: `oi-conn-bar ${loggedIn ? "on" : connected ? "half" : ""}` },
        el("span", { class: "oi-conn-ic" }, icon(loggedIn ? "check" : "info", 15)),
        el("span", { class: "oi-conn-txt" },
          loggedIn
            ? el("span", {}, el("b", {}, "Supabase に接続中"), ` — ${supabase.info().url}`)
            : connected
              ? el("span", {}, el("b", {}, "接続先は設定済み"), " — 登録するにはログインしてください")
              : el("span", {}, el("b", {}, "デモモード"), " — SQL を生成して Supabase の SQL Editor から実行できます")),
        el("span", { class: "spacer" }),
        badge(rankLabel(me), "brand")));

      if (!editable) {
        root.appendChild(card({
          title: "この画面は閲覧できません",
          body: emptyState({
            icon: "alert",
            title: "権限がありません",
            hint: "メンバー・組織図の一括登録は、統括マネージャー以上または本部人事が行えます。",
          }),
        }));
        return;
      }

      root.appendChild(pasteSection());

      if (state.error) {
        root.appendChild(el("div", { class: "oi-check ng" }, icon("alert", 15),
          el("div", {}, el("b", {}, "読み取れませんでした"), el("p", {}, state.error))));
      }

      const legend = legendSection();
      if (legend) root.appendChild(legend);

      const preview = previewSection();
      if (preview) root.appendChild(preview);

      const output = outputSection();
      if (output) root.appendChild(output);

      if (!state.sheet && !state.error) {
        root.appendChild(card({
          title: "シートの形式について",
          body: el("div", { class: "oi-format" },
            el("p", {}, "次の見出しを持つ表なら、列の並びや人数が変わってもそのまま取り込めます。"),
            el("div", { class: "oi-format-cols" },
              Object.entries(ROLE_LABELS).filter(([k]) => k !== "category")
                .map(([, label]) => el("span", { class: "oi-chip" }, label))),
            el("ul", { class: "oi-format-list" },
              el("li", {}, el("b", {}, "結合セル"), " — 統括MG・MG・統括院長は空欄なら上の行を引き継ぎます。"
                + "その階層がいない店舗は ", el("code", {}, "-"), " を入れてください。"),
              el("li", {}, el("b", {}, "資格・性別"), " — セルの色から自動判定します。"
                + "色のないデータでは氏名のうしろに ", el("code", {}, "(柔整/男)"), " と書いても指定できます。"),
              el("li", {}, el("b", {}, "旧姓"), " — ", el("code", {}, "浅見(山村) 彩雅"),
                " のような表記はそのまま氏名として保持し、旧姓を別に記録します。"),
              el("li", {}, el("b", {}, "同姓同名"), " — 別人であれば ", el("code", {}, "佐藤 真夢@2"),
                " のように連番を付けて区別します(@以降は氏名に含まれません)。"),
              el("li", {}, el("b", {}, "兼務"), " — 同じ人が複数の列に出てきても1人にまとめ、"
                + "いちばん上位の役職で組織図に配置します。"))),
        }));
      }
    }

    draw();
  },
};
