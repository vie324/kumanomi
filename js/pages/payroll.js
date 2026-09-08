/* ============================================================
   給与確認 — 事務職員向け
   給与に直結するデータを1欄で最終確認し、社労士へ提出するページ。
   タブ: 勤怠サマリー / 経費申請 / 交通費申請 / 発注 / 社労士へ提出
   各タブの表はそのまま CSV(Excelでそのまま開ける)で書き出せる。
   「社労士へ提出」は実際に送付している給与連絡表と同じ列構成で、
   勤怠から自動算出できる項目を埋め、手入力項目だけを事務が補う。
   閲覧: 事務職員・本部人事・統括マネージャー以上(payroll.view)
   ============================================================ */
import { store, todayStr, monthOf, SHIFT_TYPES } from "../store.js";
import {
  el, clear, icon, card, sectionHeader, statTile, badge, statusBadge,
  staffChip, table, tabs, segmented, modal, toast, fmtDate, fmtYen, fmtNum,
  emptyState, downloadCSV, openImageModal,
} from "../ui.js";
import { can, rankLabel } from "../auth.js";

/* ---------------- ヘルパー ---------------- */
const pad2 = (n) => String(n).padStart(2, "0");
const toMin = (hm) => (hm ? Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)) : null);
/** 実働時間(休憩控除後) */
const workedH = (a) => (a?.clockIn && a?.clockOut)
  ? Math.max(0, (toMin(a.clockOut) - toMin(a.clockIn) - (a.breakMin || 0)) / 60)
  : 0;
const STD_H = 8; // 所定労働時間(1日)
const otH = (a) => Math.max(0, workedH(a) - STD_H);
const h1 = (v) => `${(Math.round(v * 10) / 10).toFixed(1)}h`;
const r1 = (v) => Math.round(v * 10) / 10;

function monthShift(month, n) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
const monthLabelJa = (month) => `${month.slice(0, 4)}年${Number(month.slice(5))}月`;

/** 22:00〜24:00 の勤務時間(分)。日跨ぎの深夜勤務は現行シフトに無いため扱わない */
const NIGHT_START = 22 * 60;
function nightMin(a) {
  if (!a?.clockIn || !a?.clockOut) return 0;
  return Math.max(0, Math.min(toMin(a.clockOut), 24 * 60) - Math.max(toMin(a.clockIn), NIGHT_START));
}
/** 法定休日(週1日の休日)。この院は水曜定休のため水曜を法定休日として扱う */
const LEGAL_HOLIDAY_DOW = 3;
const dowOf = (dateStr) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
};
const OFF_TYPES = ["off", "paid", "special", "birthday"];

/**
 * 給与集計(スタッフ×月)。社労士へ提出する給与連絡表の項目をすべて算出する。
 * 出勤日数 / 有給 / 特別休暇 / 欠勤 / 就労時間 / 普通残業 / 深夜残業 /
 * 休日勤務 / 法定内残業 / 遅早(回数・時間) / 法定休日勤務 / 非課税通勤手当
 */
function payrollSummary(month, staffList) {
  const today = todayStr();
  const attAll = store.get("attendance");
  const shiftAll = store.get("shifts");
  const expAll = store.get("expenses") || [];
  const adjAll = store.get("payrollAdjustments") || [];

  return staffList.map((s) => {
    const recs = attAll.filter((a) => a.staffId === s.id && monthOf(a.date) === month);
    const shs = shiftAll.filter((x) => x.staffId === s.id && monthOf(x.date) === month);
    const attByDate = new Map(recs.map((a) => [a.date, a]));
    const shiftByDate = new Map(shs.map((x) => [x.date, x]));

    let workDays = 0, worked = 0, ot = 0, nightOt = 0;
    let holidayH = 0, legalHolidayH = 0;
    let lateN = 0, lateMin = 0, earlyN = 0, earlyMin = 0;

    for (const a of recs) {
      if (a.clockIn) workDays++;
      const h = workedH(a);
      worked += h;
      const night = nightMin(a) / 60;
      nightOt += night;
      // 普通残業は深夜割増分と重複しないよう、深夜分を差し引く
      ot += Math.max(0, otH(a) - night);

      const planned = shiftByDate.get(a.date);
      if (h > 0) {
        if (dowOf(a.date) === LEGAL_HOLIDAY_DOW) legalHolidayH += h;
        else if (!planned || OFF_TYPES.includes(planned.type)) holidayH += h;
      }

      const t = SHIFT_TYPES[a.shiftType] || {};
      if (a.status === "late" && a.clockIn && t.start) {
        lateN++;
        lateMin += Math.max(0, toMin(a.clockIn) - toMin(t.start));
      }
      if (a.clockOut && t.end && toMin(a.clockOut) < toMin(t.end)) {
        earlyN++;
        earlyMin += toMin(t.end) - toMin(a.clockOut);
      }
    }

    const paidDays = shs.filter((x) => x.type === "paid").length;
    const specialDays = shs.filter((x) => ["special", "birthday"].includes(x.type)).length;
    // 欠勤 = 勤務予定(過去日)なのに打刻がまったくない日
    let absentDays = 0;
    for (const x of shs) {
      if (x.date >= today) continue;
      if (OFF_TYPES.includes(x.type)) continue;
      const a = attByDate.get(x.date);
      if (!a || (!a.clockIn && !a.clockOut)) absentDays++;
    }

    // 承認済みの交通費を非課税通勤手当として集計する
    const commuteFree = expAll
      .filter((e) => e.staffId === s.id && e.category === "交通費"
        && e.status === "approved" && monthOf(e.date) === month)
      .reduce((sum, e) => sum + e.amount, 0);

    const adj = adjAll.find((x) => x.staffId === s.id && x.month === month) || null;

    return {
      staff: s, workDays, worked, ot, nightOt, holidayH, legalHolidayH,
      // 所定労働時間=法定labor時間(8h/日)のため、法定内残業は発生しない
      legalInnerOt: 0,
      paidDays, specialDays, absentDays,
      lateN, lateMin, earlyN, earlyMin,
      lateEarlyN: lateN + earlyN,
      lateEarlyMin: lateMin + earlyMin,
      commuteFree,
      adj,
    };
  });
}

/* ============================================================
   ページ本体
   ============================================================ */
export default {
  id: "payroll",
  title: "給与確認",
  icon: "cash",

  // このページが必要とするデータ。ルーターがそろえてから render() を呼ぶ
  needs: ["attendance", "expenses", "orders", "payrollAdjustments", "sharoushiSubmissions", "shifts", "staff", "stores"],
  render(root) {
    /* ---------------- 権限ゲート ---------------- */
    if (!can("payroll.view")) {
      root.appendChild(el("div", { class: "perm-gate" },
        el("div", { class: "pg-ic" }, icon("alert", 26)),
        el("div", { class: "pg-title" }, "給与確認を表示する権限がありません"),
        el("div", { class: "pg-desc" },
          "このページは給与に直結する勤怠・経費・交通費・発注のデータを扱うため、事務職員・本部人事・統括マネージャー以上のみ閲覧できます。"),
        el("div", { class: "pg-actions" },
          el("button", { class: "btn primary", onclick: () => { location.hash = "#/kintai"; } },
            icon("clock", 15), "自分の勤怠へ"),
          el("button", { class: "btn ghost", onclick: () => document.querySelector(".topbar-user")?.click() },
            icon("user", 15), "ログインユーザーを切り替える"))));
      return;
    }

    const today = todayStr();
    const state = { month: monthOf(today), storeId: "all", tab: "kintai" };

    const staffList = () => store.get("staff")
      .filter((s) => state.storeId === "all" || s.storeId === state.storeId);
    const staffIds = () => new Set(staffList().map((s) => s.id));
    const monthExpenses = () => store.get("expenses")
      .filter((e) => monthOf(e.date) === state.month && staffIds().has(e.staffId));
    const monthOrders = () => store.get("orders")
      .filter((o) => monthOf(o.date) === state.month && (state.storeId === "all" || o.storeId === state.storeId));

    /* ---------------- フィルタ行 ---------------- */
    const filterWrap = el("div", { class: "pr-filters" });
    function renderFilters() {
      clear(filterWrap);
      const isThisMonth = state.month === monthOf(today);
      filterWrap.append(
        el("div", { class: "pr-monthnav" },
          el("button", { class: "icon-btn", "aria-label": "前月", onclick: () => { state.month = monthShift(state.month, -1); renderAll(); } }, icon("chevL", 18)),
          el("span", { class: "pr-month" }, monthLabelJa(state.month)),
          el("button", { class: "icon-btn", "aria-label": "翌月", onclick: () => { state.month = monthShift(state.month, 1); renderAll(); } }, icon("chevR", 18)),
          isThisMonth
            ? badge("今月", "accent")
            : el("button", { class: "btn ghost sm", onclick: () => { state.month = monthOf(today); renderAll(); } }, "今月へ")),
        segmented(
          [{ id: "all", label: "全店" }, ...store.get("stores").map((s) => ({ id: s.id, label: s.short }))],
          state.storeId,
          (id) => { state.storeId = id; renderAll(); }),
      );
    }

    /* ---------------- KPI ---------------- */
    const kpiWrap = el("div", {});
    function renderKpi() {
      clear(kpiWrap);
      const sums = payrollSummary(state.month, staffList());
      const exps = monthExpenses();
      const transport = exps.filter((e) => e.category === "交通費");
      const others = exps.filter((e) => e.category !== "交通費");
      const orders = monthOrders();
      kpiWrap.appendChild(el("div", { class: "kpi-row" },
        statTile({ label: "勤怠の確認対象", value: `${sums.length}名`, icon: "users", tone: "brand", sub: `出勤合計 ${fmtNum(sums.reduce((a, r) => a + r.workDays, 0))}日` }),
        statTile({ label: "経費申請(交通費除く)", value: fmtYen(others.reduce((a, e) => a + e.amount, 0)), icon: "report", tone: "accent", sub: `${others.length}件・承認待ち ${others.filter((e) => e.status === "pending").length}件` }),
        statTile({ label: "交通費申請", value: fmtYen(transport.reduce((a, e) => a + e.amount, 0)), icon: "gps", tone: "good", sub: `${transport.length}件・承認待ち ${transport.filter((e) => e.status === "pending").length}件` }),
        statTile({ label: "発注金額", value: fmtYen(orders.reduce((a, o) => a + o.amount, 0)), icon: "box", tone: "warn", sub: `${orders.length}件の発注` })));
    }

    /* ---------------- タブ ---------------- */
    const tabsWrap = el("div", {});
    const bodyWrap = el("div", {});
    function renderTabs() {
      clear(tabsWrap);
      const exps = monthExpenses();
      tabsWrap.appendChild(tabs([
        { id: "kintai", label: "勤怠サマリー", badge: staffList().length },
        { id: "expense", label: "経費申請", badge: exps.filter((e) => e.category !== "交通費").length },
        { id: "transport", label: "交通費申請", badge: exps.filter((e) => e.category === "交通費").length },
        { id: "order", label: "発注", badge: monthOrders().length },
        { id: "sharoushi", label: "📤 社労士へ提出" },
      ], state.tab, (id) => { state.tab = id; renderTabs(); renderBody(); }));
    }

    const exportBtn = (label, onClick) =>
      el("button", { class: "btn soft sm", onclick: onClick }, icon("download", 14), label);

    /* ============================================================
       タブ1:勤怠サマリー(1欄で最終確認)
       ============================================================ */
    function kintaiTab() {
      const rows = payrollSummary(state.month, staffList());

      const columns = [
        { key: "staff", label: "スタッフ", render: (r) => staffChip(r.staff.id, { size: 26, withRole: false }) },
        { key: "store", label: "店舗", render: (r) => el("span", { class: "small muted" }, store.storeName(r.staff.storeId)) },
        { key: "workDays", label: "出勤数", align: "right", render: (r) => `${r.workDays}日` },
        { key: "worked", label: "勤務時間", align: "right", render: (r) => el("b", { class: "mono-num" }, h1(r.worked)) },
        { key: "paidDays", label: "有給", align: "right", render: (r) => r.paidDays ? `${r.paidDays}日` : el("span", { class: "muted" }, "—") },
        { key: "specialDays", label: "特休", align: "right", render: (r) => r.specialDays ? `${r.specialDays}日` : el("span", { class: "muted" }, "—") },
        { key: "absentDays", label: "欠勤", align: "right", render: (r) => r.absentDays ? el("span", { class: "pr-bad" }, `${r.absentDays}日`) : el("span", { class: "muted" }, "—") },
        { key: "ot", label: "残業", align: "right", render: (r) => el("span", { class: r.ot >= 30 ? "pr-warn" : "" }, h1(r.ot)) },
        {
          key: "late", label: "遅刻(回・時間)", align: "right",
          render: (r) => r.lateN
            ? el("span", { class: "pr-warn" }, `${r.lateN}回・${fmtNum(r.lateMin)}分`)
            : el("span", { class: "muted" }, "—"),
        },
        {
          key: "early", label: "早退(回・時間)", align: "right",
          render: (r) => r.earlyN
            ? el("span", { class: "pr-warn" }, `${r.earlyN}回・${fmtNum(r.earlyMin)}分`)
            : el("span", { class: "muted" }, "—"),
        },
      ];

      const doExport = () => {
        const data = [
          ["対象月", monthLabelJa(state.month), "書き出し日", fmtDate(today, { withYear: true })],
          ["スタッフ", "店舗", "役職", "出勤数(日)", "勤務時間(h)", "有給休暇(日)", "特別休暇(日)", "欠勤(日)", "残業時間(h)", "遅刻回数", "遅刻時間(分)", "早退回数", "早退時間(分)"],
          ...rows.map((r) => [
            r.staff.name, store.storeName(r.staff.storeId), r.staff.role,
            r.workDays, r1(r.worked), r.paidDays, r.specialDays, r.absentDays,
            r1(r.ot), r.lateN, r.lateMin, r.earlyN, r.earlyMin,
          ]),
        ];
        downloadCSV(`勤怠サマリー_${state.month}.csv`, data);
        toast("勤怠サマリーをCSVで書き出しました(Excelでそのまま開けます)");
      };

      return card({
        title: "勤怠サマリー(1欄で最終確認)",
        sub: `${monthLabelJa(state.month)}・${rows.length}名`,
        actions: exportBtn("CSVで書き出し(Excel)", doExport),
        body: el("div", {},
          el("div", { class: "pr-copy" }, icon("info", 15),
            el("span", {}, "出勤数・勤務時間・有給・特別休暇・欠勤・残業・遅刻・早退を1つの表で確認できます。特別休暇には誕生日休暇を含みます。残業は「実働(休憩控除後)− 所定8時間/日」の合計、有給・特休は確定シフト上の日数です。")),
          rows.length
            ? table({ columns, rows })
            : emptyState({ icon: "🗂", title: "対象のスタッフがいません" })),
      });
    }

    /* ============================================================
       タブ2・3:経費申請 / 交通費申請
       ============================================================ */
    function expenseColumns({ transport = false } = {}) {
      const cols = [
        { key: "date", label: "申請日", render: (e) => fmtDate(e.date) },
        { key: "staff", label: "申請者", render: (e) => staffChip(e.staffId, { size: 26, withRole: false }) },
        { key: "store", label: "店舗", render: (e) => el("span", { class: "small muted" }, store.storeName(store.byId("staff", e.staffId)?.storeId)) },
      ];
      if (transport) {
        cols.push(
          {
            key: "route", label: "区間", render: (e) => e.routeFrom
              ? el("span", { class: "pr-route" }, `${e.routeFrom} → ${e.routeTo}`)
              : el("span", { class: "muted" }, "—"),
          },
          { key: "dist", label: "距離", align: "right", render: (e) => e.distanceKm ? `${e.distanceKm}km` : el("span", { class: "muted" }, "—") },
        );
      } else {
        cols.push(
          { key: "category", label: "カテゴリ", render: (e) => badge(e.category) },
          { key: "memo", label: "内容", render: (e) => el("span", { class: "pr-memo" }, e.memo || "—") },
        );
      }
      cols.push(
        {
          key: "receipt", label: "領収書", align: "center",
          render: (e) => e.receiptImage
            ? el("button", {
                class: "pr-receipt", "aria-label": "領収書画像を見る",
                onclick: () => openImageModal(e.receiptImage, `領収書 — ${store.staffName(e.staffId)}(${fmtDate(e.date)})`),
              }, el("img", { src: e.receiptImage, alt: "領収書" }))
            : el("span", { class: "muted small" }, "なし"),
        },
        { key: "amount", label: "金額", align: "right", render: (e) => el("b", { class: "mono-num" }, fmtYen(e.amount)) },
        { key: "status", label: "ステータス", align: "center", render: (e) => statusBadge(e.status) },
        {
          key: "by", label: "承認者・理由", render: (e) =>
            e.status === "approved" ? el("span", { class: "small muted" }, store.staffName(e.approvedBy))
            : e.status === "rejected" ? el("span", { class: "small muted" }, e.rejectReason || "—")
            : el("span", { class: "small muted" }, "承認待ち"),
        },
      );
      return cols;
    }

    function expenseExportRows(rows, { transport = false } = {}) {
      const statusJa = { pending: "承認待ち", approved: "承認済", rejected: "却下" };
      const head = transport
        ? ["申請日", "申請者", "店舗", "出発地", "到着地", "距離(km)", "金額(円)", "ステータス", "承認者", "却下理由", "メモ"]
        : ["申請日", "申請者", "店舗", "カテゴリ", "内容", "金額(円)", "ステータス", "承認者", "却下理由"];
      return [
        ["対象月", monthLabelJa(state.month), "書き出し日", fmtDate(today, { withYear: true })],
        head,
        ...rows.map((e) => transport
          ? [e.date, store.staffName(e.staffId), store.storeName(store.byId("staff", e.staffId)?.storeId),
             e.routeFrom || "", e.routeTo || "", e.distanceKm || "", e.amount,
             statusJa[e.status] || e.status, e.approvedBy ? store.staffName(e.approvedBy) : "", e.rejectReason || "", e.memo || ""]
          : [e.date, store.staffName(e.staffId), store.storeName(store.byId("staff", e.staffId)?.storeId),
             e.category, e.memo || "", e.amount,
             statusJa[e.status] || e.status, e.approvedBy ? store.staffName(e.approvedBy) : "", e.rejectReason || ""]),
      ];
    }

    function expenseTab({ transport = false } = {}) {
      const rows = monthExpenses()
        .filter((e) => (e.category === "交通費") === transport)
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      const total = rows.reduce((a, e) => a + e.amount, 0);
      const approved = rows.filter((e) => e.status === "approved").reduce((a, e) => a + e.amount, 0);
      const label = transport ? "交通費申請" : "経費申請";

      const doExport = () => {
        downloadCSV(`${label}_${state.month}.csv`, expenseExportRows(rows, { transport }));
        toast(`${label}の一覧をCSVで書き出しました(Excelでそのまま開けます)`);
      };

      return card({
        title: `${label}(1欄で最終確認)`,
        sub: `${monthLabelJa(state.month)}・${rows.length}件・申請合計 ${fmtYen(total)} / 承認済 ${fmtYen(approved)}`,
        actions: exportBtn("CSVで書き出し(Excel)", doExport),
        body: el("div", {},
          el("div", { class: "pr-copy" }, icon("info", 15),
            el("span", {}, transport
              ? "交通費(区間・距離つき)の申請を月ごとに確認できます。承認済の金額が給与と合わせて精算されます。"
              : "交通費以外の経費申請を月ごとに確認できます。領収書サムネイルをクリックすると原本画像を確認できます。")),
          rows.length
            ? table({ columns: expenseColumns({ transport }), rows })
            : emptyState({ icon: transport ? "🚃" : "🧾", title: `この月の${label}はありません`, hint: "月・店舗の絞り込みを変えてみてください" })),
      });
    }

    /* ============================================================
       タブ4:発注
       ============================================================ */
    function orderTab() {
      const rows = monthOrders().sort((a, b) => (a.date < b.date ? 1 : -1));
      const total = rows.reduce((a, o) => a + o.amount, 0);

      const orderBadge = (o) => o.status === "received"
        ? badge("入荷済", "good")
        : badge("発注済(入荷待ち)", "warn");

      const columns = [
        { key: "date", label: "発注日", render: (o) => fmtDate(o.date) },
        { key: "item", label: "品目", render: (o) => el("span", { class: "pr-item" }, o.itemName) },
        { key: "qty", label: "数量", align: "right", render: (o) => `${fmtNum(o.qty)}${o.unit || ""}` },
        { key: "unitPrice", label: "単価", align: "right", render: (o) => el("span", { class: "mono-num" }, fmtYen(o.unitPrice)) },
        { key: "amount", label: "金額", align: "right", render: (o) => el("b", { class: "mono-num" }, fmtYen(o.amount)) },
        { key: "supplier", label: "仕入先", render: (o) => o.supplier || "—" },
        { key: "staff", label: "発注者", render: (o) => staffChip(o.staffId, { size: 26, withRole: false }) },
        { key: "store", label: "店舗", render: (o) => el("span", { class: "small muted" }, store.storeName(o.storeId)) },
        { key: "status", label: "状態", align: "center", render: orderBadge },
      ];

      const doExport = () => {
        const statusJa = { ordered: "発注済(入荷待ち)", received: "入荷済" };
        const data = [
          ["対象月", monthLabelJa(state.month), "書き出し日", fmtDate(today, { withYear: true })],
          ["発注日", "品目", "数量", "単位", "単価(円)", "金額(円)", "仕入先", "発注者", "店舗", "状態", "メモ"],
          ...rows.map((o) => [
            o.date, o.itemName, o.qty, o.unit || "", o.unitPrice, o.amount,
            o.supplier || "", store.staffName(o.staffId), store.storeName(o.storeId),
            statusJa[o.status] || o.status, o.note || "",
          ]),
        ];
        downloadCSV(`発注一覧_${state.month}.csv`, data);
        toast("発注の一覧をCSVで書き出しました(Excelでそのまま開けます)");
      };

      return card({
        title: "発注(1欄で最終確認)",
        sub: `${monthLabelJa(state.month)}・${rows.length}件・発注合計 ${fmtYen(total)}`,
        actions: exportBtn("CSVで書き出し(Excel)", doExport),
        body: el("div", {},
          el("div", { class: "pr-copy" }, icon("info", 15),
            el("span", {}, "在庫・経費ページで行われた発注が自動で記録されます。品目・数量・金額・発注者を月ごとに確認できます。")),
          rows.length
            ? table({ columns, rows })
            : emptyState({ icon: "📦", title: "この月の発注はありません", hint: "月・店舗の絞り込みを変えてみてください" })),
      });
    }

    /* ============================================================
       タブ5:社労士へ提出(給与連絡表)
       ============================================================ */

    /** 提出先・締日・支給日の設定 */
    const sharoushi = () => store.state.settings.sharoushi || {};

    /** 賃金締日・支給日を対象月から組み立てる(締=当月末、支給=翌月25日) */
    function periodOf(month) {
      const cfg = sharoushi();
      const [y, m] = month.split("-").map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      const closing = `${y}-${pad2(m)}-${pad2(Math.min(cfg.closingDay || 31, lastDay))}`;
      const pd = new Date(y, m, cfg.payDay || 25);
      const pay = `${pd.getFullYear()}-${pad2(pd.getMonth() + 1)}-${pad2(pd.getDate())}`;
      return { closing, pay };
    }

    /** 所属表記:(34)成増店 の形 */
    const deptLabel = (s) => {
      const st = store.byId("stores", s.storeId);
      return st ? `(${st.deptCode || "--"})${st.name}` : "—";
    };

    /** 給与連絡表の列定義。auto=システム算出 / manual=事務での手入力 */
    const SHAROUSHI_COLUMNS = [
      { key: "dept", label: "所属", kind: "auto", get: (r) => deptLabel(r.staff) },
      { key: "empCode", label: "社員コード", kind: "auto", get: (r) => r.staff.empCode || "" },
      { key: "name", label: "社員", kind: "auto", get: (r) => r.staff.name },
      { key: "workDays", label: "出勤日数", kind: "auto", num: true, get: (r) => r.workDays },
      { key: "paidDays", label: "有給日数", kind: "auto", num: true, get: (r) => r.paidDays },
      { key: "specialDays", label: "特別休暇日数", kind: "auto", num: true, get: (r) => r.specialDays },
      { key: "absentDays", label: "欠勤日数", kind: "auto", num: true, get: (r) => r.absentDays },
      { key: "worked", label: "就労時間", kind: "auto", num: true, get: (r) => r1(r.worked) },
      { key: "ot", label: "普通残業", kind: "auto", num: true, get: (r) => r1(r.ot) },
      { key: "nightOt", label: "深夜残業", kind: "auto", num: true, get: (r) => r1(r.nightOt) },
      { key: "holidayH", label: "休日勤務時間", kind: "auto", num: true, get: (r) => r1(r.holidayH) },
      { key: "legalInnerOt", label: "法定内残業時間", kind: "auto", num: true, get: (r) => r1(r.legalInnerOt) },
      { key: "lateEarlyN", label: "遅早回数", kind: "auto", num: true, get: (r) => r.lateEarlyN },
      { key: "lateEarlyMin", label: "遅早時間", kind: "auto", num: true, get: (r) => r.lateEarlyMin },
      { key: "legalHolidayH", label: "法定休日勤務時間", kind: "auto", num: true, get: (r) => r1(r.legalHolidayH) },
      { key: "taxableCommute", label: "課税通勤手当", kind: "manual", num: true, get: (r) => r.adj?.taxableCommute || 0 },
      { key: "retroAdjust", label: "遡及調整", kind: "manual", num: true, get: (r) => r.adj?.retroAdjust || 0 },
      { key: "commuteFree", label: "非課税通勤手当", kind: "auto", num: true, get: (r) => r.commuteFree },
      { key: "retroFree", label: "非課税遡及", kind: "manual", num: true, get: (r) => r.adj?.retroFree || 0 },
      { key: "achievement", label: "アチーブメント代", kind: "manual", num: true, get: (r) => r.adj?.achievement || 0 },
      { key: "advance", label: "前借金", kind: "manual", num: true, get: (r) => r.adj?.advance || 0 },
      { key: "otherDeduction", label: "その他控除", kind: "manual", num: true, get: (r) => r.adj?.otherDeduction || 0 },
    ];

    /** 手入力項目(アチーブメント代・前借金など)の編集 */
    function openAdjustModal(r) {
      const yenIn = (v) => el("input", {
        class: "input", type: "number", step: "1", inputmode: "numeric",
        value: String(v || 0),
      });
      const taxable = yenIn(r.adj?.taxableCommute);
      const retro = yenIn(r.adj?.retroAdjust);
      const retroFree = yenIn(r.adj?.retroFree);
      const achievement = yenIn(r.adj?.achievement);
      const advance = yenIn(r.adj?.advance);
      const other = yenIn(r.adj?.otherDeduction);
      const memo = el("input", { class: "input", type: "text", value: r.adj?.memo || "", placeholder: "社労士への申し送り(任意)" });

      const field = (label, input) => el("div", { class: "field" }, el("label", {}, label), input);
      const okBtn = el("button", { class: "btn primary" }, icon("check", 15), "保存する");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: `手入力項目 — ${r.staff.name}(${monthLabelJa(state.month)})`,
        body: el("div", { class: "page-payroll" },
          el("div", { class: "stack", style: { gap: "12px" } },
            el("div", { class: "pr-copy" }, icon("info", 15),
              el("span", {}, "勤怠から自動算出できない項目です。ここで入力すると、社労士へ提出する給与連絡表にそのまま反映されます。")),
            el("div", { class: "form-row" }, field("課税通勤手当(円)", taxable), field("非課税通勤手当(円)",
              el("input", { class: "input", type: "text", value: fmtYen(r.commuteFree), disabled: true }))),
            el("div", { class: "form-row" }, field("遡及調整(円)", retro), field("非課税遡及(円)", retroFree)),
            el("div", { class: "form-row" }, field("アチーブメント代(円)", achievement), field("前借金(円)", advance)),
            el("div", { class: "form-row" }, field("その他控除(円)", other), field("申し送りメモ", memo)),
            el("p", { class: "small muted" },
              "非課税通勤手当は、承認済みの交通費申請から自動集計しているため編集できません。"))),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      okBtn.addEventListener("click", () => {
        const num = (i) => Math.round(Number(i.value) || 0);
        const patch = {
          taxableCommute: num(taxable), retroAdjust: num(retro), retroFree: num(retroFree),
          achievement: num(achievement), advance: num(advance), otherDeduction: num(other),
          memo: memo.value.trim(),
        };
        if (r.adj) store.update("payrollAdjustments", r.adj.id, patch);
        else store.add("payrollAdjustments", { staffId: r.staff.id, month: state.month, ...patch });
        m.close();
        toast(`${r.staff.name}さんの手入力項目を保存しました`);
        renderAll();
      });
    }

    /** 提出先(社労士)の設定 */
    function openSharoushiSettingModal() {
      const cfg = sharoushi();
      const txt = (v, ph) => el("input", { class: "input", type: "text", value: v || "", placeholder: ph });
      const officeIn = txt(cfg.officeName, "例)さくら社会保険労務士事務所");
      const contactIn = txt(cfg.contactName, "例)櫻井 恵子");
      const mailIn = el("input", { class: "input", type: "email", value: cfg.email || "", placeholder: "payroll@example.jp" });
      const codeIn = txt(cfg.companyCode, "例)2306");
      const nameIn = txt(cfg.companyName, "例)株式会社くまのみ");
      const closeIn = el("input", { class: "input", type: "number", min: "1", max: "31", value: String(cfg.closingDay || 31) });
      const payIn = el("input", { class: "input", type: "number", min: "1", max: "31", value: String(cfg.payDay || 25) });

      const field = (label, input, hint) => el("div", { class: "field" },
        el("label", {}, label), input, hint ? el("span", { class: "hint" }, hint) : null);
      const okBtn = el("button", { class: "btn primary" }, icon("check", 15), "保存する");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: "社労士の提出先・給与連絡表の設定",
        body: el("div", { class: "page-payroll" },
          el("div", { class: "stack", style: { gap: "12px" } },
            el("div", { class: "form-row" }, field("社労士事務所名", officeIn), field("担当者名", contactIn)),
            field("送信先メールアドレス", mailIn, "「社労士に提出」を押すと、この宛先へのメール下書きが開きます"),
            el("div", { class: "form-row" }, field("事業所コード", codeIn), field("会社名", nameIn)),
            el("div", { class: "form-row" },
              field("賃金締日(日)", closeIn, "月末締めなら31"),
              field("支給日(翌月・日)", payIn)))),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      okBtn.addEventListener("click", () => {
        store.setSetting("sharoushi", {
          officeName: officeIn.value.trim(),
          contactName: contactIn.value.trim(),
          email: mailIn.value.trim(),
          companyCode: codeIn.value.trim(),
          companyName: nameIn.value.trim(),
          closingDay: Math.min(31, Math.max(1, Number(closeIn.value) || 31)),
          payDay: Math.min(31, Math.max(1, Number(payIn.value) || 25)),
        });
        m.close();
        toast("社労士の提出先を保存しました");
        renderAll();
      });
    }

    /** 提出前チェック:これが残っていると数字が確定しない */
    function submissionIssues(rows) {
      const ids = staffIds();
      const issues = [];
      const unapproved = store.get("attendance")
        .filter((a) => monthOf(a.date) === state.month && ids.has(a.staffId) && !a.approved && a.date < today);
      if (unapproved.length) {
        issues.push({
          label: `未承認の勤怠が ${unapproved.length}件`,
          hint: "承認前の打刻は就労時間・残業に反映済みですが、確定前の数字です。勤怠管理から承認してください。",
          tab: "kintai",
        });
      }
      const pendingExp = monthExpenses().filter((e) => e.status === "pending");
      if (pendingExp.length) {
        issues.push({
          label: `承認待ちの経費・交通費が ${pendingExp.length}件`,
          hint: "承認済みの交通費だけが非課税通勤手当に集計されます。先に承認・却下を済ませてください。",
          tab: "expense",
        });
      }
      const missingCode = rows.filter((r) => !r.staff.empCode);
      if (missingCode.length) {
        issues.push({
          label: `社員コード未設定が ${missingCode.length}名`,
          hint: `${missingCode.map((r) => r.staff.name).join("・")}。社労士側の突合に必要です。`,
          tab: null,
        });
      }
      return issues;
    }

    /** 給与連絡表の CSV(実際の提出フォーマットに合わせたヘッダー付き) */
    function sharoushiCsvRows(rows) {
      const cfg = sharoushi();
      const { closing, pay } = periodOf(state.month);
      const jpDate = (d) => `${d.slice(0, 4)}/${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
      return [
        [monthLabelJa(state.month), "", "", "給与連絡表"],
        ["", "", "", "", "", "", "賃金締日", jpDate(closing), "支給日", jpDate(pay)],
        [cfg.companyCode || "", cfg.companyName || ""],
        ["", ...SHAROUSHI_COLUMNS.map((c) => c.label)],
        ...rows.map((r) => ["", ...SHAROUSHI_COLUMNS.map((c) => c.get(r))]),
      ];
    }

    function doSharoushiExport(rows) {
      downloadCSV(`給与連絡表_${state.month}.csv`, sharoushiCsvRows(rows));
      toast("給与連絡表をCSVで書き出しました(Excelでそのまま開けます)");
    }

    /** 提出:CSVを書き出し、履歴に記録し、メール下書きを開く */
    function doSubmit(rows) {
      const cfg = sharoushi();
      const { closing, pay } = periodOf(state.month);
      const fileName = `給与連絡表_${state.month}.csv`;
      downloadCSV(fileName, sharoushiCsvRows(rows));
      store.add("sharoushiSubmissions", {
        month: state.month,
        submittedBy: store.me().id,
        submittedAt: new Date().toISOString(),
        staffCount: rows.length,
        fileName,
        to: cfg.email || "",
        note: state.storeId === "all" ? "" : `${store.storeName(state.storeId)}のみ`,
      });
      const subject = `【${cfg.companyName || "当社"}】${monthLabelJa(state.month)} 給与連絡表の送付`;
      const body = [
        `${cfg.officeName || "社労士事務所"} ${cfg.contactName || ""} 様`,
        "",
        `いつもお世話になっております。${cfg.companyName || ""}でございます。`,
        `${monthLabelJa(state.month)}分の給与連絡表をお送りいたします。`,
        "",
        `・賃金締日:${closing}`,
        `・支給日:${pay}`,
        `・対象人数:${rows.length}名`,
        `・添付ファイル:${fileName}(書き出したファイルを添付してください)`,
        "",
        "ご確認のほど、よろしくお願いいたします。",
      ].join("\n");
      if (cfg.email) {
        window.open(`mailto:${encodeURIComponent(cfg.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_blank");
      }
      toast(`${monthLabelJa(state.month)}分を提出しました(CSVを書き出し、送信履歴に記録しました)`);
      renderAll();
    }

    function sharoushiTab() {
      const rows = payrollSummary(state.month, staffList());
      const cfg = sharoushi();
      const { closing, pay } = periodOf(state.month);
      const issues = submissionIssues(rows);
      const history = [...(store.get("sharoushiSubmissions") || [])]
        .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
      const lastForMonth = history.find((h) => h.month === state.month);

      /* --- 提出ヘッダー(締日・支給日・提出先) --- */
      const headCard = card({
        title: "提出情報",
        sub: `${monthLabelJa(state.month)}分`,
        actions: el("button", { class: "btn ghost sm", onclick: openSharoushiSettingModal },
          icon("settings", 14), "提出先を設定"),
        body: el("div", { class: "pr-sharoushi-head" },
          el("div", { class: "prs-item" }, el("span", { class: "prs-label" }, "提出先"),
            el("span", { class: "prs-value" }, cfg.officeName || "未設定",
              cfg.contactName ? el("span", { class: "small muted" }, ` ${cfg.contactName} 様`) : null)),
          el("div", { class: "prs-item" }, el("span", { class: "prs-label" }, "送信先メール"),
            el("span", { class: "prs-value" }, cfg.email || "未設定")),
          el("div", { class: "prs-item" }, el("span", { class: "prs-label" }, "事業所コード"),
            el("span", { class: "prs-value" }, `${cfg.companyCode || "—"} ${cfg.companyName || ""}`)),
          el("div", { class: "prs-item" }, el("span", { class: "prs-label" }, "賃金締日"),
            el("span", { class: "prs-value" }, fmtDate(closing, { withYear: true }))),
          el("div", { class: "prs-item" }, el("span", { class: "prs-label" }, "支給日"),
            el("span", { class: "prs-value" }, fmtDate(pay, { withYear: true }))),
          el("div", { class: "prs-item" }, el("span", { class: "prs-label" }, "対象人数"),
            el("span", { class: "prs-value" }, `${rows.length}名`))),
      });

      /* --- 提出前チェック --- */
      const checkCard = card({
        title: "提出前チェック",
        sub: issues.length ? `${issues.length}件の確認事項` : "確認事項はありません",
        body: issues.length
          ? el("div", { class: "prs-issues" },
              issues.map((i) => el("div", { class: "prs-issue" },
                icon("alert", 16),
                el("span", { class: "prs-issue-main" },
                  el("span", { class: "prs-issue-label" }, i.label),
                  el("span", { class: "prs-issue-hint" }, i.hint)),
                i.tab ? el("button", {
                  class: "btn ghost sm",
                  onclick: () => { state.tab = i.tab; renderTabs(); renderBody(); },
                }, "確認する", icon("chevR", 13)) : null)))
          : el("div", { class: "prs-ok" }, icon("check", 16),
              el("span", {}, "未承認の勤怠・承認待ちの経費はありません。このまま提出できます。")),
      });

      /* --- 給与連絡表のプレビュー --- */
      const columns = [
        {
          key: "dept", label: "所属",
          render: (r) => el("span", { class: "prs-dept" }, deptLabel(r.staff)),
        },
        { key: "empCode", label: "社員コード", align: "right", render: (r) => el("span", { class: "mono-num" }, r.staff.empCode || el("span", { class: "pr-bad" }, "未設定")) },
        { key: "name", label: "社員", render: (r) => el("b", {}, r.staff.name) },
        ...SHAROUSHI_COLUMNS.slice(3).map((c) => ({
          key: c.key, label: c.label, align: "right",
          render: (r) => {
            const v = c.get(r);
            const cls = c.kind === "manual" ? "prs-manual" : "";
            if (!v) return el("span", { class: `muted ${cls}` }, "0");
            return el("span", { class: cls }, String(v));
          },
        })),
      ];

      const previewCard = card({
        title: "給与連絡表(提出内容のプレビュー)",
        sub: `${monthLabelJa(state.month)}・${rows.length}名・行をクリックすると手入力項目を編集できます`,
        actions: el("div", { class: "flex", style: { gap: "8px" } },
          exportBtn("CSVで書き出し(Excel)", () => doSharoushiExport(rows)),
          el("button", {
            class: "btn primary sm",
            disabled: !rows.length,
            onclick: () => doSubmit(rows),
          }, icon("send", 14), "社労士に提出")),
        body: el("div", {},
          el("div", { class: "pr-copy" }, icon("info", 15),
            el("span", {},
              "社労士へ送付している「給与連絡表」と同じ列構成です。",
              el("b", {}, "白地の列は勤怠から自動算出"),
              "、",
              el("b", { class: "prs-manual" }, "色付きの列は事務での手入力"),
              "(行をクリックして入力)。「社労士に提出」を押すと、CSVを書き出して送信履歴に記録し、設定した宛先へのメール下書きを開きます。")),
          lastForMonth
            ? el("div", { class: "prs-already" }, icon("check", 15),
                `${monthLabelJa(state.month)}分は ${store.staffName(lastForMonth.submittedBy)} が ${fmtDate((lastForMonth.submittedAt || "").slice(0, 10), { withYear: true })} に提出済みです(再提出すると履歴が追加されます)`)
            : null,
          rows.length
            ? el("div", { class: "prs-table" }, table({ columns, rows, onRowClick: openAdjustModal }))
            : emptyState({ icon: "🗂", title: "対象のスタッフがいません" })),
      });

      /* --- 提出履歴 --- */
      const histCard = card({
        title: "提出履歴",
        sub: `全${history.length}件`,
        body: history.length
          ? table({
              columns: [
                { key: "month", label: "対象月", render: (h) => monthLabelJa(h.month) },
                { key: "at", label: "提出日時", render: (h) => el("span", { class: "mono-num" }, (h.submittedAt || "").slice(0, 16).replace("T", " ")) },
                { key: "by", label: "提出者", render: (h) => staffChip(h.submittedBy, { size: 24, withRole: false }) },
                { key: "count", label: "人数", align: "right", render: (h) => `${h.staffCount}名` },
                { key: "file", label: "ファイル", render: (h) => el("span", { class: "small muted" }, h.fileName) },
                { key: "to", label: "送信先", render: (h) => el("span", { class: "small muted" }, h.to || "—") },
                { key: "note", label: "備考", render: (h) => el("span", { class: "small muted" }, h.note || "—") },
              ],
              rows: history,
            })
          : emptyState({ icon: "📤", title: "まだ提出履歴はありません" }),
      });

      return el("div", { class: "stack", style: { gap: "16px" } },
        el("div", { class: "pr-sharoushi-grid" }, headCard, checkCard),
        previewCard,
        histCard);
    }

    /* ---------------- 描画 ---------------- */
    function renderBody() {
      clear(bodyWrap);
      bodyWrap.appendChild(
        state.tab === "kintai" ? kintaiTab() :
        state.tab === "expense" ? expenseTab() :
        state.tab === "transport" ? expenseTab({ transport: true }) :
        state.tab === "sharoushi" ? sharoushiTab() : orderTab());
    }

    function renderAll() {
      renderFilters();
      renderKpi();
      renderTabs();
      renderBody();
    }

    root.append(
      sectionHeader(
        "給与確認",
        "給与に直結する勤怠・経費・交通費・発注を、締めの前に1欄で最終確認し、そのまま社労士へ提出できます。各表はCSV(Excel)で書き出せます。",
        badge("事務職員向け・全店舗", "accent"),
      ),
      filterWrap,
      kpiWrap,
      tabsWrap,
      bodyWrap,
      el("p", { class: "pr-footnote" }, icon("info", 13),
        `このページは事務職員・本部人事・統括マネージャー以上のみ閲覧できます(現在の権限:${rankLabel(store.me())})。`),
    );

    renderAll();
  },
};
