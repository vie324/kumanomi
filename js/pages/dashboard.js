/* ============================================================
   ダッシュボード — 権限ごとに見せるものを変える

   ◎ 社長
       全体と各店舗の「現在の売上 / 売上の予測 / 予算に対しての%」を
       数字とグラフで。上部のKPIカードは置かない。
   ◎ 統括マネージャー / マネージャー / 統括院長 / 院長・店長 / 本部人事
       自分の管轄の店舗だけ。上部に「新規数 / 契約率 / 今日の予約人数」の
       3枚、そのあと管轄店舗の売上(現在・予測・予算比)。
   ◎ スタッフ / メンター / 事務
       所属店舗と自分個人の成績。上部の3枚は自分の数字(店舗の数字を添える)。

   売上の数字は js/sales.js で集計する(売上報告 → 無い日は日報で補完)。
   予算は budgets(店舗 × 月)。役員以上と本部人事がここから設定できる。
   ============================================================ */

import {
  el, clear, fmtYen, fmtNum, fmtPct, relTime, icon, avatar, badge, kv,
  statTile, meter, card, sectionHeader, segmented, modal, toast, emptyState,
} from "../ui.js";
import { sparkline, lineChart, hBars, seriesColor } from "../charts.js";
import { store, todayStr, monthOf } from "../store.js";
import { rankOf, rankLevel, managedStores, canSeeStaff } from "../auth.js";
import {
  monthSummary, personalSummary, contractRateOf, storeDay, monthRevenue, recentMonths, budgetOf,
  datesOfMonth, isBusinessDay,
} from "../sales.js";

const cssVar = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
const monthLabel = (m) => `${Number(m.slice(5))}月`;
const monthFull = (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;
const go = (hash) => { location.hash = hash; };
const yenShort = (v) => (Math.abs(v) >= 10000 ? `${fmtNum(Math.round(v / 10000))}万` : fmtNum(Math.round(v)));

/** 権限からダッシュボードの型を決める */
function dashRole(me) {
  const r = rankOf(me);
  if (r === "ceo") return "ceo";
  if (r === "hr" || rankLevel(me) >= 3) return "manager";
  return "staff";
}

const ROLE_TITLE = {
  ceo: { title: "経営ダッシュボード", desc: "全体と各店舗の売上・着地見込み・予算比をひと目で。数字は売上報告(無い日は日報)から自動で集計します。" },
  manager: { title: "管轄店舗のダッシュボード", desc: "自分の管轄の店舗の新規・契約率・予約と、売上の現在地・着地見込み・予算比を確認できます。" },
  staff: { title: "マイダッシュボード", desc: "所属店舗の状況と、自分の今月の成績です。数字は日報と売上報告から自動で集まります。" },
};

export default {
  id: "dashboard",
  title: "ダッシュボード",
  icon: "home",

  // このページが必要とするデータ。ルーターがそろえてから render() を呼ぶ
  needs: ["attendance", "budgets", "dailyReports", "inventory", "kpiMonthly", "meetings", "patients", "posts", "reservations", "shifts", "staff", "stores", "tasks"],
  render(root) {
    const draw = () => { clear(root); buildPage(root, draw); };
    draw();
  },
};

/* ============================================================
   ページ本体
   ============================================================ */
function buildPage(root, redraw) {
  const me = store.me();
  const today = todayStr();
  const role = dashRole(me);
  const allStores = (store.get("stores") || []).filter((s) => s.isActive !== false);

  // 表示する月(月初は先月の着地も見たいので切り替えられる)
  const months = recentMonths(6);
  const month = months.includes(store.state.settings.dashMonth) ? store.state.settings.dashMonth : monthOf(today);
  const isCurrent = month === monthOf(today);

  // 管轄の店舗
  let scopeIds;
  if (role === "ceo") scopeIds = allStores.map((s) => s.id);
  else if (role === "manager") scopeIds = managedStores(me).filter((id) => allStores.some((s) => s.id === id));
  else scopeIds = [];
  if (!scopeIds.length) scopeIds = [me.storeId].filter((id) => allStores.some((s) => s.id === id));
  const scopeStores = allStores.filter((s) => scopeIds.includes(s.id));

  const canEditBudget = rankLevel(me) >= 6 || rankOf(me) === "hr";

  /* ---- ヘッダー ---- */
  const meta = ROLE_TITLE[role];
  const monthSeg = segmented(
    months.map((m) => ({ id: m, label: m === monthOf(today) ? "今月" : monthLabel(m) })),
    month,
    (m) => { store.setSetting("dashMonth", m); redraw(); });
  const actions = [monthSeg];
  if (canEditBudget) {
    actions.push(el("button", { class: "btn ghost sm", onclick: () => openBudgetModal(scopeStores, month, redraw) },
      icon("target", 14), "予算を設定"));
  }
  root.appendChild(sectionHeader(meta.title, meta.desc, actions));

  if (!allStores.length) {
    root.appendChild(card({ body: emptyState({ icon: "🏥", title: "店舗がまだ登録されていません", hint: "「メンバー・組織図の一括登録」から店舗と社員を取り込んでください" }) }));
    return;
  }

  if (role === "ceo") drawCeo(root, { scopeStores, allStores, month, isCurrent, today, canEditBudget, redraw });
  else if (role === "manager") drawManager(root, { me, scopeStores, month, isCurrent, today, canEditBudget, redraw });
  else drawStaff(root, { me, scopeStores, month, isCurrent, today, redraw });

  /* ---- 共通:注意が必要 / 連絡事項 ---- */
  root.appendChild(el("div", { class: "grid cols-2 dash-bottom" },
    alertsCard({ me, role, scopeIds, today }),
    newsCard()));
}

/* ============================================================
   社長:全体 + 各店舗
   ============================================================ */
function drawCeo(root, { scopeStores, month, isCurrent, today, canEditBudget, redraw }) {
  const ids = scopeStores.map((s) => s.id);
  const all = monthSummary(ids, month);

  root.appendChild(sectionTitle("🏢", "全体", `${monthFull(month)}・${scopeStores.length}店舗合計`));
  root.appendChild(salesBlock({
    title: "全体の売上", sub: isCurrent ? "今月の現在地と着地見込み" : `${monthFull(month)}の実績`,
    s: all, month, isCurrent, canEditBudget, redraw, stores: scopeStores,
  }));

  root.appendChild(sectionTitle("🏥", "各店舗", "店舗ごとの現在の売上・予測・予算比"));
  root.appendChild(storeGrid(scopeStores, month, isCurrent));

  root.appendChild(el("div", { class: "grid cols-2 dash-charts" },
    budgetBarsCard(scopeStores, month),
    trendCard(ids, month, "全店")));
}

/* ============================================================
   統括マネージャー / マネージャー / 統括院長 / 院長:管轄の店舗
   ============================================================ */
function drawManager(root, { me, scopeStores, month, isCurrent, today, canEditBudget, redraw }) {
  const ids = scopeStores.map((s) => s.id);
  const s = monthSummary(ids, month);
  const cr = contractRateOf(ids, month);
  const newToday = isCurrent ? ids.reduce((a, id) => a + (storeDay(id, today)?.newPatients || 0), 0) : 0;
  const resToday = reservationsToday(ids, today);

  root.appendChild(el("div", { class: "kpi-row dash-kpi3" },
    statTile({
      label: `新規数(${monthLabel(month)})`, value: `${fmtNum(s.newPatients)}名`, icon: "users", tone: "brand",
      sub: isCurrent ? `今日 ${newToday}名・売上報告と日報から集計` : "売上報告と日報から集計",
    }),
    statTile({
      label: "契約率", value: cr.rate == null ? "—" : fmtPct(cr.rate, 0), icon: "target", tone: "accent",
      sub: cr.proposals ? `回数券 契約 ${cr.contracts}件 / 提案 ${cr.proposals}件` : cr.newPatients ? `契約 ${cr.contracts}件 / 新規 ${cr.newPatients}名` : "日報の提案・契約から自動計算",
    }),
    statTile({
      label: "今日の予約人数", value: `${fmtNum(resToday.length)}名`, icon: "calendar", tone: "good",
      sub: resToday.length ? `来院済 ${resToday.filter((r) => r.status === "done").length}名・これから ${resToday.filter((r) => r.status !== "done").length}名` : "本日の予約はありません",
    })));

  const scopeLabel = scopeStores.length === 1 ? scopeStores[0].name : `管轄 ${scopeStores.length}店舗`;
  root.appendChild(sectionTitle("🏥", scopeLabel, `${monthFull(month)}の売上`));
  root.appendChild(salesBlock({
    title: `${scopeLabel}の売上`, sub: isCurrent ? "今月の現在地と着地見込み" : `${monthFull(month)}の実績`,
    s, month, isCurrent, canEditBudget, redraw, stores: scopeStores,
  }));

  if (scopeStores.length > 1) {
    root.appendChild(sectionTitle("📊", "店舗ごと", "現在の売上・予測・予算比"));
    root.appendChild(storeGrid(scopeStores, month, isCurrent));
    root.appendChild(el("div", { class: "grid cols-2 dash-charts" },
      budgetBarsCard(scopeStores, month),
      trendCard(ids, month, scopeLabel)));
  } else {
    root.appendChild(el("div", { class: "grid cols-2 dash-charts" },
      trendCard(ids, month, scopeLabel),
      teamCard(me, ids, month)));
  }
}

/* ============================================================
   スタッフ:所属店舗 + 自分の成績
   ============================================================ */
function drawStaff(root, { me, scopeStores, month, isCurrent, today, redraw }) {
  const ids = scopeStores.map((s) => s.id);
  const storeS = monthSummary(ids, month);
  const mine = personalSummary(me.id, month);
  const myCr = contractRateOf(ids, month, [me.id]);
  const storeCr = contractRateOf(ids, month);
  const resStore = reservationsToday(ids, today);
  const resMine = resStore.filter((r) => r.staffId === me.id);
  const storeName = scopeStores[0]?.name || "所属店舗";

  root.appendChild(el("div", { class: "kpi-row dash-kpi3" },
    statTile({
      label: `新規数(${monthLabel(month)})`, value: `${fmtNum(mine.newPatients)}名`, icon: "users", tone: "brand",
      sub: `自分の担当・${storeName}全体 ${fmtNum(storeS.newPatients)}名`,
    }),
    statTile({
      label: "契約率", value: myCr.rate == null ? "—" : fmtPct(myCr.rate, 0), icon: "target", tone: "accent",
      sub: myCr.proposals ? `契約 ${myCr.contracts} / 提案 ${myCr.proposals}・店舗 ${storeCr.rate == null ? "—" : fmtPct(storeCr.rate, 0)}` : `日報の提案・契約から計算・店舗 ${storeCr.rate == null ? "—" : fmtPct(storeCr.rate, 0)}`,
    }),
    statTile({
      label: "今日の予約人数", value: `${fmtNum(resMine.length)}名`, icon: "calendar", tone: "good",
      sub: `自分の担当・${storeName}全体 ${fmtNum(resStore.length)}名`,
    })));

  root.appendChild(sectionTitle("🏥", storeName, `${monthFull(month)}の売上`));
  root.appendChild(salesBlock({
    title: `${storeName}の売上`, sub: isCurrent ? "今月の現在地と着地見込み" : `${monthFull(month)}の実績`,
    s: storeS, month, isCurrent, canEditBudget: false, redraw, stores: scopeStores,
  }));

  root.appendChild(sectionTitle("🙋", "自分の成績", `${monthFull(month)}・日報から自動集計`));
  root.appendChild(personalCard(me, mine, storeS, month, isCurrent));
}

/* ============================================================
   部品:売上ブロック(数字3つ + 予算メーター + 累計グラフ)
   ============================================================ */
function salesBlock({ title, sub, s, month, isCurrent, canEditBudget, redraw, stores }) {
  const pct = s.budgetPct;
  const tone = pct == null ? "" : (s.forecastPct ?? pct) >= 100 ? "good" : (s.forecastPct ?? pct) >= 85 ? "warn" : "critical";

  const nums = el("div", { class: "dash-nums" },
    numBox({
      label: isCurrent ? "現在の売上" : "売上(月計)", value: fmtYen(s.mtd), tone: "brand",
      sub: s.elapsedDays ? `${s.elapsedDays}営業日の実績・日割り ${fmtYen(Math.round(s.avgPerDay))}` : "まだ売上の記録がありません",
    }),
    numBox({
      label: isCurrent ? "売上の予測(着地見込み)" : "月末時点の予測",
      value: s.forecast ? fmtYen(s.forecast) : "—", tone: "accent",
      sub: s.forecast ? (isCurrent ? `残り ${s.remainingDays}営業日を日割り平均で伸ばした見込み` : `${s.bizDays}営業日ベース`) : "実績が入ると自動で計算します",
    }),
    numBox({
      label: "予算に対して",
      value: pct == null ? "未設定" : fmtPct(pct, 0), tone: tone || "muted",
      sub: pct == null
        ? (canEditBudget ? "「予算を設定」から店舗ごとの月予算を入れられます" : "予算は役員・本部が設定します")
        : `予算 ${fmtYen(s.budget)}・着地見込み ${fmtPct(s.forecastPct ?? 0, 0)}`,
    }));

  const body = el("div", {}, nums);
  if (s.budget) {
    body.appendChild(el("div", { class: "dash-meter" },
      meter({
        label: "予算の達成状況", value: s.mtd, max: s.budget,
        fmt: (v, m) => `${fmtYen(v)} / ${fmtYen(m)}`,
        kind: tone === "good" ? "" : tone,
      })));
  }
  body.appendChild(cumulativeChart(s, month, isCurrent));
  body.appendChild(el("p", { class: "small muted dash-note" },
    "実績は各店舗の売上報告(その日の最後の投稿)から、売上報告が無い日は日報の売上合計から集計しています。",
    isCurrent ? "予測は月初からの日割り平均に当月の営業日数(水曜定休を除く)を掛けたものです。" : ""));

  return card({ title, sub, body, class: "dash-sales" });
}

function numBox({ label, value, sub, tone = "" }) {
  return el("div", { class: `dash-num ${tone}` },
    el("span", { class: "dn-label" }, label),
    el("span", { class: "dn-value" }, value),
    sub ? el("span", { class: "dn-sub" }, sub) : null);
}

/** 当月の累計グラフ:実績 / 予測 / 予算 */
function cumulativeChart(s, month, isCurrent) {
  const dates = datesOfMonth(month);
  const labels = dates.map((d) => `${Number(d.slice(8))}日`);
  const lastIdx = s.lastDataDate ? dates.indexOf(s.lastDataDate) : -1;
  if (lastIdx < 0 && !s.budget) {
    return el("div", { class: "dash-chart-empty" },
      emptyState({ icon: "📈", title: "まだグラフにできる実績がありません", hint: "売上報告か日報が入ると、日ごとの積み上がりと着地見込みが表示されます" }));
  }

  const actual = s.cumulative.slice(0, lastIdx + 1);
  // 予測:実績の続きを、営業日ごとに日割り平均で伸ばす
  const forecast = [];
  let acc = 0;
  dates.forEach((d, i) => {
    if (i <= lastIdx) { acc = s.cumulative[i]; forecast.push(acc); return; }
    if (isBusinessDay(d)) acc += s.avgPerDay;
    forecast.push(Math.round(acc));
  });
  const series = [];
  if (actual.length) series.push({ name: "実績(累計)", color: cssVar("--brand", "#e2621a"), values: actual });
  if (isCurrent && lastIdx >= 0 && lastIdx < dates.length - 1) series.push({ name: "予測(累計)", color: cssVar("--accent", "#0c7489"), values: forecast });
  if (s.budget) series.push({ name: "予算", color: cssVar("--ink-3", "#948c85"), values: dates.map(() => s.budget) });

  return el("div", { class: "dash-cum" },
    lineChart({ series, labels, height: 230, yFmt: (v) => (Number.isFinite(v) ? yenShort(v) : "—"), fillFirst: true }));
}

/* ============================================================
   部品:店舗カードのグリッド
   ============================================================ */
function storeGrid(stores, month, isCurrent) {
  const today = todayStr();
  const dates = datesOfMonth(month);
  const grid = el("div", { class: "dash-store-grid" });
  stores.forEach((st, i) => {
    const s = monthSummary([st.id], month);
    const pct = s.budgetPct;
    const tone = pct == null ? "" : (s.forecastPct ?? pct) >= 100 ? "good" : (s.forecastPct ?? pct) >= 85 ? "warn" : "critical";
    const upto = isCurrent ? dates.filter((d) => d <= today).length : dates.length;
    const spark = sparkline({ values: s.daily.slice(0, upto).map((v) => v || 0), width: 120, height: 34, color: st.color || seriesColor(i) });
    grid.appendChild(el("button", { class: "dash-store", onclick: () => go(`#/uriage`) },
      el("div", { class: "ds-head" },
        el("span", { class: "ds-dot", style: { background: st.color || seriesColor(i) } }),
        el("span", { class: "ds-name" }, st.name),
        s.lastDataDate && isCurrent ? el("span", { class: "ds-upd" }, `${Number(s.lastDataDate.slice(8))}日まで`) : null),
      el("div", { class: "ds-mtd" }, fmtYen(s.mtd)),
      el("div", { class: "ds-rows" },
        el("span", { class: "ds-row" }, el("span", { class: "muted" }, "予測"), el("b", {}, s.forecast ? fmtYen(s.forecast) : "—")),
        el("span", { class: "ds-row" }, el("span", { class: "muted" }, "予算比"),
          el("b", { class: `ds-pct ${tone}` }, pct == null ? "未設定" : fmtPct(pct, 0)))),
      s.budget
        ? el("div", { class: `ds-track ${tone}` }, el("div", { class: "ds-fill", style: { width: `${Math.min(100, Math.max(0, pct))}%` } }))
        : el("div", { class: "ds-track empty" }),
      el("div", { class: "ds-spark" }, spark)));
  });
  return grid;
}

/** 店舗別 予算達成率の横棒 */
function budgetBarsCard(stores, month) {
  const items = stores.map((st, i) => {
    const s = monthSummary([st.id], month);
    return { label: st.name, value: Math.round(s.budgetPct ?? 0), color: st.color || seriesColor(i),
      sub: s.budget ? `${fmtYen(s.mtd)} / 予算 ${fmtYen(s.budget)}・着地 ${fmtPct(s.forecastPct ?? 0, 0)}` : "予算未設定" };
  });
  const any = items.some((x) => x.value > 0);
  return card({
    title: "店舗別 予算達成率", sub: monthFull(month),
    body: any
      ? el("div", {}, hBars({ items, fmt: (v) => `${v}%` }),
          el("p", { class: "small muted dash-note" }, "100%が予算どおり。バーは現在の売上の達成率、下の文字は着地見込みです。"))
      : emptyState({ icon: "🎯", title: "予算が設定されていません", hint: "「予算を設定」から店舗ごとの月予算を入れると達成率が出ます" }),
  });
}

/** 月別の推移(直近8ヶ月の実績と予算) */
function trendCard(ids, month, label) {
  const months = recentMonths(8, month);
  const rev = months.map((m) => monthRevenue(ids, m));
  const bud = months.map((m) => budgetOf(ids, m) || 0);
  const series = [{ name: "実績", color: cssVar("--brand", "#e2621a"), values: rev }];
  if (bud.some((v) => v > 0)) series.push({ name: "予算", color: cssVar("--ink-3", "#948c85"), values: bud });
  return card({
    title: "月別の推移", sub: `${label}・直近8ヶ月`,
    body: rev.some((v) => v > 0)
      ? lineChart({ series, labels: months.map(monthLabel), height: 220, yFmt: yenShort, showDots: true })
      : emptyState({ icon: "📉", title: "まだ月別の実績がありません", hint: "月をまたぐと推移が積み上がっていきます" }),
  });
}

/** 院長向け:店舗メンバーの今月の成績(日報ベース) */
function teamCard(me, ids, month) {
  const members = (store.get("staff") || [])
    .filter((s) => ids.includes(s.storeId) && canSeeStaff(s.id, me) && !["hr", "clerk"].includes(s.rank) && s.role !== "受付");
  const rows = members.map((s) => ({ s, p: personalSummary(s.id, month) }))
    .filter((r) => r.p.workedDays > 0)
    .sort((a, b) => b.p.mtd - a.p.mtd);
  return card({
    title: "メンバーの成績", sub: `${monthFull(month)}・日報から集計`,
    body: rows.length
      ? el("div", { class: "row-list" }, rows.map(({ s, p }) => el("div", { class: "row-item" },
          avatar(s, 30),
          el("span", { class: "row-main" },
            el("span", { class: "row-title" }, s.name),
            el("span", { class: "row-sub" }, `施術 ${p.treatments}件・新規 ${p.newPatients}名・契約率 ${p.contractRate == null ? "—" : fmtPct(p.contractRate, 0)}`)),
          el("b", { class: "dash-amt" }, fmtYen(p.mtd)))))
      : emptyState({ icon: "📓", title: "今月の日報がまだありません", hint: "日報が提出されると、メンバーごとの売上・新規・契約率が並びます" }),
  });
}

/* ============================================================
   部品:自分の成績(スタッフ)
   ============================================================ */
function personalCard(me, mine, storeS, month, isCurrent) {
  const share = storeS.budget ? (mine.mtd / storeS.budget) * 100 : null;
  const dates = datesOfMonth(month);
  const upto = isCurrent ? dates.filter((d) => d <= todayStr()).length : dates.length;
  const spark = sparkline({ values: mine.daily.slice(0, upto).map((v) => v || 0), width: 160, height: 40, color: me.color });

  const nums = el("div", { class: "dash-nums" },
    numBox({ label: isCurrent ? "自分の売上(現在)" : "自分の売上(月計)", value: fmtYen(mine.mtd), tone: "brand",
      sub: mine.workedDays ? `日報 ${mine.workedDays}日分・1日平均 ${fmtYen(Math.round(mine.avgPerWorkday))}` : "日報を提出すると集計されます" }),
    numBox({ label: "自分の売上の予測", value: mine.forecast ? fmtYen(mine.forecast) : "—", tone: "accent",
      sub: mine.forecast ? "これまでの出勤ペースで月末まで働いた場合の見込み" : "日報が入ると自動で計算します" }),
    numBox({ label: "店舗予算に対する貢献", value: share == null ? "—" : fmtPct(share, 1), tone: share == null ? "muted" : "good",
      sub: share == null ? "店舗の予算が設定されると表示されます" : `店舗予算 ${fmtYen(storeS.budget)} のうち自分の売上が占める割合` }));

  const facts = el("div", { class: "dash-facts" },
    kv("施術数", `${fmtNum(mine.treatments)}件`),
    kv("新規患者", `${fmtNum(mine.newPatients)}名`),
    kv("回数券の提案 / 契約", `${fmtNum(mine.proposals)} / ${fmtNum(mine.contracts)}件`),
    kv("契約率", mine.contractRate == null ? "—" : fmtPct(mine.contractRate, 0)),
    kv("物販", fmtYen(mine.goods)));

  return card({
    title: `${me.name.split(" ")[0]}さんの成績`, sub: monthFull(month),
    actions: el("button", { class: "btn ghost sm", onclick: () => go("#/nippo") }, "日報へ", icon("chevR", 13)),
    body: el("div", {}, nums,
      el("div", { class: "dash-personal" },
        el("div", { class: "dash-personal-spark" },
          el("span", { class: "small muted" }, "日ごとの売上"), spark),
        facts)),
    class: "dash-sales",
  });
}

/* ============================================================
   部品:注意が必要 / 連絡事項
   ============================================================ */
function reservationsToday(ids, today) {
  return (store.get("reservations") || [])
    .filter((r) => r.date === today && ids.includes(r.storeId) && (r.status === "confirmed" || r.status === "done"));
}

function alertsCard({ me, role, scopeIds, today }) {
  const staffInScope = (sid) => { const s = store.byId("staff", sid); return !!s && scopeIds.includes(s.storeId); };
  const alerts = [];
  const tasks = store.get("tasks") || [];
  const myOverdue = tasks.filter((t) => t.ownerId === me.id && t.status !== "done" && t.due && t.due < today);
  if (myOverdue.length) alerts.push({
    ic: "clipboard", tone: "critical", title: "期限を過ぎた自分のタスク", count: `${myOverdue.length}件`,
    sub: `「${myOverdue[0].title}」${myOverdue.length > 1 ? ` ほか${myOverdue.length - 1}件` : ""}`, hash: "#/tasks",
  });
  if (role !== "staff") {
    const teamOverdue = tasks.filter((t) => t.ownerId !== me.id && t.status !== "done" && t.due && t.due < today && canSeeStaff(t.ownerId, me));
    if (teamOverdue.length) alerts.push({
      ic: "users", tone: "warn", title: "メンバーの期限超過タスク", count: `${teamOverdue.length}件`,
      sub: `${store.staffName(teamOverdue[0].ownerId)}さん「${teamOverdue[0].title}」など`, hash: "#/tasks",
    });
    const missing = (store.get("attendance") || []).filter((a) => a.status === "missing" && !a.approved && staffInScope(a.staffId));
    if (missing.length) alerts.push({
      ic: "clock", tone: "critical", title: "打刻漏れ", count: `${missing.length}件`,
      sub: "未承認の打刻漏れが残っています。勤怠管理で修正・承認をお願いします", hash: "#/kintai",
    });
    const lowStock = (store.get("inventory") || []).filter((i) => i.stock < i.min);
    if (lowStock.length) alerts.push({
      ic: "box", tone: "warn", title: "在庫アラート", count: `${lowStock.length}品目`,
      sub: `${lowStock.slice(0, 2).map((i) => i.name).join("・")}${lowStock.length > 2 ? ` ほか${lowStock.length - 2}品目` : ""}が発注点を下回っています`, hash: "#/backoffice",
    });
    const churn = (store.get("patients") || []).filter((p) => p.churnRisk === "high" && scopeIds.includes(p.storeId));
    if (churn.length) alerts.push({
      ic: "heart", tone: "serious", title: "離反リスクの患者様", count: `${churn.length}名`,
      sub: `${churn.slice(0, 3).map((p) => `${p.name}様`).join("・")}の来院間隔が空いています`, hash: "#/patients",
    });
    const unreported = scopeIds.filter((id) => isBusinessDay(today) && !storeDay(id, today));
    if (unreported.length && role !== "staff") alerts.push({
      ic: "trend", tone: "warn", title: "本日の売上報告が未提出", count: `${unreported.length}店舗`,
      sub: `${unreported.slice(0, 3).map((id) => store.storeName(id)).join("・")}${unreported.length > 3 ? " ほか" : ""}。締め後に投稿してください`, hash: "#/uriage",
    });
  }
  const body = alerts.length
    ? el("div", { class: "stack", style: { gap: "8px" } },
        alerts.map((a) => el("button", { class: "alert-row", onclick: () => go(a.hash) },
          el("span", { class: `alert-ic ${a.tone}` }, icon(a.ic, 18)),
          el("span", { class: "alert-main" },
            el("span", { class: "alert-title" }, a.title,
              badge(a.count, a.tone === "warn" ? "warn" : a.tone === "serious" ? "serious" : "critical")),
            el("span", { class: "alert-sub" }, a.sub)),
          el("span", { class: "alert-chev" }, icon("chevR", 15)))))
    : emptyState({ icon: "🎉", title: "注意事項はありません", hint: "すべて順調です。この調子でいきましょう!" });
  return card({ title: "注意が必要", sub: alerts.length ? `${alerts.length}件のフォローをおすすめします` : "問題ありません", body });
}

function newsCard() {
  const posts = store.get("posts") || [];
  const pinned = posts.filter((p) => p.pinned);
  const latest = posts
    .filter((p) => ["notice", "timeline"].includes(p.type) && !p.pinned)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 3);
  const news = [...pinned, ...latest].slice(0, 4);
  const body = news.length
    ? el("div", { class: "row-list" },
        news.map((p) => el("div", { class: "row-item clickable post-item", onclick: () => go(`#/sns/${p.type === "timeline" ? "timeline" : "notice"}`) },
          avatar(store.byId("staff", p.authorId), 32),
          el("span", { class: "row-main" },
            el("span", { class: "flex", style: { gap: "7px", marginBottom: "2px", minWidth: "0" } },
              p.pinned ? badge("ピン留め", "accent") : badge(p.type === "timeline" ? "タイムライン" : "連絡事項", "brand"),
              el("span", { class: "row-title", style: { flex: "1", minWidth: "0" } }, p.title || "")),
            el("span", { class: "post-body" }, p.body),
            el("span", { class: "small muted", style: { marginTop: "3px", display: "block" } },
              `${store.staffName(p.authorId)}・${relTime(p.date)}`)))))
    : emptyState({ icon: "📣", title: "連絡事項はまだありません", hint: "社内SNSの「連絡事項」「タイムライン」から投稿できます" });
  return card({
    title: "連絡事項・タイムライン",
    actions: el("button", { class: "btn ghost sm", onclick: () => go("#/sns") }, "社内SNSへ", icon("chevR", 13)),
    body,
  });
}

/* ============================================================
   予算の設定(役員以上・本部人事)
   ============================================================ */
function openBudgetModal(stores, month, redraw) {
  const budgets = store.get("budgets") || [];
  const inputs = new Map();
  const rows = stores.map((st) => {
    const cur = budgets.find((b) => b.storeId === st.id && b.month === month);
    const prevRow = budgets.find((b) => b.storeId === st.id && b.month === prevMonthOf(month));
    const input = el("input", {
      class: "input", type: "number", min: "0", step: "10000", inputmode: "numeric",
      placeholder: prevRow ? `前月 ${fmtNum(prevRow.amount)}` : "例)3200000",
    });
    input.value = cur ? String(cur.amount) : "";
    inputs.set(st.id, input);
    return el("div", { class: "form-row dash-budget-row" },
      el("div", { class: "field" }, el("label", {}, st.name), input));
  });

  const copyBtn = el("button", { class: "btn ghost sm", type: "button" }, icon("refresh", 13), "前月の予算をコピー");
  copyBtn.addEventListener("click", () => {
    let n = 0;
    for (const st of stores) {
      const prevRow = budgets.find((b) => b.storeId === st.id && b.month === prevMonthOf(month));
      if (prevRow) { inputs.get(st.id).value = String(prevRow.amount); n++; }
    }
    toast(n ? `${n}店舗に前月の予算を入れました` : "前月の予算がありません", n ? "success" : "info");
  });

  const okBtn = el("button", { class: "btn primary" }, icon("check", 15), "保存する");
  const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
  const m = modal({
    title: `${monthFull(month)}の売上予算`,
    body: el("div", { class: "page-dashboard dash-budget" },
      el("p", { class: "small muted" }, "店舗ごとの月の売上予算(円)を入れてください。ダッシュボードの「予算に対しての%」の分母になります。空欄の店舗は未設定のままです。"),
      el("div", { class: "dash-budget-tools" }, copyBtn),
      ...rows),
    actions: [cancelBtn, okBtn],
  });
  cancelBtn.addEventListener("click", () => m.close());
  okBtn.addEventListener("click", () => {
    let saved = 0;
    for (const st of stores) {
      const raw = inputs.get(st.id).value.trim();
      if (raw === "") continue;
      const amount = Math.max(0, Math.round(Number(raw) || 0));
      const cur = (store.get("budgets") || []).find((b) => b.storeId === st.id && b.month === month);
      if (cur) store.update("budgets", cur.id, { amount });
      else store.add("budgets", { id: `bg-${st.id}-${month}`, storeId: st.id, month, amount, note: "" });
      saved++;
    }
    m.close();
    toast(saved ? `${saved}店舗の予算を保存しました` : "変更はありませんでした", saved ? "success" : "info");
    redraw();
  });
}

function prevMonthOf(month) {
  const [y, mm] = month.split("-").map(Number);
  const d = new Date(y, mm - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/* ---------------- 小さなヘルパー ---------------- */
function sectionTitle(emoji, title, sub) {
  return el("div", { class: "dash-sec" },
    el("span", { class: "dash-sec-ic" }, emoji),
    el("h2", { class: "dash-sec-title" }, title),
    sub ? el("span", { class: "dash-sec-sub" }, sub) : null);
}
