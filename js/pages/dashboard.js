/* ============================================================
   ダッシュボード(経営コックピット)
   店舗フィルタで全体を再集計し、売上・契約率・消化率・
   今日のうごき・注意事項をひと目で確認できるページ。
   ============================================================ */

import {
  el, fmtYen, fmtNum, fmtPct, fmtDate, relTime, icon, avatar, badge, kv,
  statTile, meter, card, sectionHeader, segmented, statusBadge, emptyState,
} from "../ui.js";
import { sparkline, lineChart, hBars, seriesColor } from "../charts.js";
import { store, todayStr, dow } from "../store.js";

const PRACTITIONER_ROLES = ["院長", "柔道整復師", "鍼灸師"];
const SLOTS_PER_DAY = 9; // 10:00〜19:00 の施術枠数(1時間刻み)

const cssVar = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
const monthLabel = (m) => `${Number(m.slice(5))}月`;
const monthFull = (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;
const go = (hash) => { location.hash = hash; };
const sum = (arr, f) => arr.reduce((a, x) => a + (f ? f(x) : x), 0);
const round1 = (n) => Math.round(n * 10) / 10;
const wavg = (rows, key, wkey) => {
  const tw = sum(rows, (r) => r[wkey]);
  return tw ? sum(rows, (r) => r[key] * r[wkey]) / tw : 0;
};

export default {
  id: "dashboard",
  title: "ダッシュボード",
  icon: "home",

  // このページが必要とするデータ。ルーターがそろえてから render() を呼ぶ
  needs: ["attendance", "inventory", "kpiMonthly", "meetings", "patients", "posts", "reservations", "shifts", "staff", "stores", "tasks"],
  render(root) {
    const draw = () => {
      root.innerHTML = "";
      buildPage(root, draw);
    };
    draw();
  },
};

/* ---------------- ページ本体 ---------------- */

function buildPage(root, redraw) {
  const today = todayStr();
  const allStores = store.get("stores");
  const scopeRaw = store.state.settings.storeFilter;
  const scope = allStores.some((s) => s.id === scopeRaw) ? scopeRaw : "all";
  const inScope = (storeId) => scope === "all" || storeId === scope;

  /* ---- 月次KPIの集計(スコープでフィルタ) ---- */
  const kpis = store.get("kpiMonthly");
  const months = [...new Set(kpis.map((k) => k.month))].sort().slice(-8);
  const byMonth = months.map((m) => {
    const rows = kpis.filter((k) => k.month === m && inScope(k.storeId));
    return {
      month: m,
      revenue: sum(rows, (r) => r.revenue),
      target: sum(rows, (r) => r.target),
      newPatients: sum(rows, (r) => r.newPatients),
      contracts: sum(rows, (r) => r.contracts),
      patients: sum(rows, (r) => r.patients),
      contractRate: wavg(rows, "contractRate", "newPatients"),
      digestion: wavg(rows, "digestion", "patients"),
      repeatRate: wavg(rows, "repeatRate", "patients"),
      avgSpend: wavg(rows, "avgSpend", "patients"),
    };
  });
  const cur = byMonth[byMonth.length - 1] || { revenue: 0, target: 0, month: today.slice(0, 7) };
  const prev = byMonth[byMonth.length - 2] || null;

  /* ---- 本日の予約・稼働 ---- */
  const resToday = store.get("reservations").filter((r) => r.date === today && inScope(r.storeId));
  const resActive = resToday
    .filter((r) => r.status === "confirmed" || r.status === "done")
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const resDone = resActive.filter((r) => r.status === "done").length;

  const workingIds = new Set(
    store.get("shifts")
      .filter((sh) => sh.date === today && ["early", "late", "full"].includes(sh.type))
      .map((sh) => sh.staffId));
  const workers = store.get("staff")
    .filter((s) => workingIds.has(s.id) && inScope(s.storeId) && PRACTITIONER_ROLES.includes(s.role));
  const capacity = workers.length * SLOTS_PER_DAY;

  /* ---- 注意が必要(打刻漏れ / 在庫 / 離反 / 期限超過) ---- */
  const staffInScope = (sid) => { const s = store.byId("staff", sid); return !!s && inScope(s.storeId); };
  const missing = store.get("attendance").filter((a) => a.status === "missing" && !a.approved && staffInScope(a.staffId));
  const lowStock = store.get("inventory").filter((i) => i.stock < i.min);
  const churn = store.get("patients").filter((p) => p.churnRisk === "high" && inScope(p.storeId));
  const overdue = store.get("meetings")
    .flatMap((m) => (m.actionItems || []).map((a) => ({ ...a, meeting: m.title })))
    .filter((a) => a.due < today && a.status !== "done");

  /* ---- ヘッダー(店舗フィルタ) ---- */
  const segItems = [{ id: "all", label: "全店" }, ...allStores.map((s) => ({ id: s.id, label: s.short }))];
  const desc = scope === "all"
    ? "全店舗の経営数値と今日のうごきをひと目で確認できます"
    : `${store.storeName(scope)}の数値に絞り込んでいます。「全店」で比較表示に戻せます`;
  root.appendChild(sectionHeader("経営コックピット", desc,
    segmented(segItems, scope, (id) => { store.setSetting("storeFilter", id); redraw(); })));

  /* ---- KPIタイル ---- */
  const targetDelta = cur.target ? round1((cur.revenue / cur.target - 1) * 100) : null;
  root.appendChild(el("div", { class: "kpi-row" },
    statTile({
      label: "今月売上", value: fmtYen(cur.revenue), icon: "trend", tone: "brand",
      delta: targetDelta, deltaLabel: "対 目標",
      spark: sparkline({ values: byMonth.map((b) => b.revenue), width: 92, height: 30 }),
    }),
    statTile({
      label: "契約率(今月)", value: fmtPct(cur.contractRate, 1), icon: "target", tone: "accent",
      delta: prev ? round1(cur.contractRate - prev.contractRate) : null, deltaLabel: "前月比",
    }),
    statTile({
      label: "回数券消化率", value: fmtPct(cur.digestion, 1), icon: "ticket", tone: "violet",
      delta: prev ? round1(cur.digestion - prev.digestion) : null, deltaLabel: "前月比",
    }),
    statTile({
      label: "本日の予約", value: `${resActive.length}件`, icon: "calendar", tone: "brand",
      sub: resActive.length ? `来院済 ${resDone}件・これから ${resActive.length - resDone}件` : "本日の予約はありません",
    }),
  ));

  /* ---- 売上推移チャート ---- */
  const labels = months.map(monthLabel);
  const yFmt = (v) => (v >= 10000 ? fmtNum(Math.round(v / 10000)) + "万" : fmtNum(Math.round(v)));
  let series;
  if (scope === "all") {
    series = allStores.map((s, i) => ({
      name: s.short,
      color: seriesColor(i),
      values: months.map((m) => kpis.find((k) => k.storeId === s.id && k.month === m)?.revenue || 0),
    }));
  } else {
    const idx = allStores.findIndex((s) => s.id === scope);
    series = [
      { name: "実績", color: seriesColor(idx), values: byMonth.map((b) => b.revenue) },
      { name: "目標", color: cssVar("--ink-3", "#8a938f"), values: byMonth.map((b) => b.target) },
    ];
  }
  const revCard = card({
    title: "売上推移",
    sub: scope === "all" ? "直近8ヶ月・店舗別" : "直近8ヶ月・実績と目標",
    body: lineChart({ series, labels, height: 240, yFmt }),
  });

  /* ---- 今月の店舗別売上(目標比つき) ---- */
  const curRows = kpis.filter((k) => k.month === cur.month);
  const barCard = card({
    title: "今月の店舗別売上",
    sub: monthFull(cur.month),
    body: el("div", {},
      hBars({
        items: allStores.map((s, i) => {
          const r = curRows.find((k) => k.storeId === s.id);
          const pct = r && r.target ? Math.round((r.revenue / r.target) * 100) : 0;
          return { label: s.name, value: r?.revenue || 0, color: seriesColor(i), sub: `目標比 ${pct}%` };
        }),
        fmt: (v) => fmtYen(v),
      }),
      el("p", { class: "small muted", style: { marginTop: "12px" } },
        "全店の比較表示です。目標は各店の月次KPIから自動取得しています。")),
  });

  /* ---- 今日のうごき ---- */
  const todayBody = el("div", {});
  const meters = el("div", { class: "stack", style: { gap: "12px", marginBottom: "14px" } });
  if (capacity > 0) {
    meters.appendChild(meter({
      label: `予約枠の稼働率(施術者${workers.length}名)`,
      value: resActive.length, max: capacity,
      fmt: (v, m) => `${v} / ${m}枠`,
      kind: resActive.length / capacity < 0.35 ? "warn" : "",
    }));
  }
  if (resActive.length > 0) {
    meters.appendChild(meter({
      label: "来院の消化状況",
      value: resDone, max: resActive.length,
      fmt: (v, m) => `${v} / ${m}件`,
      kind: "accent",
    }));
  }
  if (meters.childNodes.length) todayBody.appendChild(meters);

  if (!resActive.length) {
    todayBody.appendChild(emptyState({
      icon: "🌿",
      title: "本日の予約はありません",
      hint: dow(today) === 3 ? "水曜は定休日です。ゆっくり休みましょう" : "予約管理から新規予約を登録できます",
    }));
  } else {
    const list = el("div", { class: "row-list" });
    for (const r of resActive.slice(0, 6)) {
      const name = r.patientId ? `${store.patientName(r.patientId)} 様` : (r.guestName || "ゲスト");
      list.appendChild(el("div", { class: "row-item clickable", onclick: () => go("#/reserve") },
        el("span", { class: "dash-time" }, r.start),
        el("span", { class: "row-main" },
          el("span", { class: "row-title" }, name),
          el("span", { class: "row-sub" },
            [scope === "all" ? store.storeName(r.storeId) : null, store.menuName(r.menuId), `担当 ${store.staffName(r.staffId)}`]
              .filter(Boolean).join("・"))),
        statusBadge(r.status)));
    }
    if (resActive.length > 6) {
      list.appendChild(el("button", { class: "dash-more", onclick: () => go("#/reserve") },
        `ほか ${resActive.length - 6} 件の予約を予約管理で確認`, icon("chevR", 14)));
    }
    todayBody.appendChild(list);
  }
  const todayCard = card({
    title: "今日のうごき", sub: fmtDate(today),
    actions: linkBtn("#/reserve", "予約管理へ"),
    body: todayBody,
  });

  /* ---- 注意が必要 ---- */
  const alerts = [];
  if (missing.length) alerts.push({
    ic: "clock", tone: "critical", title: "打刻漏れ", count: `${missing.length}件`,
    sub: "未承認の打刻漏れが残っています。勤怠管理で修正・承認をお願いします",
    hash: "#/kintai",
  });
  if (lowStock.length) alerts.push({
    ic: "box", tone: "warn", title: "在庫アラート", count: `${lowStock.length}品目`,
    sub: `${lowStock.slice(0, 2).map((i) => i.name).join("・")}${lowStock.length > 2 ? ` ほか${lowStock.length - 2}品目` : ""}が発注点を下回っています`,
    hash: "#/backoffice",
  });
  if (churn.length) alerts.push({
    ic: "heart", tone: "serious", title: "離反リスクの患者様", count: `${churn.length}名`,
    sub: `${churn.map((p) => `${p.name}様`).join("・")}の来院間隔が空いています。フォロー連絡をご検討ください`,
    hash: "#/patients",
  });
  if (overdue.length) alerts.push({
    ic: "clipboard", tone: "critical", title: "期限超過のタスク", count: `${overdue.length}件`,
    sub: `「${overdue[0].title}」など、会議のアクションアイテムが期限を過ぎています`,
    hash: "#/meetings",
  });

  const alertBody = alerts.length
    ? el("div", { class: "stack", style: { gap: "8px" } },
        alerts.map((a) => el("button", { class: "alert-row", onclick: () => go(a.hash) },
          el("span", { class: `alert-ic ${a.tone}` }, icon(a.ic, 18)),
          el("span", { class: "alert-main" },
            el("span", { class: "alert-title" }, a.title,
              badge(a.count, a.tone === "warn" ? "warn" : a.tone === "serious" ? "serious" : "critical")),
            el("span", { class: "alert-sub" }, a.sub)),
          el("span", { class: "alert-chev" }, icon("chevR", 15)))))
    : emptyState({ icon: "🎉", title: "注意事項はありません", hint: "すべて順調です。この調子でいきましょう!" });
  const alertCard = card({
    title: "注意が必要",
    sub: alerts.length ? `${alerts.length}件のフォローをおすすめします` : "問題ありません",
    body: alertBody,
  });

  /* ---- 朝礼・お知らせ ---- */
  const posts = store.get("posts");
  const pinnedPosts = posts.filter((p) => p.pinned);
  const chourei = posts
    .filter((p) => p.type === "chourei" && !p.pinned)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 2);
  const news = [...pinnedPosts, ...chourei].slice(0, 3);
  const newsBody = news.length
    ? el("div", { class: "row-list" },
        news.map((p) => el("div", { class: "row-item clickable post-item", onclick: () => go("#/sns") },
          avatar(store.byId("staff", p.authorId), 32),
          el("span", { class: "row-main" },
            el("span", { class: "flex", style: { gap: "7px", marginBottom: "2px", minWidth: "0" } },
              p.pinned ? badge("ピン留め", "accent") : badge(p.type === "chourei" ? "朝礼" : "お知らせ", "brand"),
              el("span", { class: "row-title", style: { flex: "1", minWidth: "0" } }, p.title || "")),
            el("span", { class: "post-body" }, p.body),
            el("span", { class: "small muted", style: { marginTop: "3px", display: "block" } },
              `${store.staffName(p.authorId)}・${relTime(p.date)}`)))))
    : emptyState({ icon: "📣", title: "お知らせはまだありません", hint: "社内SNSから投稿できます" });
  const newsCard = card({
    title: "朝礼・お知らせ",
    actions: linkBtn("#/sns", "社内SNSへ"),
    body: newsBody,
  });

  /* ---- 経営数値(今月) ---- */
  const bizCard = card({
    title: "経営数値(今月)", sub: monthFull(cur.month),
    body: el("div", {},
      kv("客単価", withDelta(fmtYen(Math.round(cur.avgSpend || 0)),
        prev && prev.avgSpend ? (cur.avgSpend / prev.avgSpend - 1) * 100 : null, (d) => `${round1(d)}%`)),
      kv("リピート率", withDelta(fmtPct(cur.repeatRate, 1),
        prev ? cur.repeatRate - prev.repeatRate : null, (d) => `${round1(d)}pt`)),
      kv("新規患者数", withDelta(`${fmtNum(cur.newPatients)}名`,
        prev ? cur.newPatients - prev.newPatients : null, (d) => `${Math.round(d)}名`)),
      kv("回数券契約", withDelta(`${fmtNum(cur.contracts)}件`,
        prev ? cur.contracts - prev.contracts : null, (d) => `${Math.round(d)}件`)),
      kv("延べ来院数", withDelta(`${fmtNum(cur.patients)}名`,
        prev ? cur.patients - prev.patients : null, (d) => `${Math.round(d)}名`)),
      el("p", { class: "small muted", style: { marginTop: "10px" } },
        "数値は日報・レジ実績・回数券の利用状況から自動で集計されます。")),
  });

  /* ---- レイアウト ---- */
  root.appendChild(el("div", { class: "dash-grid" },
    el("div", { class: "dash-col" }, revCard, barCard),
    el("div", { class: "dash-col" }, todayCard, alertCard)));
  root.appendChild(el("div", { class: "grid cols-2 dash-bottom" }, newsCard, bizCard));
}

/* ---------------- 小さなヘルパー ---------------- */

function linkBtn(hash, label) {
  return el("button", { class: "btn ghost sm", onclick: () => go(hash) }, label, icon("chevR", 13));
}

/** 値の右肩に前月比の小さな増減チップを添える */
function withDelta(mainText, diff, fmt) {
  const chipEl = (diff == null || !isFinite(diff)) ? null : (() => {
    const dir = diff > 0.05 ? "up" : diff < -0.05 ? "down" : "flat";
    return el("span", { class: `dash-delta ${dir}` },
      icon(dir === "up" ? "arrowUp" : dir === "down" ? "arrowDown" : "check", 12),
      fmt(Math.abs(diff)));
  })();
  return el("span", { class: "flex", style: { gap: "7px", justifyContent: "flex-end" } }, chipEl, mainText);
}
