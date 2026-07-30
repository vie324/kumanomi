/* ============================================================
   日報 — 数字を入れるだけ。契約率は自動計算、集計と評価連携は自動。
   タブ:提出する / みんなの日報 / 自分の推移
   ============================================================ */

import {
  el, clear, icon, card, sectionHeader, tabs, segmented, table,
  statTile, badge, statusBadge, toast, aiButton, aiPanel,
  avatar, staffChip, emptyState, fmtYen, fmtNum, fmtDate, esc,
} from "../ui.js";
import { store, todayStr, addDays, monthOf, dow } from "../store.js";
import { lineChart, sparkline } from "../charts.js";
import { summarizeReports, delay } from "../ai.js";

/* ---------------- ページ状態(再描画をまたいで保持) ---------------- */
const state = {
  tab: "submit",       // submit | all | me
  date: todayStr(),    // みんなの日報の表示日
  storeFilter: "all",
};

const PRACTITIONER_ROLES = ["院長", "柔道整復師", "鍼灸師"];

/* ---------------- 共通ヘルパー ---------------- */

const rateOf = (contracts, proposals) =>
  proposals > 0 ? Math.round((contracts / proposals) * 100) : null;

function practitioners(storeId = "all") {
  return store.get("staff").filter((s) =>
    PRACTITIONER_ROLES.includes(s.role) && (storeId === "all" || s.storeId === storeId));
}

function reportsOn(date, storeId = "all") {
  return store.get("dailyReports")
    .filter((r) => r.date === date && (storeId === "all" || r.storeId === storeId));
}

function myReportOn(date) {
  const me = store.me();
  return store.get("dailyReports").find((r) => r.staffId === me.id && r.date === date) || null;
}

/** 契約率セル(色つき) */
function rateCell(contracts, proposals) {
  const r = rateOf(contracts, proposals);
  if (r == null) return el("span", { class: "muted" }, "—");
  return el("span", { class: `nippo-ratecell ${r >= 70 ? "hi" : r < 40 ? "lo" : ""}` }, `${r}%`);
}

/** 提出状況(院長・統括向けの小さな表示) */
function submissionStatusEl(date, storeId = "all") {
  const wrap = el("div", { class: "nippo-substatus" });
  if (dow(date) === 3) {
    wrap.append(icon("info", 14), el("span", {}, "この日は定休日(水曜)のため提出対象はありません。"));
    return wrap;
  }
  const members = practitioners(storeId);
  const reports = reportsOn(date, storeId);
  const submitted = members.filter((s) => reports.some((r) => r.staffId === s.id && r.status === "submitted"));
  const drafts = members.filter((s) => reports.some((r) => r.staffId === s.id && r.status === "draft"));
  const missing = members.filter((s) => !reports.some((r) => r.staffId === s.id));
  wrap.append(
    el("span", { class: "nippo-subcount" },
      icon("clipboard", 14), `提出済 ${submitted.length}/${members.length}名`),
    drafts.length ? badge(`下書き ${drafts.length}名`, "warn") : null,
  );
  if (missing.length) {
    wrap.appendChild(el("span", { class: "nippo-sublabel" }, "未提出:"));
    for (const s of missing) {
      wrap.appendChild(el("span", { class: "nippo-subchip", title: `${store.storeName(s.storeId)}・${s.role}` },
        avatar(s, 17), s.name.split(" ")[0]));
    }
  } else {
    wrap.appendChild(badge("全員提出済み", "good", true));
  }
  return wrap;
}

/** 評価自動連携の案内バッジ */
function evalNote() {
  return el("div", { class: "nippo-evalnote" },
    icon("check", 16),
    el("span", {},
      el("strong", {}, "この数値は人事評価に自動連携されます"),
      "(手作業の集計は不要です)"));
}

/* ---------------- タブ1:提出する ---------------- */

function draftComment(v) {
  const r = rateOf(v.contracts, v.proposals);
  const parts = [];
  if (v.treatments > 0) parts.push(`本日は施術${v.treatments}件・売上${fmtYen(v.revenue)}で着地。一人ひとりに集中して向き合えた。`);
  else parts.push("本日は施術数こそ少なめだったが、その分カウンセリングと院内の仕込みに時間を使えた。");
  if (v.newPatients > 0) parts.push(`新規${v.newPatients}名は初回カウンセリングで痛みの背景まで丁寧にヒアリングできた。`);
  if (v.contracts > 0) parts.push(`回数券はご提案${v.proposals}件中${v.contracts}件がご成約(契約率${r}%)。施術計画にご納得いただいてから金額をお伝えする流れが機能している。`);
  else if (v.proposals > 0) parts.push(`回数券のご提案${v.proposals}件は本日成約に至らなかったが、次回ご来院時に前向きに検討いただける状態まで温められた。`);
  if (v.goods > 0) parts.push(`物販は${fmtYen(v.goods)}。セルフケアの延長として自然にご案内できた。`);
  parts.push("明日も「施術計画への納得 → ご提案」の順序を守り、目の前の患者様の回復に集中したい。");
  return parts.join("\n");
}

function submitTab(renderAll) {
  const me = store.me();

  const numInput = (name) => el("input", {
    class: "input", type: "number", min: "0", step: "1", inputmode: "numeric",
    placeholder: "0", "aria-label": name,
  });
  const fDate = el("input", { class: "input", type: "date", value: todayStr(), max: todayStr() });
  const inRevenue = numInput("売上");
  const inTreat = numInput("施術数");
  const inNew = numInput("新規数");
  const inProp = numInput("回数券提案数");
  const inCont = numInput("成約数");
  const inGoods = numInput("物販売上");
  const taComment = el("textarea", { class: "textarea", rows: "4", placeholder: "今日の振り返り(AIの下書きも使えます)" });

  const collect = () => ({
    revenue: Math.max(0, Number(inRevenue.value) || 0),
    treatments: Math.max(0, Number(inTreat.value) || 0),
    newPatients: Math.max(0, Number(inNew.value) || 0),
    proposals: Math.max(0, Number(inProp.value) || 0),
    contracts: Math.max(0, Number(inCont.value) || 0),
    goods: Math.max(0, Number(inGoods.value) || 0),
    comment: taComment.value.trim(),
  });

  /* --- 契約率のリアルタイム表示 --- */
  const rateVal = el("div", { class: "nippo-rate-val" }, "—");
  const rateSub = el("div", { class: "nippo-rate-sub" }, "提案数と成約数を入れると自動計算されます");
  const rateBox = el("div", { class: "nippo-rate" },
    el("div", { class: "nippo-rate-label" }, icon("target", 15), "契約率(自動計算)"),
    rateVal, rateSub);

  const updateRate = () => {
    const p = Number(inProp.value) || 0;
    const c = Number(inCont.value) || 0;
    rateBox.classList.remove("good", "warn", "over");
    if (p <= 0) {
      rateVal.textContent = "—";
      rateSub.textContent = "提案数と成約数を入れると自動計算されます";
      return;
    }
    const r = Math.round((c / p) * 100);
    rateVal.textContent = `${r}%`;
    if (c > p) {
      rateBox.classList.add("over");
      rateSub.textContent = "成約数が提案数を上回っています。入力をご確認ください";
    } else {
      rateBox.classList.add(r >= 70 ? "good" : r < 40 ? "warn" : "mid");
      rateSub.textContent = `ご提案 ${p}件 中 ${c}件 ご成約`;
    }
  };
  [inProp, inCont].forEach((i) => i.addEventListener("input", updateRate));

  /* --- 既存日報の読み込み(同日分があれば上書き編集) --- */
  const existBadge = el("span", {});
  const submitBtn = el("button", { class: "btn primary lg block" }, icon("send", 17), "日報を提出する");

  const loadFor = (date) => {
    const ex = myReportOn(date);
    inRevenue.value = ex ? ex.revenue : "";
    inTreat.value = ex ? ex.treatments : "";
    inNew.value = ex ? ex.newPatients : "";
    inProp.value = ex ? ex.proposals : "";
    inCont.value = ex ? ex.contracts : "";
    inGoods.value = ex ? ex.goods : "";
    taComment.value = ex ? ex.comment : "";
    clear(existBadge);
    if (ex) {
      existBadge.append(statusBadge(ex.status),
        el("span", { class: "small muted" }, "この日の日報は入力済みです。修正して再提出できます"));
    }
    submitBtn.lastChild.textContent = ex ? "日報を更新する" : "日報を提出する";
    updateRate();
  };
  fDate.addEventListener("change", () => loadFor(fDate.value));
  loadFor(todayStr());

  /* --- 提出 --- */
  submitBtn.addEventListener("click", () => {
    const date = fDate.value;
    if (!date) { toast("日付を入力してください", "error"); return; }
    if (date > todayStr()) { toast("未来の日付には提出できません", "error"); return; }
    const v = collect();
    if (v.contracts > v.proposals) { toast("成約数は提案数以下で入力してください", "error"); return; }
    const ex = myReportOn(date);
    if (ex) {
      store.update("dailyReports", ex.id, { ...v, status: "submitted" });
      toast("日報を更新しました。おつかれさまでした!");
    } else {
      store.add("dailyReports", {
        staffId: me.id, storeId: me.storeId, date,
        ...v, aiSummary: null, status: "submitted",
      });
      toast("日報を提出しました。おつかれさまでした!");
    }
    renderAll();
  });

  const aiDraftBtn = aiButton("AIでコメントを下書き", async () => {
    await delay(1100);
    taComment.value = draftComment(collect());
    toast("AIが前向きな振り返りを下書きしました。仕上げはお好みで", "info");
  }, { small: true });

  const field = (label, input, hint) => el("div", { class: "field" },
    el("label", {}, label), input,
    hint ? el("span", { class: "hint" }, hint) : null);

  const formCard = card({
    title: "日報を提出",
    sub: `${store.storeName(me.storeId)}・${me.name}`,
    body: el("div", { class: "stack", style: { gap: "14px" } },
      el("div", { class: "nippo-lead" },
        icon("sparkle", 15),
        "入力は1分で終わります。数字を入れるだけ — 契約率の計算も評価用の集計もすべて自動です。"),
      el("div", { class: "flex wrap", style: { gap: "12px" } },
        el("div", { class: "field nippo-datefield" }, el("label", {}, "日付"), fDate),
        existBadge),
      el("div", { class: "nippo-numgrid" },
        field("売上(円)", inRevenue),
        field("物販(円)", inGoods),
        field("施術数(件)", inTreat),
        field("新規数(人)", inNew),
        field("回数券提案数(件)", inProp),
        field("成約数(件)", inCont),
        el("div", { class: "nippo-ratewrap" }, rateBox)),
      el("div", { class: "field" },
        el("div", { class: "flex between wrap", style: { gap: "8px" } },
          el("label", {}, "コメント(振り返り)"), aiDraftBtn),
        taComment),
      submitBtn,
      el("div", { class: "small muted", style: { textAlign: "center" } },
        "提出すると院長・統括にリアルタイムで共有されます")),
  });

  const side = el("div", { class: "stack", style: { gap: "16px" } },
    card({
      title: "本日の提出状況",
      sub: "院長・統括向け",
      class: "pad-sm",
      body: submissionStatusEl(todayStr()),
    }),
    evalNote(),
    card({
      title: "日報のコツ",
      class: "pad-sm",
      body: el("ul", { class: "nippo-tips" },
        el("li", {}, "数字は退勤打刻の前にサッと入力"),
        el("li", {}, "コメントに迷ったら「AIで下書き」"),
        el("li", {}, "個人評価の集計作業は不要。提出だけでOK")),
    }));

  return el("div", { class: "nippo-grid" }, formCard, side);
}

/* ---------------- タブ2:みんなの日報 ---------------- */

function allTab(renderAll) {
  const wrap = el("div", { class: "stack", style: { gap: "16px" } });
  const isToday = state.date >= todayStr();

  /* --- 日付ナビ + 店舗フィルタ --- */
  const nav = el("div", { class: "nippo-datenav" },
    el("button", {
      class: "icon-btn nav-chev", "aria-label": "前日",
      onclick: () => { state.date = addDays(state.date, -1); renderAll(); },
    }, icon("chevL", 18)),
    el("span", { class: "nippo-dateval" },
      fmtDate(state.date, { withYear: true }),
      isToday ? badge("今日", "accent") : null),
    el("button", {
      class: "icon-btn nav-chev", "aria-label": "翌日", disabled: isToday,
      onclick: () => { state.date = addDays(state.date, 1); renderAll(); },
    }, icon("chevR", 18)),
    !isToday ? el("button", {
      class: "btn ghost sm",
      onclick: () => { state.date = todayStr(); renderAll(); },
    }, "今日へ") : null);

  const seg = segmented(
    [{ id: "all", label: "全店" }, ...store.get("stores").map((s) => ({ id: s.id, label: s.short }))],
    state.storeFilter,
    (id) => { state.storeFilter = id; renderAll(); });

  wrap.appendChild(el("div", { class: "nippo-controls" }, nav, seg));
  wrap.appendChild(submissionStatusEl(state.date, state.storeFilter));

  /* --- テーブル(+合計行) --- */
  const reports = reportsOn(state.date, state.storeFilter)
    .slice().sort((a, b) => b.revenue - a.revenue);

  let tableEl;
  if (!reports.length) {
    tableEl = emptyState({
      icon: dow(state.date) === 3 ? "🌙" : "🗂",
      title: dow(state.date) === 3 ? "定休日(水曜)です" : "この日の日報はまだありません",
      hint: dow(state.date) === 3 ? "日報の提出対象日ではありません" : "前日・翌日で移動できます",
    });
  } else {
    const sum = (k) => reports.reduce((a, r) => a + (r[k] || 0), 0);
    const totalRow = {
      __total: true,
      revenue: sum("revenue"), treatments: sum("treatments"), newPatients: sum("newPatients"),
      proposals: sum("proposals"), contracts: sum("contracts"),
    };
    const b = (v) => el("strong", {}, v);
    tableEl = table({
      columns: [
        { key: "staffId", label: "スタッフ", render: (r) => r.__total
            ? el("span", { class: "flex", style: { gap: "7px" } }, b("合計"), el("span", { class: "small muted" }, `${reports.length}名`))
            : staffChip(r.staffId) },
        { key: "revenue", label: "売上", align: "right", render: (r) => r.__total ? b(fmtYen(r.revenue)) : fmtYen(r.revenue) },
        { key: "treatments", label: "施術", align: "right", render: (r) => r.__total ? b(fmtNum(r.treatments)) : fmtNum(r.treatments) },
        { key: "newPatients", label: "新規", align: "right", render: (r) => r.__total ? b(fmtNum(r.newPatients)) : fmtNum(r.newPatients) },
        { key: "proposals", label: "提案", align: "right", render: (r) => r.__total ? b(fmtNum(r.proposals)) : fmtNum(r.proposals) },
        { key: "contracts", label: "成約", align: "right", render: (r) => r.__total ? b(fmtNum(r.contracts)) : fmtNum(r.contracts) },
        { key: "rate", label: "契約率", align: "right", render: (r) => rateCell(r.contracts, r.proposals) },
        { key: "status", label: "状態", align: "center", render: (r) => r.__total ? "" : statusBadge(r.status) },
      ],
      rows: [...reports, totalRow],
    });
  }
  wrap.appendChild(card({
    title: "みんなの日報",
    sub: fmtDate(state.date),
    body: tableEl,
  }));

  /* --- 管理者向けAI要約 --- */
  const panel = aiPanel("AIデイリーサマリー");
  panel.el.style.display = "none";
  const summaryBtn = aiButton("AIで本日を要約", async () => {
    panel.el.style.display = "";
    panel.thinking("この日の日報を読み込んでいます");
    const res = await summarizeReports(reports);
    panel.setHTML(`
      <p><strong>${esc(res.summary)}</strong></p>
      <ul>
        <li>${esc(res.highlight)}</li>
        <li>${esc(res.concern)}</li>
      </ul>
      <h4>次のアクション</h4>
      <p>${esc(res.advice)}</p>`);
  });
  if (!reports.length) summaryBtn.disabled = true;

  wrap.appendChild(card({
    title: "管理者向けAI要約",
    sub: "全員分のコメントを読む作業をなくします",
    actions: summaryBtn,
    body: el("div", { class: "stack", style: { gap: "10px" } },
      el("div", { class: "small muted" },
        "その日の全日報をAIが「実績サマリー/好調要因/気になる声/次のアクション」に整理します。"),
      panel.el),
  }));

  return wrap;
}

/* ---------------- タブ3:自分の推移 ---------------- */

function meTab() {
  const me = store.me();
  const my = store.get("dailyReports").filter((r) => r.staffId === me.id);
  const byDate = new Map(my.map((r) => [r.date, r]));

  /* --- 直近30日の売上ライン --- */
  const labels = [];
  const values = [];
  for (let off = -29; off <= 0; off++) {
    const d = addDays(todayStr(), off);
    const [, m, dd] = d.split("-").map(Number);
    labels.push(`${m}/${dd}`);
    values.push(byDate.get(d)?.revenue || 0);
  }
  const chart = lineChart({
    series: [{ name: "売上", values }],
    labels,
    fillFirst: true,
    height: 240,
    yFmt: (v) => (v >= 1000 ? `¥${Math.round(v / 1000)}k` : `¥${Math.round(v)}`),
  });

  /* --- 今月の合計 --- */
  const month = monthOf(todayStr());
  const inMonth = my.filter((r) => monthOf(r.date) === month);
  const sum = (k) => inMonth.reduce((a, r) => a + (r[k] || 0), 0);
  const totP = sum("proposals"), totC = sum("contracts");
  const mRate = rateOf(totC, totP);
  const monthLabel = `${Number(month.slice(5, 7))}月の実績`;
  const spark = sparkline({ values: values.slice(-14), width: 90, height: 30 });

  return el("div", { class: "stack", style: { gap: "16px" } },
    evalNote(),
    el("div", { class: "kpi-row" },
      statTile({ label: `売上(${monthLabel})`, value: fmtYen(sum("revenue")), icon: "cash", tone: "brand", sub: "日報から自動集計", spark }),
      statTile({ label: `施術数(${monthLabel})`, value: `${fmtNum(sum("treatments"))}件`, icon: "body", tone: "accent", sub: `新規 ${fmtNum(sum("newPatients"))}名` }),
      statTile({ label: `成約数(${monthLabel})`, value: `${fmtNum(totC)}件`, icon: "ticket", tone: "good", sub: `提案 ${fmtNum(totP)}件` }),
      statTile({ label: `契約率(${monthLabel})`, value: mRate == null ? "—" : `${mRate}%`, icon: "target", tone: "violet", sub: "成約数 ÷ 提案数で自動計算" })),
    card({
      title: "直近30日の売上推移",
      sub: `${me.name}(提出済みの日報から自動生成)`,
      body: chart,
    }));
}

/* ---------------- ページ本体 ---------------- */

export default {
  id: "nippo",
  title: "日報",
  icon: "report",
  render(root, params) {
    if (params?.[0] && ["submit", "all", "me"].includes(params[0])) state.tab = params[0];

    const renderAll = () => {
      clear(root);
      root.append(
        sectionHeader("日報", "数字を入れるだけで契約率は自動計算。個人評価の集計もAI要約もおまかせ。"),
        tabs([
          { id: "submit", label: "提出する" },
          { id: "all", label: "みんなの日報" },
          { id: "me", label: "自分の推移" },
        ], state.tab, (id) => { state.tab = id; renderAll(); }),
        state.tab === "submit" ? submitTab(renderAll)
          : state.tab === "all" ? allTab(renderAll)
          : meTab());
    };
    renderAll();
  },
};
