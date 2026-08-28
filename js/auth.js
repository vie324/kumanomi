/* ============================================================
   くまのみポータル — 権限(RBAC)エンジン【組織ツリー版】
   「自分の傘の下(組織図の配下)にある情報はすべて見える」を軸に、
   メンター関係と出勤状態を重ねて判定する。
   組織図(reportsTo)はドラッグで毎月付け替えられる前提のため、
   すべての判定は保存済みツリーからその場で計算する。
   ============================================================ */

import { store, todayStr } from "./store.js";

/* ---------------- 役職ランク ----------------
   ランクは「できる操作の強さ」。見える範囲はツリー(reportsTo)が決める。 */
export const RANKS = {
  ceo: { level: 7, label: "社長", desc: "全社のすべてにアクセスできます" },
  exec: { level: 6, label: "統括マネージャー", desc: "配下の全エリア・全店舗を統括します" },
  area: { level: 5, label: "マネージャー", desc: "管轄する店舗群を統括します" },
  chief: { level: 4, label: "統括院長", desc: "管轄する院の院長たちを統括します" },
  manager: { level: 3, label: "院長・店長", desc: "自店舗の責任者。シフト編集・勤怠承認ができます" },
  mentor: { level: 2, label: "メンター", desc: "担当メンティーの日報も確認できます" },
  staff: { level: 1, label: "スタッフ", desc: "自分の情報と担当患者様を扱えます" },
  hr: { level: 3, label: "本部人事", desc: "全店舗の勤怠・シフトを管理します(日報は対象外)" },
  clerk: { level: 1, label: "事務職員", desc: "給与に直結する勤怠・経費・交通費・発注を最終確認します" },
};

export function rankOf(staff) { return staff?.rank || "staff"; }
export function rankLabel(staff) { return RANKS[rankOf(staff)]?.label || "スタッフ"; }
export function rankLevel(staff) { return RANKS[rankOf(staff)]?.level ?? 1; }

/* ---------------- 組織ツリー ---------------- */

/** 直属の部下 */
export function directReports(staffId) {
  return store.get("staff").filter((s) => s.reportsTo === staffId);
}

/** 配下全員のID(自分は含まない)。循環しても無限ループしない */
export function subtreeIds(staffId) {
  const out = [];
  const seen = new Set([staffId]);
  const queue = [staffId];
  while (queue.length) {
    const cur = queue.shift();
    for (const child of directReports(cur)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child.id);
      queue.push(child.id);
    }
  }
  return out;
}

/** target が base の配下(傘の下)か */
export function isDescendant(targetId, baseId) {
  if (!targetId || !baseId) return false;
  let cur = store.byId("staff", targetId);
  const seen = new Set();
  while (cur?.reportsTo) {
    if (cur.reportsTo === baseId) return true;
    if (seen.has(cur.reportsTo)) return false; // 循環ガード
    seen.add(cur.reportsTo);
    cur = store.byId("staff", cur.reportsTo);
  }
  return false;
}

/** 自分から社長までの上司チェーン(近い順) */
export function chainOf(staffId) {
  const chain = [];
  let cur = store.byId("staff", staffId);
  const seen = new Set([staffId]);
  while (cur?.reportsTo && !seen.has(cur.reportsTo)) {
    seen.add(cur.reportsTo);
    cur = store.byId("staff", cur.reportsTo);
    if (cur) chain.push(cur);
  }
  return chain;
}

/** 自分の傘の下にある店舗(=配下+自分に「院長/店長」がいる店舗) */
export function managedStores(me = null) {
  const viewer = me || store.me();
  if (!viewer) return [];
  if (rankOf(viewer) === "hr") return store.get("stores").map((s) => s.id); // 勤怠管理のため全店
  const ids = new Set([viewer.id, ...subtreeIds(viewer.id)]);
  const out = new Set();
  for (const s of store.get("staff")) {
    if (ids.has(s.id) && ["院長", "店長"].includes(s.role)) out.add(s.storeId);
  }
  // 自分が院長/店長でなくても、配下スタッフの所属店舗は実質管轄
  if (rankLevel(viewer) >= 3) {
    for (const s of store.get("staff")) if (ids.has(s.id)) out.add(s.storeId);
  }
  return [...out];
}

/** 互換API:旧「担当エリア店舗」。ツリーから導出する */
export function areaStores(me) {
  const stores = managedStores(me);
  return stores.length ? stores : [me?.storeId].filter(Boolean);
}

/* ---------------- 権限定義 ---------------- */

const RULES = {
  /* --- 顧客・カルテ --- */
  "patients.view": (me) => isClockedInToday(me.id) || rankLevel(me) >= 3,
  "patients.viewWithoutClockIn": (me) => rankLevel(me) >= 3,
  "patients.edit": (me) => rankOf(me) !== "hr" && (isClockedInToday(me.id) || rankLevel(me) >= 3),

  /* --- 日報 --- */
  "nippo.submit": (me) => !["hr", "clerk"].includes(rankOf(me)),
  "nippo.view": (me) => !["hr", "clerk"].includes(rankOf(me)), // 人事・事務は日報を見ない
  "nippo.viewAll": (me) => rankLevel(me) >= 6 && rankOf(me) !== "hr",
  "nippo.summarize": (me) => rankLevel(me) >= 2 && rankOf(me) !== "hr",

  /* --- シフト --- */
  "shift.view": () => true, // 全社員が全店舗を閲覧できる
  "shift.edit": (me, ctx) => {
    if (rankOf(me) === "hr") return false;
    if (rankLevel(me) < 3) return false;
    if (rankOf(me) === "ceo") return true;
    return !!ctx?.storeId && managedStores(me).includes(ctx.storeId);
  },
  "shift.generateAI": (me, ctx) => RULES["shift.edit"](me, ctx),
  // 必要人数ルール・充足判定・他スタッフの希望休提出状況は責任者(院長以上)と本部人事のみ
  "shift.viewStaffing": (me) => rankLevel(me) >= 3 || rankOf(me) === "hr",

  /* --- 勤怠 --- */
  "kintai.punch": (me) => rankOf(me) !== "hr",
  "kintai.approve": (me, ctx) => {
    if (rankOf(me) === "hr" || rankOf(me) === "ceo") return true;
    if (rankLevel(me) < 3) return false;
    return !ctx?.storeId || managedStores(me).includes(ctx.storeId);
  },

  /* --- 人事管理ページ --- */
  "hr.view": (me) => rankOf(me) === "hr" || rankLevel(me) >= 6,

  /* --- 給与確認(事務職員向け):勤怠・経費・交通費・発注の最終確認とCSV出力 --- */
  "payroll.view": (me) => ["clerk", "hr"].includes(rankOf(me)) || rankLevel(me) >= 6,

  /* --- 組織図 --- */
  "org.view": () => true,
  // 管轄の付け替え(ドラッグ)は 統括マネージャー以上+本部人事
  "org.edit": (me) => rankLevel(me) >= 6 || rankOf(me) === "hr",

  /* --- 売上・経営数値:全員閲覧可 --- */
  "sales.view": () => true,

  /* --- スタッフ育成 --- */
  "staff.manageTests": (me) => rankLevel(me) >= 3 && rankOf(me) !== "hr",
  "staff.viewEvaluations": (me) => rankLevel(me) >= 3 && rankOf(me) !== "hr",
  "staff.viewInterviews": (me) => rankLevel(me) >= 2 && rankOf(me) !== "hr",
  "roleplay.review": (me) => rankLevel(me) >= 2 && rankOf(me) !== "hr",
  // テスト点数・スキルスコア・評価は「自分/配下/メンティー」のみ(一般社員は他人の点数を見られない)
  "staff.viewScores": (me, ctx) =>
    ctx?.staffId ? canSeeStaff(ctx.staffId, me) : rankLevel(me) >= 3,

  /* --- バックオフィス --- */
  "backoffice.approve": (me) => rankLevel(me) >= 3,
  // 在庫の発注・入荷は院長以上のみ(一般社員は閲覧のみ)
  "inventory.order": (me) => rankLevel(me) >= 3 && rankOf(me) !== "hr",

  /* --- 会議 --- */
  "meetings.edit": (me) => rankLevel(me) >= 3,
};

export function can(permission, ctx = {}, user = null) {
  const me = user || store.me();
  if (!me) return false;
  const rule = RULES[permission];
  if (!rule) {
    console.warn(`[auth] 未定義の権限: ${permission}`);
    return false;
  }
  return !!rule(me, ctx);
}

/* ---------------- 出勤判定 ---------------- */

export function isClockedInToday(staffId) {
  const t = todayStr();
  return store.get("attendance").some((a) => a.staffId === staffId && a.date === t && !!a.clockIn);
}

/* ---------------- 可視範囲(傘+メンター) ---------------- */

/**
 * この人の情報(日報など)を見られるか。
 * 自分 / 組織図の配下 / 担当メンティー。人事は勤怠管理のため全員
 * (ただし日報そのものは nippo.view=false で遮断される)。
 */
export function canSeeStaff(targetStaffId, me = null) {
  const viewer = me || store.me();
  if (!viewer) return false;
  if (viewer.id === targetStaffId) return true;
  if (rankOf(viewer) === "hr") return true;
  if ((viewer.menteeIds || []).includes(targetStaffId)) return true;
  return isDescendant(targetStaffId, viewer.id);
}

/** 閲覧できるスタッフ一覧(自分を含む) */
export function visibleStaff(me = null) {
  const viewer = me || store.me();
  if (!viewer) return [];
  return store.get("staff").filter((s) => canSeeStaff(s.id, viewer));
}

/** 閲覧範囲の説明文(UI表示用) */
export function scopeLabel(me = null) {
  const viewer = me || store.me();
  if (!viewer) return "";
  if (rankOf(viewer) === "hr") return "全店舗の勤怠・シフト(日報は対象外)";
  if (rankOf(viewer) === "clerk") return "給与関連の最終確認(勤怠・経費・交通費・発注)";
  const sub = subtreeIds(viewer.id).length;
  const mentees = (viewer.menteeIds || []).length;
  if (rankOf(viewer) === "ceo") return "全社(社長)";
  if (sub === 0 && mentees === 0) return "自分の記録のみ";
  const stores = managedStores(viewer).length;
  const parts = [`配下 ${sub}名`];
  if (stores) parts.push(`${stores}店舗`);
  if (mentees) parts.push(`メンティー ${mentees}名`);
  return `${parts.join("・")}(${rankLabel(viewer)})`;
}

/** その人がなぜ見えるのかの理由ラベル */
export function visibilityReason(targetStaffId, me = null) {
  const viewer = me || store.me();
  if (!viewer) return "";
  if (viewer.id === targetStaffId) return "自分";
  if ((viewer.menteeIds || []).includes(targetStaffId)) return "メンティー";
  const target = store.byId("staff", targetStaffId);
  if (!target) return "";
  if (target.reportsTo === viewer.id) return "直属";
  if (isDescendant(targetStaffId, viewer.id)) return rankOf(viewer) === "ceo" ? "全社" : "配下";
  if (rankOf(viewer) === "hr") return "人事(勤怠)";
  return "";
}

/** 自分のメンター(いれば) */
export function myMentor(me = null) {
  const viewer = me || store.me();
  return viewer?.mentorId ? store.byId("staff", viewer.mentorId) : null;
}

/** 自分のメンティー一覧 */
export function myMentees(me = null) {
  const viewer = me || store.me();
  return (viewer?.menteeIds || []).map((id) => store.byId("staff", id)).filter(Boolean);
}

/* ---------------- ナビゲーション表示制御 ---------------- */

const PAGE_GUARDS = {
  hr: "hr.view",
  nippo: "nippo.view",
  payroll: "payroll.view",
  orgimport: "org.edit",
};

export function canSeePage(pageId, me = null) {
  const perm = PAGE_GUARDS[pageId];
  return perm ? can(perm, {}, me) : true;
}
