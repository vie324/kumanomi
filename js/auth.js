/* ============================================================
   くまのみポータル — 権限(RBAC)エンジン
   役職ランク + メンター関係 + 出勤状態 から「何が見えるか」を決める。
   すべてのページはここの can() / scope() を通して判定すること。
   ============================================================ */

import { store, todayStr } from "./store.js";

/* ---------------- 役職ランク ----------------
   数値が大きいほど広い権限。日本語の役職名(staff.role)とは別に
   staff.rank で権限を管理する。 */
export const RANKS = {
  staff: { level: 1, label: "スタッフ", desc: "自分の情報と担当患者様を扱えます" },
  mentor: { level: 2, label: "メンター", desc: "担当メンティーの日報も確認できます" },
  manager: { level: 3, label: "院長(店舗責任者)", desc: "自店舗のシフト編集・日報閲覧・勤怠承認ができます" },
  area: { level: 4, label: "マネージャー", desc: "担当エリアの複数店舗を統括します" },
  exec: { level: 5, label: "統括マネージャー", desc: "全店舗のすべての情報にアクセスできます" },
  hr: { level: 3, label: "本部人事", desc: "全店舗の勤怠・シフトを管理します(日報は対象外)" },
};

export function rankOf(staff) { return staff?.rank || "staff"; }
export function rankLabel(staff) { return RANKS[rankOf(staff)]?.label || "スタッフ"; }
export function rankLevel(staff) { return RANKS[rankOf(staff)]?.level ?? 1; }

/* ---------------- 権限定義 ----------------
   key: 権限名 / value: (me, ctx) => boolean
   ctx は権限ごとに必要なものだけ渡す。 */
const RULES = {
  /* --- 顧客・カルテ --- */
  // 顧客情報の閲覧。原則「出勤打刻をしてから」— 責任者以上は打刻なしでも可。
  "patients.view": (me) => isClockedInToday(me.id) || rankLevel(me) >= 3,
  // 打刻なしでも見られる例外権限を持っているか(ゲート画面の出し分け用)
  "patients.viewWithoutClockIn": (me) => rankLevel(me) >= 3,
  "patients.edit": (me) => rankOf(me) !== "hr" && (isClockedInToday(me.id) || rankLevel(me) >= 3),

  /* --- 日報 --- */
  "nippo.submit": (me) => rankOf(me) !== "hr",
  // 人事は日報を見ない(ご要望どおり)
  "nippo.view": (me) => rankOf(me) !== "hr",
  "nippo.viewAll": (me) => rankOf(me) === "exec",
  "nippo.summarize": (me) => rankLevel(me) >= 2 && rankOf(me) !== "hr",

  /* --- シフト --- */
  // 全社員が全店舗のシフトを閲覧できる
  "shift.view": () => true,
  // 編集は責任者(院長)以上
  "shift.edit": (me, ctx) => {
    if (rankOf(me) === "hr") return false;
    if (rankLevel(me) >= 5) return true;                       // 統括:全店
    if (rankOf(me) === "area") return inMyArea(me, ctx?.storeId); // エリア:担当店舗
    if (rankOf(me) === "manager") return ctx?.storeId === me.storeId; // 院長:自店舗
    return false;
  },
  "shift.generateAI": (me, ctx) => RULES["shift.edit"](me, ctx),

  /* --- 勤怠 --- */
  "kintai.punch": (me) => rankOf(me) !== "hr",
  "kintai.approve": (me, ctx) => {
    if (rankLevel(me) >= 5 || rankOf(me) === "hr") return true;
    if (rankOf(me) === "area") return inMyArea(me, ctx?.storeId);
    if (rankOf(me) === "manager") return ctx?.storeId === me.storeId;
    return false;
  },

  /* --- 人事管理ページ --- */
  "hr.view": (me) => rankOf(me) === "hr" || rankLevel(me) >= 5,

  /* --- 売上・経営数値:全員閲覧可(ご要望どおり) --- */
  "sales.view": () => true,

  /* --- スタッフ育成 --- */
  "staff.manageTests": (me) => rankLevel(me) >= 3 && rankOf(me) !== "hr",
  "staff.viewEvaluations": (me) => rankLevel(me) >= 3 && rankOf(me) !== "hr",
  "staff.viewInterviews": (me) => rankLevel(me) >= 2 && rankOf(me) !== "hr",
  "roleplay.review": (me) => rankLevel(me) >= 2 && rankOf(me) !== "hr",

  /* --- バックオフィス --- */
  "backoffice.approve": (me) => rankLevel(me) >= 3,

  /* --- 会議 --- */
  "meetings.edit": (me) => rankLevel(me) >= 3,
};

/**
 * 権限判定。 can("shift.edit", { storeId }) のように使う。
 * 第3引数で判定対象ユーザーを差し替え可能(既定はログイン中ユーザー)。
 */
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

/** 今日すでに出勤打刻をしているか */
export function isClockedInToday(staffId) {
  const t = todayStr();
  return store.get("attendance").some((a) => a.staffId === staffId && a.date === t && !!a.clockIn);
}

/* ---------------- 組織スコープ ---------------- */

/** エリアマネージャーの担当店舗一覧 */
export function areaStores(me) {
  return me?.areaStoreIds?.length ? me.areaStoreIds : [me?.storeId].filter(Boolean);
}

function inMyArea(me, storeId) {
  return !!storeId && areaStores(me).includes(storeId);
}

/**
 * 「この人は自分の配下か」— 日報の閲覧範囲判定に使う。
 * 統括 > エリア(担当店舗) > 院長(自店舗) > メンター(担当メンティー) > 本人
 */
export function canSeeStaff(targetStaffId, me = null) {
  const viewer = me || store.me();
  if (!viewer) return false;
  if (viewer.id === targetStaffId) return true;
  if (rankOf(viewer) === "hr") return true; // 勤怠管理のため全員を見るが、日報は nippo.view で別途遮断
  const target = store.byId("staff", targetStaffId);
  if (!target) return false;

  switch (rankOf(viewer)) {
    case "exec": return true;
    case "area": return areaStores(viewer).includes(target.storeId);
    case "manager": return target.storeId === viewer.storeId;
    case "mentor": return (viewer.menteeIds || []).includes(targetStaffId);
    default: return false;
  }
}

/**
 * 日報などで閲覧できるスタッフID一覧(自分を含む)。
 * 併せて「なぜ見えるか」のラベルも返す。
 */
export function visibleStaff(me = null) {
  const viewer = me || store.me();
  const all = store.get("staff");
  if (!viewer) return [];
  return all.filter((s) => canSeeStaff(s.id, viewer));
}

/** 閲覧範囲の説明文(UIに出す用) */
export function scopeLabel(me = null) {
  const viewer = me || store.me();
  switch (rankOf(viewer)) {
    case "exec": return "全店舗(統括権限)";
    case "area": return `担当エリア ${areaStores(viewer).map((id) => store.storeName(id)).join("・")}`;
    case "manager": return `${store.storeName(viewer.storeId)}(店舗責任者)`;
    case "mentor": return `自分 + メンティー ${(viewer.menteeIds || []).length}名`;
    case "hr": return "全店舗の勤怠・シフト(日報は対象外)";
    default: return "自分の記録のみ";
  }
}

/** その人がなぜ見えるのかの理由ラベル(日報一覧のバッジ用) */
export function visibilityReason(targetStaffId, me = null) {
  const viewer = me || store.me();
  if (viewer.id === targetStaffId) return "自分";
  if ((viewer.menteeIds || []).includes(targetStaffId)) return "メンティー";
  const target = store.byId("staff", targetStaffId);
  if (!target) return "";
  if (rankOf(viewer) === "manager" && target.storeId === viewer.storeId) return "自店舗";
  if (rankOf(viewer) === "area") return "担当エリア";
  if (rankOf(viewer) === "exec") return "全社";
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

/** ページIDごとの表示条件(未定義なら全員表示) */
const PAGE_GUARDS = {
  hr: "hr.view",
  nippo: "nippo.view",
};

export function canSeePage(pageId, me = null) {
  const perm = PAGE_GUARDS[pageId];
  return perm ? can(perm, {}, me) : true;
}
