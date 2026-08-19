/* ============================================================
   給与確認 — 事務職員向け
   給与に直結するデータを1欄で最終確認するページ。
   タブ: 勤怠サマリー / 経費申請 / 交通費申請 / 発注
   各タブの表はそのまま CSV(Excelでそのまま開ける)で書き出せる。
   閲覧: 事務職員・本部人事・統括マネージャー以上(payroll.view)
   ============================================================ */
import { store, todayStr, monthOf, SHIFT_TYPES } from "../store.js";
import {
  el, clear, icon, card, sectionHeader, statTile, badge, statusBadge,
  staffChip, table, tabs, segmented, toast, fmtDate, fmtYen, fmtNum,
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

/**
 * 勤怠サマリー(スタッフ×月)。給与計算の突合に使う8項目:
 * 出勤数 / 勤務時間 / 有給数 / 特別休暇数 / 欠勤数 / 残業 / 遅刻(回・分) / 早退(回・分)
 */
function kintaiSummary(month, staffList) {
  const today = todayStr();
  const attAll = store.get("attendance");
  const shiftAll = store.get("shifts");
  return staffList.map((s) => {
    const recs = attAll.filter((a) => a.staffId === s.id && monthOf(a.date) === month);
    const shs = shiftAll.filter((x) => x.staffId === s.id && monthOf(x.date) === month);
    const attByDate = new Map(recs.map((a) => [a.date, a]));

    let workDays = 0, worked = 0, ot = 0;
    let lateN = 0, lateMin = 0, earlyN = 0, earlyMin = 0;
    for (const a of recs) {
      if (a.clockIn) workDays++;
      worked += workedH(a);
      ot += otH(a);
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
      if (["off", "paid", "special", "birthday"].includes(x.type)) continue;
      const a = attByDate.get(x.date);
      if (!a || (!a.clockIn && !a.clockOut)) absentDays++;
    }

    return { staff: s, workDays, worked, ot, paidDays, specialDays, absentDays, lateN, lateMin, earlyN, earlyMin };
  });
}

/* ============================================================
   ページ本体
   ============================================================ */
export default {
  id: "payroll",
  title: "給与確認",
  icon: "cash",

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
      const sums = kintaiSummary(state.month, staffList());
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
      ], state.tab, (id) => { state.tab = id; renderTabs(); renderBody(); }));
    }

    const exportBtn = (label, onClick) =>
      el("button", { class: "btn soft sm", onclick: onClick }, icon("download", 14), label);

    /* ============================================================
       タブ1:勤怠サマリー(1欄で最終確認)
       ============================================================ */
    function kintaiTab() {
      const rows = kintaiSummary(state.month, staffList());

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

    /* ---------------- 描画 ---------------- */
    function renderBody() {
      clear(bodyWrap);
      bodyWrap.appendChild(
        state.tab === "kintai" ? kintaiTab() :
        state.tab === "expense" ? expenseTab() :
        state.tab === "transport" ? expenseTab({ transport: true }) : orderTab());
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
        "給与に直結する勤怠・経費・交通費・発注を、締めの前に1欄で最終確認するページです。各表はCSV(Excel)で書き出せます。",
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
