/* ============================================================
   人事管理 ページ — 本部人事担当者向け
   全店舗の勤怠・シフト乖離・残業を一元管理する。
   ご要望どおり「日報の内容」は対象外(auth.js の nippo.view で遮断)。
   ============================================================ */
import { store, todayStr, addDays, monthOf, mondayOf, SHIFT_TYPES } from "../store.js";
import {
  el, clear, icon, card, sectionHeader, statTile, badge, statusBadge,
  avatar, table, chip, toast, modal, fmtDate, staffChip, emptyState,
  segmented, tabs, kv,
} from "../ui.js";
import { barChart, hBars } from "../charts.js";
import { can, rankLabel } from "../auth.js";

/* ---------------- 小さなヘルパー ---------------- */
const pad2 = (n) => String(n).padStart(2, "0");
const toMin = (hm) => (hm ? Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)) : null);
/** 実働時間(休憩控除後) */
const workedH = (a) => (a?.clockIn && a?.clockOut)
  ? Math.max(0, (toMin(a.clockOut) - toMin(a.clockIn) - (a.breakMin || 0)) / 60)
  : 0;
/** 所定労働時間(1日) */
const STD_H = 8;
const otH = (a) => Math.max(0, workedH(a) - STD_H);
const h1 = (v) => `${(Math.round(v * 10) / 10).toFixed(1)}h`;
const shiftLabel = (t) => SHIFT_TYPES[t]?.label || "—";
const shiftRange = (t) => (SHIFT_TYPES[t]?.start ? `${SHIFT_TYPES[t].start}〜${SHIFT_TYPES[t].end}` : "");

function monthShift(month, n) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function monthLabelJa(month) {
  const [y, m] = month.split("-");
  return `${y}年${Number(m)}月`;
}
function monthDays(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
/** 対象月に重なる週(月曜日)の配列 */
function weeksOf(month) {
  const last = `${month}-${pad2(monthDays(month))}`;
  const out = [];
  let cur = mondayOf(`${month}-01`);
  while (cur <= last) { out.push(cur); cur = addDays(cur, 7); }
  return out;
}
const weekLabel = (mon) => `${Number(mon.slice(5, 7))}/${Number(mon.slice(8))}週`;

/* ---------------- 乖離(シフト通りでない)の判定 ---------------- */

const DEV_META = {
  late: { label: "遅刻", kind: "warn" },
  early: { label: "早退", kind: "serious" },
  absent: { label: "欠勤", kind: "critical" },
  missing: { label: "打刻漏れ", kind: "critical" },
  unplanned: { label: "予定外出勤", kind: "accent" },
};
const DEV_ORDER = ["late", "early", "absent", "missing", "unplanned"];

/**
 * シフト(予定)と勤怠(実績)を突合し、乖離を1日1行にまとめて返す。
 * 未来日は評価しない(まだ勤務していないため)。
 */
function findDeviations(month, staffIds) {
  const today = todayStr();
  const ids = staffIds instanceof Set ? staffIds : new Set(staffIds);
  const attMap = new Map();
  for (const a of store.get("attendance")) {
    if (monthOf(a.date) === month && ids.has(a.staffId)) attMap.set(`${a.staffId}|${a.date}`, a);
  }
  const rows = [];
  const seen = new Set();

  for (const sh of store.get("shifts")) {
    if (monthOf(sh.date) !== month || !ids.has(sh.staffId) || sh.date >= today) continue;
    const key = `${sh.staffId}|${sh.date}`;
    seen.add(key);
    const a = attMap.get(key) || null;
    const t = SHIFT_TYPES[sh.type] || {};
    const types = [];
    const details = [];
    let mins = 0;

    if (sh.type === "off") {
      if (a && (a.clockIn || a.clockOut)) {
        types.push("unplanned");
        details.push("休み予定の日に打刻があります");
      }
    } else if (!a || (!a.clockIn && !a.clockOut)) {
      types.push("absent");
      details.push("出勤記録がありません");
    } else {
      if (!a.clockIn || !a.clockOut || a.status === "missing") {
        types.push("missing");
        details.push(!a.clockIn ? "出勤打刻なし" : "退勤打刻なし");
      }
      // 遅刻は勤怠記録の判定(打刻時刻とシフト開始の比較結果)を正とする
      if (a.status === "late" && a.clockIn) {
        const m = t.start ? Math.max(0, toMin(a.clockIn) - toMin(t.start)) : 0;
        types.push("late"); mins += m;
        details.push(m ? `シフト開始から${m}分の遅刻` : "シフト開始後の打刻");
      }
      if (a.clockOut && t.end && toMin(a.clockOut) < toMin(t.end)) {
        const m = toMin(t.end) - toMin(a.clockOut);
        types.push("early"); mins += m; details.push(`${m}分の早退`);
      }
    }
    if (types.length) rows.push({ date: sh.date, staffId: sh.staffId, shift: sh, att: a, types, mins, details });
  }

  // シフト未登録なのに打刻がある日も「予定外出勤」として拾う
  for (const [key, a] of attMap) {
    if (seen.has(key) || a.date >= today) continue;
    if (!a.clockIn && !a.clockOut) continue;
    rows.push({
      date: a.date, staffId: a.staffId, shift: null, att: a,
      types: ["unplanned"], mins: 0, details: ["シフト未登録の日に打刻があります"],
    });
  }

  rows.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : x.staffId.localeCompare(y.staffId)));
  return rows;
}

/** 対象月のスタッフ別残業サマリー(多い順) */
function overtimeByStaff(month, staffList) {
  const att = store.get("attendance");
  return staffList.map((s) => {
    const recs = att.filter((a) => a.staffId === s.id && monthOf(a.date) === month);
    const ot = recs.reduce((sum, a) => sum + otH(a), 0);
    return {
      staff: s,
      ot,
      days: recs.filter((a) => a.clockIn).length,
      totalH: recs.reduce((sum, a) => sum + workedH(a), 0),
      otDays: recs.filter((a) => otH(a) > 0.01).length,
      recs,
    };
  }).sort((a, b) => b.ot - a.ot);
}

/* ============================================================
   ページ本体
   ============================================================ */
export default {
  id: "hr",
  title: "人事管理",
  icon: "clipboard",

  render(root) {
    /* ---------------- 権限ゲート ---------------- */
    if (!can("hr.view")) {
      root.appendChild(el("div", { class: "perm-gate" },
        el("div", { class: "pg-ic" }, icon("alert", 26)),
        el("div", { class: "pg-title" }, "人事管理を表示する権限がありません"),
        el("div", { class: "pg-desc" },
          "このページは全店舗の勤怠・シフト・残業を扱うため、本部人事(森 あかり)と統括マネージャー(小林 誠)のみ閲覧できます。ご自身の勤怠は「勤怠管理」から確認いただけます。"),
        el("div", { class: "pg-actions" },
          el("button", { class: "btn primary", onclick: () => { location.hash = "#/kintai"; } },
            icon("clock", 15), "勤怠管理へ"),
          el("button", { class: "btn ghost", onclick: () => document.querySelector(".topbar-user")?.click() },
            icon("user", 15), "ログインユーザーを切り替える"))));
      return;
    }

    const today = todayStr();
    const state = {
      month: monthOf(today),
      storeId: "all",
      q: "",
      tab: "list",
      attStatus: "all",
      devType: "all",
      otTh: 20,
      limit: 60,
    };

    /* ---------------- 絞り込み結果 ---------------- */
    const filteredStaff = () => {
      const q = state.q.trim();
      return store.get("staff").filter((s) =>
        (state.storeId === "all" || s.storeId === state.storeId) &&
        (!q || s.name.includes(q) || (s.kana || "").includes(q) || s.role.includes(q)));
    };
    const monthAttendance = (ids) =>
      store.get("attendance")
        .filter((a) => monthOf(a.date) === state.month && ids.has(a.staffId))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.staffId.localeCompare(b.staffId)));

    /* ---------------- 要素 ---------------- */
    const filterWrap = el("div", { class: "hr-filters" });
    const kpiWrap = el("div", {});
    const tabsWrap = el("div", {});
    const bodyWrap = el("div", {});

    const searchInput = el("input", {
      class: "hr-search-input", type: "search", placeholder: "スタッフ名・役職で絞り込み",
      "aria-label": "スタッフ検索",
    });
    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = searchInput.value;
        state.limit = 60;
        renderKpi(); renderTabs(); renderBody();
      }, 160);
    });

    /* ---------------- フィルタ行(1行にまとめる) ---------------- */
    function renderFilters() {
      clear(filterWrap);
      const isThisMonth = state.month === monthOf(today);
      filterWrap.append(
        el("div", { class: "hr-monthnav" },
          el("button", {
            class: "icon-btn nav-chev", "aria-label": "前月",
            onclick: () => { state.month = monthShift(state.month, -1); state.limit = 60; renderAll(); },
          }, icon("chevL", 18)),
          el("span", { class: "hr-month" }, monthLabelJa(state.month)),
          el("button", {
            class: "icon-btn nav-chev", "aria-label": "翌月",
            onclick: () => { state.month = monthShift(state.month, 1); state.limit = 60; renderAll(); },
          }, icon("chevR", 18)),
          !isThisMonth ? el("button", {
            class: "btn ghost sm",
            onclick: () => { state.month = monthOf(today); state.limit = 60; renderAll(); },
          }, "今月へ") : badge("今月", "accent")),

        segmented(
          [{ id: "all", label: "全店" }, ...store.get("stores").map((s) => ({ id: s.id, label: s.short }))],
          state.storeId,
          (id) => { state.storeId = id; state.limit = 60; renderAll(); }),

        el("label", { class: "hr-search" }, icon("search", 16), searchInput),
      );
    }

    /* ---------------- KPI ---------------- */
    function renderKpi() {
      clear(kpiWrap);
      const staffList = filteredStaff();
      const ids = new Set(staffList.map((s) => s.id));
      const att = monthAttendance(ids);
      const lateN = att.filter((a) => a.status === "late").length;
      const missN = att.filter((a) => a.status === "missing").length;
      const devN = findDeviations(state.month, ids).length;
      const otAlert = overtimeByStaff(state.month, staffList).filter((r) => r.ot >= state.otTh).length;

      kpiWrap.appendChild(el("div", { class: "kpi-row" },
        statTile({
          label: "遅刻件数", value: `${lateN}件`, icon: "clock",
          sub: `${monthLabelJa(state.month)}・${att.length}件の勤怠から`, tone: lateN ? "warn" : "good",
        }),
        statTile({
          label: "打刻漏れ件数", value: `${missN}件`, icon: "alert",
          sub: missN ? "承認前に修正が必要です" : "打刻漏れはありません", tone: missN ? "violet" : "good",
        }),
        statTile({
          label: "シフト乖離件数", value: `${devN}件`, icon: "target",
          sub: "遅刻・早退・欠勤・打刻漏れ等", tone: "accent",
        }),
        statTile({
          label: "残業アラート人数", value: `${otAlert}名`, icon: "trend",
          sub: `月${state.otTh}時間超のスタッフ`, tone: otAlert ? "warn" : "good",
        }),
      ));
    }

    /* ---------------- タブ ---------------- */
    function renderTabs() {
      clear(tabsWrap);
      const staffList = filteredStaff();
      const ids = new Set(staffList.map((s) => s.id));
      tabsWrap.appendChild(tabs([
        { id: "list", label: "勤怠一覧", badge: monthAttendance(ids).length },
        { id: "dev", label: "シフト乖離", badge: findDeviations(state.month, ids).length },
        { id: "ot", label: "残業アラート", badge: overtimeByStaff(state.month, staffList).filter((r) => r.ot >= state.otTh).length },
        { id: "roster", label: "スタッフ台帳", badge: staffList.length },
      ], state.tab, (id) => { state.tab = id; state.limit = 60; renderTabs(); renderBody(); }));
    }

    /* ============================================================
       タブ1:勤怠一覧
       ============================================================ */
    function listTab() {
      const staffList = filteredStaff();
      const ids = new Set(staffList.map((s) => s.id));
      const all = monthAttendance(ids);
      const counts = {
        all: all.length,
        late: all.filter((a) => a.status === "late").length,
        missing: all.filter((a) => a.status === "missing").length,
        unapproved: all.filter((a) => !a.approved).length,
      };
      const rows = all.filter((a) =>
        state.attStatus === "all" ? true :
        state.attStatus === "unapproved" ? !a.approved : a.status === state.attStatus);
      const shown = rows.slice(0, state.limit);

      const chips = el("div", { class: "hr-chips" },
        [
          ["all", `すべて ${counts.all}`],
          ["late", `遅刻 ${counts.late}`],
          ["missing", `打刻漏れ ${counts.missing}`],
          ["unapproved", `未承認 ${counts.unapproved}`],
        ].map(([id, label]) => chip(label, {
          on: state.attStatus === id,
          onClick: () => { state.attStatus = id; state.limit = 60; renderBody(); },
        })));

      const exportBtn = el("button", {
        class: "btn ghost sm",
        onclick: () => toast("勤怠データを書き出しました(デモ)"),
      }, icon("download", 14), "書き出し");

      const bulkBtn = el("button", {
        class: "btn soft sm",
        disabled: counts.unapproved === 0,
        onclick: () => {
          const targets = all.filter((a) => !a.approved && a.clockIn && a.clockOut && a.status !== "missing");
          if (!targets.length) { toast("一括承認できる正常打刻がありません", "info"); return; }
          targets.forEach((a) => store.update("attendance", a.id, { approved: true }));
          toast(`正常打刻 ${targets.length}件をまとめて承認しました`);
          renderAll();
        },
      }, icon("check", 14), "正常分を一括承認");

      const columns = [
        { key: "date", label: "日付", render: (a) => el("span", { class: "hr-cell-date" }, fmtDate(a.date)) },
        { key: "staff", label: "スタッフ", render: (a) => staffChip(a.staffId, { size: 26, withRole: false }) },
        { key: "store", label: "店舗", render: (a) => el("span", { class: "small muted" }, store.storeName(store.byId("staff", a.staffId)?.storeId)) },
        {
          key: "shift", label: "シフト",
          render: (a) => el("span", {},
            el("b", { style: { fontSize: "var(--fs-sm)" } }, shiftLabel(a.shiftType)),
            el("span", { class: "small muted", style: { marginLeft: "5px" } }, shiftRange(a.shiftType))),
        },
        { key: "in", label: "出勤", align: "center", render: (a) => el("span", { class: `hr-time ${a.clockIn ? "" : "none"}` }, a.clockIn || "--:--") },
        { key: "out", label: "退勤", align: "center", render: (a) => el("span", { class: `hr-time ${a.clockOut ? "" : "none"}` }, a.clockOut || "--:--") },
        {
          key: "worked", label: "実働", align: "right",
          render: (a) => {
            const w = workedH(a);
            return el("span", { class: "hr-worked" }, w ? h1(w) : "—",
              otH(a) > 0.01 ? el("span", { class: "hr-otmini" }, `残${h1(otH(a))}`) : null);
          },
        },
        { key: "status", label: "状態", align: "center", render: (a) => statusBadge(a.status) },
        {
          key: "approved", label: "承認", align: "center",
          render: (a) => a.approved
            ? badge("承認済", "good")
            : el("button", {
                class: "btn primary sm",
                onclick: (e) => {
                  e.stopPropagation();
                  store.update("attendance", a.id, { approved: true });
                  toast(`${store.staffName(a.staffId)}さん(${fmtDate(a.date)})の勤怠を承認しました`);
                  renderAll();
                },
              }, icon("check", 13), "承認"),
        },
      ];

      const body = el("div", {},
        el("div", { class: "hr-copy" }, icon("info", 15),
          el("span", {}, "全店舗の打刻を1つの表で確認できます。未承認の行はその場で承認でき、承認済みの記録は給与計算にそのまま連携できます。")),
        chips,
        shown.length
          ? table({ columns, rows: shown, onRowClick: (a) => openStaffModal(store.byId("staff", a.staffId)) })
          : emptyState({ icon: "🗂", title: "該当する勤怠データがありません", hint: "月・店舗・状態の絞り込みを変えてみてください" }),
        rows.length > shown.length
          ? el("div", { class: "hr-more" },
              el("button", {
                class: "btn ghost sm",
                onclick: () => { state.limit += 60; renderBody(); },
              }, icon("chevD", 14), `さらに表示(残り ${rows.length - shown.length}件)`))
          : null,
      );

      return card({
        title: "勤怠一覧",
        sub: `${monthLabelJa(state.month)}・${rows.length}件`,
        actions: el("div", { class: "flex", style: { gap: "8px" } }, bulkBtn, exportBtn),
        body,
      });
    }

    /* ============================================================
       タブ2:シフト乖離
       ============================================================ */
    function devTab() {
      const staffList = filteredStaff();
      const ids = new Set(staffList.map((s) => s.id));
      const devs = findDeviations(state.month, ids);
      const counts = { all: devs.length };
      for (const t of DEV_ORDER) counts[t] = devs.filter((d) => d.types.includes(t)).length;
      const rows = state.devType === "all" ? devs : devs.filter((d) => d.types.includes(state.devType));
      const shown = rows.slice(0, state.limit);

      const chips = el("div", { class: "hr-chips" },
        [["all", `すべて ${counts.all}`], ...DEV_ORDER.map((t) => [t, `${DEV_META[t].label} ${counts[t]}`])]
          .map(([id, label]) => chip(label, {
            on: state.devType === id,
            onClick: () => { state.devType = id; state.limit = 60; renderBody(); },
          })));

      const list = el("div", { class: "hr-dev-list" });
      for (const d of shown) {
        const t = d.shift ? SHIFT_TYPES[d.shift.type] : null;
        const plan = d.shift
          ? (d.shift.type === "off" ? "休み" : `${shiftLabel(d.shift.type)} ${t?.start || "--:--"}〜${t?.end || "--:--"}`)
          : "シフト未登録";
        const actual = d.att && (d.att.clockIn || d.att.clockOut)
          ? `${d.att.clockIn || "--:--"}〜${d.att.clockOut || "--:--"}`
          : "打刻なし";
        list.appendChild(el("div", { class: "hr-dev-item" },
          el("span", { class: "dv-date" }, fmtDate(d.date)),
          el("span", { class: "dv-staff" }, staffChip(d.staffId, { size: 28 })),
          el("span", { class: "dv-times" },
            el("span", { class: "dv-plan" }, el("span", { class: "dv-lab" }, "予定"), plan),
            icon("chevR", 13),
            el("span", { class: "dv-act" }, el("span", { class: "dv-lab" }, "実績"), actual)),
          el("span", { class: "dv-tail" },
            el("span", { class: "dv-badges" },
              d.types.map((t2) => badge(DEV_META[t2].label, DEV_META[t2].kind))),
            el("span", { class: `dv-min ${d.mins ? "" : "zero"}` }, d.mins ? `${d.mins}分` : "—")),
          el("span", { class: "dv-detail" }, d.details.join("・"))));
      }

      // 乖離の多い順ランキング
      const byStaff = new Map();
      for (const d of devs) byStaff.set(d.staffId, (byStaff.get(d.staffId) || 0) + 1);
      const rank = [...byStaff.entries()]
        .map(([id, n]) => ({ staff: store.byId("staff", id), n }))
        .filter((r) => r.staff)
        .sort((a, b) => b.n - a.n)
        .slice(0, 8);

      const rankCard = card({
        title: "乖離の多いスタッフ",
        sub: `${monthLabelJa(state.month)}・上位${rank.length}名`,
        body: rank.length
          ? hBars({
              items: rank.map((r) => ({
                label: r.staff.name,
                sub: store.storeName(r.staff.storeId),
                value: r.n,
                color: r.n >= 3 ? "var(--critical)" : r.n >= 2 ? "var(--warn)" : "var(--accent)",
              })),
              fmt: (v) => `${v}件`,
            })
          : emptyState({ icon: "🎉", title: "乖離はありません", hint: "全員がシフト通りに勤務できています" }),
      });

      const listCard = card({
        title: "乖離の一覧",
        sub: `${rows.length}件`,
        body: el("div", {},
          chips,
          shown.length ? list : emptyState({ icon: "✅", title: "該当する乖離はありません", hint: "種別の絞り込みを変えてみてください" }),
          rows.length > shown.length
            ? el("div", { class: "hr-more" },
                el("button", { class: "btn ghost sm", onclick: () => { state.limit += 60; renderBody(); } },
                  icon("chevD", 14), `さらに表示(残り ${rows.length - shown.length}件)`))
            : null),
      });

      return el("div", { class: "stack", style: { gap: "16px" } },
        el("div", { class: "hr-hero" },
          el("span", { class: "hr-hero-ic" }, icon("target", 20)),
          el("span", {},
            el("b", {}, "シフト通りに勤務できていない人がひと目でわかります"),
            el("span", { class: "hr-hero-sub" },
              "シフト(予定)と打刻(実績)を自動で突合し、遅刻・早退・欠勤・打刻漏れ・予定外出勤を検出しています。"))),
        el("div", { class: "hr-dev-grid" }, listCard, rankCard));
    }

    /* ============================================================
       タブ3:残業アラート
       ============================================================ */
    function otTab() {
      const staffList = filteredStaff();
      const ids = new Set(staffList.map((s) => s.id));
      const rowsAll = overtimeByStaff(state.month, staffList);
      const prev = new Map(overtimeByStaff(monthShift(state.month, -1), staffList).map((r) => [r.staff.id, r]));
      const rows = rowsAll.filter((r) => r.ot > 0 || r.days > 0);
      const alerts = rowsAll.filter((r) => r.ot >= state.otTh);

      const thChips = el("div", { class: "hr-chips" },
        [20, 30, 45, 60].map((v) => chip(
          v === 20 ? "20h 社内注意" : v === 30 ? "30h 注意" : v === 45 ? "45h 上限目安" : "60h 特別条項",
          { on: state.otTh === v, onClick: () => { state.otTh = v; renderAll(); } })));

      // アラートカード
      const cards = el("div", { class: "hr-ot-cards" });
      for (const r of alerts) {
        const p = prev.get(r.staff.id);
        const hasPrev = p && p.days > 0;
        const diff = hasPrev ? r.ot - p.ot : null;
        const level = r.ot >= 45 ? "critical" : r.ot >= 30 ? "warn" : "watch";
        cards.appendChild(el("div", { class: `hr-ot-card ${level}` },
          el("div", { class: "otc-top" },
            avatar(r.staff, 38),
            el("div", { class: "otc-meta" },
              el("span", { class: "otc-name" }, r.staff.name),
              el("span", { class: "otc-sub" }, `${store.storeName(r.staff.storeId)}・${r.staff.role}`)),
            badge(level === "critical" ? "上限超過" : level === "warn" ? "注意" : "要watch",
              level === "critical" ? "critical" : level === "warn" ? "warn" : "accent")),
          el("div", { class: "otc-value" }, h1(r.ot), el("span", { class: "otc-unit" }, "/ 月")),
          el("div", { class: "otc-facts" },
            el("span", {}, `出勤 ${r.days}日`),
            el("span", {}, `実働 ${h1(r.totalH)}`),
            el("span", {}, `残業発生 ${r.otDays}日`)),
          el("div", { class: "otc-foot" },
            el("span", { class: `otc-delta ${diff == null ? "none" : diff > 0 ? "up" : "down"}` },
              diff == null ? "前月データなし"
                : `前月比 ${diff > 0 ? "+" : ""}${(Math.round(diff * 10) / 10).toFixed(1)}h`),
            el("button", {
              class: "btn ghost sm",
              onclick: () => toast(`${r.staff.name}さんのシフト調整を${store.storeName(r.staff.storeId)}の責任者に相談しました(デモ)`),
            }, icon("chat", 13), "シフト調整を相談"))));
      }

      const alertCard = card({
        title: `残業アラート(月${state.otTh}時間超)`,
        sub: `${alerts.length}名`,
        body: el("div", {},
          el("div", { class: "hr-copy warn" }, icon("alert", 15),
            el("span", {}, "残業時間は「実働時間(休憩60分控除後)− 所定労働8時間/日」の合計です。45時間は36協定の原則上限、30時間は注意ラインの目安。閾値は運用に合わせて切り替えられます。")),
          thChips,
          alerts.length ? cards
            : emptyState({ icon: "🌿", title: `月${state.otTh}時間を超えるスタッフはいません`, hint: "閾値を下げると注意対象を確認できます" })),
      });

      const barsCard = card({
        title: "スタッフ別 残業時間",
        sub: `${monthLabelJa(state.month)}・多い順`,
        body: rows.length
          ? el("div", {},
              hBars({
                items: rows.map((r) => ({
                  label: r.staff.name,
                  sub: store.storeName(r.staff.storeId),
                  value: Math.round(r.ot * 10) / 10,
                  color: r.ot >= 45 ? "var(--critical)" : r.ot >= 30 ? "var(--warn)" : "var(--accent)",
                })),
                fmt: (v) => `${v.toFixed(1)}h`,
              }),
              el("div", { class: "hr-legend" },
                el("span", {}, el("i", { class: "lg-dot critical" }), "45h超(上限超過)"),
                el("span", {}, el("i", { class: "lg-dot warn" }), "30h超(注意)"),
                el("span", {}, el("i", { class: "lg-dot ok" }), "30h以下")))
          : emptyState({ icon: "🗂", title: "対象月の勤怠データがありません" }),
      });

      // 週次の残業推移
      const weeks = weeksOf(state.month);
      const bucket = new Map(weeks.map((w) => [w, 0]));
      for (const a of store.get("attendance")) {
        if (monthOf(a.date) !== state.month || !ids.has(a.staffId)) continue;
        const w = mondayOf(a.date);
        if (bucket.has(w)) bucket.set(w, bucket.get(w) + otH(a));
      }
      const values = weeks.map((w) => Math.round(bucket.get(w) * 10) / 10);
      const trendCard = card({
        title: "週次の残業推移",
        sub: `${monthLabelJa(state.month)}・${state.storeId === "all" ? "全店合計" : store.storeName(state.storeId)}`,
        body: values.some((v) => v > 0)
          ? barChart({
              series: [{ name: "残業時間", values, color: "var(--brand)" }],
              labels: weeks.map(weekLabel), height: 220,
              yFmt: (v) => `${Math.round(v)}h`,
            })
          : emptyState({ icon: "📉", title: "残業は発生していません" }),
      });

      return el("div", { class: "stack", style: { gap: "16px" } },
        alertCard,
        el("div", { class: "grid cols-2" }, barsCard, trendCard));
    }

    /* ============================================================
       タブ4:スタッフ台帳
       ============================================================ */
    function rosterTab() {
      const staffList = filteredStaff();
      const otMap = new Map(overtimeByStaff(state.month, staffList).map((r) => [r.staff.id, r]));

      const columns = [
        { key: "name", label: "スタッフ", render: (s) => staffChip(s.id, { size: 30, withRole: false }) },
        { key: "store", label: "店舗", render: (s) => store.storeName(s.storeId) },
        { key: "role", label: "役職", render: (s) => s.role },
        { key: "rank", label: "権限", render: (s) => badge(rankLabel(s), s.rank === "hr" ? "accent" : s.rank === "exec" ? "brand" : "") },
        { key: "joined", label: "入社日", render: (s) => el("span", { class: "mono-num" }, s.joined.replace(/-/g, "/")) },
        {
          key: "lic", label: "保有資格",
          render: (s) => s.licenses?.length
            ? el("span", { class: "hr-lics" }, s.licenses.map((l) => badge(l, "accent")))
            : el("span", { class: "small muted" }, "—"),
        },
        { key: "days", label: "当月出勤", align: "right", render: (s) => `${otMap.get(s.id)?.days ?? 0}日` },
        {
          key: "ot", label: "当月残業", align: "right",
          render: (s) => {
            const ot = otMap.get(s.id)?.ot || 0;
            return el("span", { class: `hr-otval ${ot >= 45 ? "critical" : ot >= 30 ? "warn" : ""}` }, h1(ot));
          },
        },
      ];

      return card({
        title: "スタッフ台帳",
        sub: `${staffList.length}名・行をクリックで詳細`,
        body: el("div", {},
          el("div", { class: "hr-copy" }, icon("users", 15),
            el("span", {}, "在籍者の基本情報と当月の勤怠サマリーです。行をクリックすると、当月の勤怠と直近の乖離履歴を確認できます。")),
          staffList.length
            ? table({ columns, rows: staffList, onRowClick: (s) => openStaffModal(s) })
            : emptyState({ icon: "🔍", title: "該当するスタッフがいません", hint: "検索条件を変えてみてください" })),
      });
    }

    /* ---------------- スタッフ詳細モーダル ---------------- */
    function openStaffModal(s) {
      if (!s) return;
      const recs = store.get("attendance").filter((a) => a.staffId === s.id && monthOf(a.date) === state.month);
      const ot = recs.reduce((sum, a) => sum + otH(a), 0);
      const totalH = recs.reduce((sum, a) => sum + workedH(a), 0);
      const days = recs.filter((a) => a.clockIn).length;
      const lateN = recs.filter((a) => a.status === "late").length;
      const missN = recs.filter((a) => a.status === "missing").length;
      const unapproved = recs.filter((a) => !a.approved).length;
      const devs = findDeviations(state.month, new Set([s.id])).slice(0, 8);

      const body = el("div", { class: "page-hr" },
        el("div", { class: "hr-modal-head" },
          avatar(s, 52),
          el("div", {},
            el("div", { class: "hrm-name" }, s.name, el("span", { class: "hrm-kana" }, s.kana)),
            el("div", { class: "hrm-sub" }, `${store.storeName(s.storeId)}・${s.role}`),
            el("div", { class: "flex wrap", style: { gap: "6px", marginTop: "6px" } },
              badge(rankLabel(s), "brand"),
              ...(s.licenses?.length ? s.licenses.map((l) => badge(l, "accent")) : [badge("資格登録なし")])))),

        el("h4", { class: "hr-modal-sec" }, "基本情報"),
        el("div", { class: "hr-kv" },
          kv("店舗", store.storeName(s.storeId)),
          kv("役職", s.role),
          kv("権限ランク", rankLabel(s)),
          kv("入社日", s.joined.replace(/-/g, "/")),
          kv("メンター", s.mentorId ? store.staffName(s.mentorId) : "—"),
          kv("保有資格", s.licenses?.length ? s.licenses.join("・") : "—")),

        el("h4", { class: "hr-modal-sec" }, `当月の勤怠サマリー(${monthLabelJa(state.month)})`),
        el("div", { class: "hr-mini-stats" },
          miniStat("出勤日数", `${days}日`),
          miniStat("実働合計", h1(totalH)),
          miniStat("残業時間", h1(ot), ot >= 45 ? "critical" : ot >= 30 ? "warn" : ""),
          miniStat("遅刻", `${lateN}回`, lateN ? "warn" : ""),
          miniStat("打刻漏れ", `${missN}回`, missN ? "critical" : ""),
          miniStat("未承認", `${unapproved}件`, unapproved ? "warn" : "")),

        el("h4", { class: "hr-modal-sec" }, "直近の乖離履歴"),
        devs.length
          ? el("div", { class: "hr-modal-devs" },
              devs.map((d) => el("div", { class: "hmd-item" },
                el("span", { class: "hmd-date" }, fmtDate(d.date)),
                el("span", { class: "hmd-badges" }, d.types.map((t) => badge(DEV_META[t].label, DEV_META[t].kind))),
                el("span", { class: "hmd-detail" }, d.details.join("・")))))
          : el("p", { class: "hr-modal-empty" }, "この月はシフト通りに勤務できています。"),

        el("p", { class: "hr-modal-note" }, icon("info", 13), "日報の内容は人事管理の対象外です。"),
      );

      const closeBtn = el("button", { class: "btn ghost" }, "閉じる");
      const m = modal({ title: `${s.name} さんの人事情報`, body, actions: [closeBtn] });
      closeBtn.addEventListener("click", m.close);
    }

    function miniStat(label, value, kind = "") {
      return el("div", { class: `hr-mini ${kind}` },
        el("span", { class: "hm-label" }, label),
        el("span", { class: "hm-value" }, value));
    }

    /* ---------------- 本体描画 ---------------- */
    function renderBody() {
      clear(bodyWrap);
      const view =
        state.tab === "list" ? listTab() :
        state.tab === "dev" ? devTab() :
        state.tab === "ot" ? otTab() : rosterTab();
      bodyWrap.appendChild(view);
    }

    function renderAll() {
      renderFilters();
      renderKpi();
      renderTabs();
      renderBody();
    }

    /* ---------------- レイアウト ---------------- */
    root.append(
      sectionHeader(
        "人事管理",
        "全店舗のシフト・勤怠・残業を本部で一元管理します。シフト通りに勤務できていない人と、残業が多い人を自動で洗い出します。",
        badge("本部人事向け・全店舗", "accent"),
      ),
      filterWrap,
      kpiWrap,
      tabsWrap,
      bodyWrap,
      el("p", { class: "hr-footnote" }, icon("info", 13),
        "日報の内容は人事管理の対象外です(人事権限では日報を閲覧できません)。勤怠・シフト・残業のみを扱います。"),
    );

    renderAll();
  },
};
