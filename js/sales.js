/* ============================================================
   売上の集計と予測(ダッシュボード・売上報告で共通)

   「いまの売上」「月末の見込み」「予算に対して何%か」を
   店舗の集合(全社 / 管轄 / 自店舗)と個人の両方で出せるようにする。

   ◎ 店舗の1日の売上
       その日の売上報告(投稿)の最後の1件を「その日の数字」とする。
       中間報告と締め報告の両方があっても二重に数えない。
       売上報告が無い日は、その日の日報の売上合計で補う。

   ◎ 予測(着地見込み)
       月初から直近の営業日までの実績を営業日数で割り、
       その日割り平均に当月の営業日数を掛ける。
       水曜は定休なので営業日に数えない。

   ◎ 予算
       budgets コレクション(店舗 × 月)。未設定なら null を返し、
       画面側で「予算未設定」を出す。
   ============================================================ */

import { store, todayStr, addDays, monthOf, dow } from "./store.js";

const CLOSED_DOW = 3; // 水曜定休
const pad2 = (n) => String(n).padStart(2, "0");

/** その月の日数 */
export function daysInMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

/** その月の日付一覧("YYYY-MM-DD") */
export function datesOfMonth(month) {
  const n = daysInMonth(month);
  return Array.from({ length: n }, (_, i) => `${month}-${pad2(i + 1)}`);
}

export const isBusinessDay = (date) => dow(date) !== CLOSED_DOW;

/** 月の営業日数(upTo を渡すとその日まで) */
export function businessDays(month, upTo = null) {
  return datesOfMonth(month).filter((d) => isBusinessDay(d) && (!upTo || d <= upTo)).length;
}

/** 翌月 "YYYY-MM" */
export function nextMonth(month) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 前月 "YYYY-MM" */
export function prevMonth(month) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/* ------------------------------------------------------------
   店舗の日次売上
   ------------------------------------------------------------ */

/**
 * 店舗 × 日 の売上と新患・契約などの内訳。
 * 返り値: { sales, patients, newPatients, cancels, source } / データが無ければ null
 */
export function storeDay(storeId, date) {
  const posts = (store.get("posts") || [])
    .filter((p) => p.type === "uriage" && p.storeId === storeId && (p.date || "").startsWith(date))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (posts.length) {
    const u = posts[posts.length - 1].uriage || {};
    return {
      sales: Number(u.sales) || 0,
      patients: Number(u.patients) || 0,
      newPatients: Number(u.newPatients) || 0,
      cancels: Number(u.cancels) || 0,
      source: "uriage",
    };
  }
  const reports = (store.get("dailyReports") || [])
    .filter((r) => r.storeId === storeId && r.date === date && r.status !== "draft");
  if (!reports.length) return null;
  return {
    sales: reports.reduce((a, r) => a + (Number(r.revenue) || 0) + (Number(r.goods) || 0), 0),
    patients: reports.reduce((a, r) => a + (Number(r.treatments) || 0), 0),
    newPatients: reports.reduce((a, r) => a + (Number(r.newPatients) || 0), 0),
    cancels: 0,
    source: "nippo",
  };
}

/**
 * 店舗集合の当月の日次売上の配列(1日〜月末)。データの無い日は null。
 *   dailySales(["st-a","st-b"], "2026-09") → [120000, null, ...]
 */
export function dailySales(storeIds, month) {
  return datesOfMonth(month).map((date) => {
    let sum = 0;
    let any = false;
    for (const id of storeIds) {
      const d = storeDay(id, date);
      if (d) { any = true; sum += d.sales; }
    }
    return any ? sum : null;
  });
}

/* ------------------------------------------------------------
   月次の集計と予測
   ------------------------------------------------------------ */

/**
 * 店舗集合の月次サマリー。
 * @returns {{
 *   month, mtd, forecast, budget, budgetPct, forecastPct, avgPerDay,
 *   bizDays, elapsedDays, remainingDays, lastDataDate,
 *   cumulative:number[], daily:(number|null)[],
 *   newPatients, patients, cancels
 * }}
 */
export function monthSummary(storeIds, month = monthOf(todayStr())) {
  const ids = [...new Set(storeIds)].filter(Boolean);
  const daily = dailySales(ids, month);
  const dates = datesOfMonth(month);
  const today = todayStr();

  let mtd = 0;
  let lastDataDate = null;
  const cumulative = [];
  daily.forEach((v, i) => {
    if (v != null) { mtd += v; lastDataDate = dates[i]; }
    cumulative.push(mtd);
  });

  const bizDays = businessDays(month);
  // 予測の分母:データがある最終日まで(今日より先は数えない)
  const through = lastDataDate && lastDataDate <= today ? lastDataDate : (month === monthOf(today) ? addDays(today, -1) : dates[dates.length - 1]);
  const elapsedDays = through >= dates[0] ? businessDays(month, through) : 0;
  const avgPerDay = elapsedDays ? mtd / elapsedDays : 0;
  const forecast = elapsedDays ? Math.round(avgPerDay * bizDays) : 0;
  const remainingDays = Math.max(0, bizDays - elapsedDays);

  const budget = budgetOf(ids, month);
  const budgetPct = budget ? (mtd / budget) * 100 : null;
  const forecastPct = budget ? (forecast / budget) * 100 : null;

  let newPatients = 0, patients = 0, cancels = 0;
  for (const id of ids) for (const date of dates) {
    const d = storeDay(id, date);
    if (!d) continue;
    newPatients += d.newPatients; patients += d.patients; cancels += d.cancels;
  }

  return {
    month, mtd, forecast, budget, budgetPct, forecastPct, avgPerDay,
    bizDays, elapsedDays, remainingDays, lastDataDate,
    cumulative, daily, newPatients, patients, cancels,
  };
}

/** 店舗集合の月の予算合計。1店舗も設定が無ければ null */
export function budgetOf(storeIds, month) {
  const rows = (store.get("budgets") || []).filter((b) => b.month === month && storeIds.includes(b.storeId));
  if (!rows.length) return null;
  return rows.reduce((a, b) => a + (Number(b.amount) || 0), 0);
}

/**
 * 過去の月次売上(推移グラフ用)。
 * 月次KPI(kpiMonthly)があればそれを、無ければ日次データから積み上げる。
 */
export function monthRevenue(storeIds, month) {
  const kpi = (store.get("kpiMonthly") || []).filter((k) => k.month === month && storeIds.includes(k.storeId));
  if (kpi.length) return kpi.reduce((a, k) => a + (Number(k.revenue) || 0), 0);
  return dailySales(storeIds, month).reduce((a, v) => a + (v || 0), 0);
}

/** 直近 n ヶ月の一覧(古い順、当月を含む) */
export function recentMonths(n, from = monthOf(todayStr())) {
  const out = [from];
  while (out.length < n) out.unshift(prevMonth(out[0]));
  return out;
}

/* ------------------------------------------------------------
   個人の成績(日報から)
   ------------------------------------------------------------ */

/**
 * 自分の当月成績。日報(提出済み)から集計する。
 */
export function personalSummary(staffId, month = monthOf(todayStr())) {
  const dates = datesOfMonth(month);
  const reports = (store.get("dailyReports") || [])
    .filter((r) => r.staffId === staffId && monthOf(r.date) === month && r.status !== "draft");
  const byDate = new Map(reports.map((r) => [r.date, r]));
  const today = todayStr();

  let mtd = 0, treatments = 0, newPatients = 0, proposals = 0, contracts = 0, goods = 0;
  let lastDataDate = null;
  const cumulative = [];
  const daily = dates.map((date) => {
    const r = byDate.get(date);
    if (!r) { cumulative.push(mtd); return null; }
    const v = (Number(r.revenue) || 0) + (Number(r.goods) || 0);
    mtd += v; treatments += Number(r.treatments) || 0; newPatients += Number(r.newPatients) || 0;
    proposals += Number(r.proposals) || 0; contracts += Number(r.contracts) || 0; goods += Number(r.goods) || 0;
    lastDataDate = date;
    cumulative.push(mtd);
    return v;
  });

  // 個人は出勤日ベース:日報を出した日数で日割りし、店舗の営業日数で伸ばす
  const workedDays = reports.length;
  const through = lastDataDate && lastDataDate <= today ? lastDataDate : addDays(today, -1);
  const elapsedBiz = through >= dates[0] ? businessDays(month, through) : 0;
  const bizDays = businessDays(month);
  // 出勤率(これまでの営業日のうち日報を出した割合)で残りの営業日も同じペースと仮定する
  const attendRate = elapsedBiz ? Math.min(1, workedDays / elapsedBiz) : 0;
  const avgPerWorkday = workedDays ? mtd / workedDays : 0;
  const forecast = Math.round(avgPerWorkday * (workedDays + attendRate * Math.max(0, bizDays - elapsedBiz)));
  const contractRate = proposals ? (contracts / proposals) * 100 : (newPatients ? (contracts / newPatients) * 100 : null);

  return {
    month, mtd, forecast, treatments, newPatients, proposals, contracts, goods, contractRate,
    workedDays, avgPerWorkday, cumulative, daily, lastDataDate,
  };
}

/** 店舗集合の当月の契約率(日報ベース)。提案が無ければ新患ベースで代替 */
export function contractRateOf(storeIds, month = monthOf(todayStr()), staffIds = null) {
  const reports = (store.get("dailyReports") || []).filter((r) =>
    monthOf(r.date) === month && r.status !== "draft"
    && (staffIds ? staffIds.includes(r.staffId) : storeIds.includes(r.storeId)));
  const proposals = reports.reduce((a, r) => a + (Number(r.proposals) || 0), 0);
  const contracts = reports.reduce((a, r) => a + (Number(r.contracts) || 0), 0);
  const newPatients = reports.reduce((a, r) => a + (Number(r.newPatients) || 0), 0);
  const rate = proposals ? (contracts / proposals) * 100 : (newPatients ? (contracts / newPatients) * 100 : null);
  return { rate, proposals, contracts, newPatients };
}
