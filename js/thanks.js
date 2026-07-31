/* ============================================================
   サンクスギフト 共通ロジック
   ポイント経済・統計・バッジ判定を1箇所に集約し、
   サンクスページとごほうび交換ページの両方から使う。
   ============================================================ */

import { store, todayStr, monthOf, addDays, mondayOf } from "./store.js";

/** 月に送れるポイント(毎月リセット) */
export const MONTHLY_BUDGET = 200;
/** 1枚あたりの選択肢 */
export const POINT_OPTIONS = [10, 20, 30, 50];
/** 上長が追加で贈れるブーストポイント */
export const BOOST_OPTIONS = [20, 50];

export const REACTIONS = ["👏", "🙌", "❤️", "🎉", "🥹", "💪"];

/* ---------------- 取得ヘルパー ---------------- */

export function allCards() {
  return store.get("thanksCards") || [];
}

/** 新しい順(ピン留めを先頭に) */
export function sortedCards(list = null) {
  return [...(list || allCards())].sort(
    (a, b) => (b.pinned === true) - (a.pinned === true) || (a.date < b.date ? 1 : -1));
}

export function valueOf(valueId) {
  return (store.get("thanksValues") || []).find((v) => v.id === valueId) || null;
}

export function designOf(designId) {
  const list = store.get("cardDesigns") || [];
  return list.find((d) => d.id === designId) || list[0] || null;
}

/** カードが staffId に関係するか(送り主 or 宛先) */
export function involves(card, staffId) {
  return card.fromId === staffId || (card.toIds || []).includes(staffId);
}

/** そのカードで実際に動いたポイント総量(宛先人数 × ポイント + ブースト) */
export function cardTotalPoints(card) {
  const base = (card.points || 0) * ((card.toIds || []).length || 1);
  const boost = (card.boosts || []).reduce((a, b) => a + (b.points || 0), 0);
  return base + boost;
}

/** 受け取り側 1人あたりのポイント(ブーストは均等配分) */
export function pointsPerRecipient(card) {
  const n = (card.toIds || []).length || 1;
  const boost = (card.boosts || []).reduce((a, b) => a + (b.points || 0), 0);
  return (card.points || 0) + Math.round(boost / n);
}

/* ---------------- ポイント ---------------- */

/** 今月すでに送ったポイント(宛先人数分を消費する) */
export function sentThisMonth(staffId = null) {
  const id = staffId || store.me().id;
  const m = monthOf(todayStr());
  return allCards()
    .filter((c) => c.fromId === id && (c.date || "").startsWith(m))
    .reduce((a, c) => a + (c.points || 0) * ((c.toIds || []).length || 1), 0);
}

/** 今月の残ポイント */
export function remainingPoints(staffId = null) {
  return Math.max(0, MONTHLY_BUDGET - sentThisMonth(staffId));
}

/** 累計獲得ポイント(受け取ったカードの合計) */
export function earnedPoints(staffId) {
  return allCards()
    .filter((c) => (c.toIds || []).includes(staffId))
    .reduce((a, c) => a + pointsPerRecipient(c), 0);
}

/** 交換で使ったポイント */
export function spentPoints(staffId) {
  return (store.get("giftRedemptions") || [])
    .filter((r) => r.staffId === staffId && r.status !== "cancelled")
    .reduce((a, r) => a + (r.cost || 0), 0);
}

/** 交換に使える残高 */
export function balance(staffId) {
  return Math.max(0, earnedPoints(staffId) - spentPoints(staffId));
}

/* ---------------- 統計 ---------------- */

export function statsOf(staffId) {
  const cards = allCards();
  const sent = cards.filter((c) => c.fromId === staffId);
  const received = cards.filter((c) => (c.toIds || []).includes(staffId));
  const withMedia = sent.filter((c) => (c.media || []).length > 0);
  const valuesCovered = new Set(sent.map((c) => c.valueId).filter(Boolean)).size;
  const storesReached = new Set(
    sent.flatMap((c) => (c.toIds || []).map((id) => store.byId("staff", id)?.storeId)).filter(Boolean)
  ).size;
  const reactionsGiven = cards.reduce(
    (a, c) => a + Object.values(c.reactions || {}).filter((arr) => arr.includes(staffId)).length, 0);
  return {
    sent: sent.length,
    received: received.length,
    withMedia: withMedia.length,
    valuesCovered,
    storesReached,
    reactionsGiven,
    weekStreak: weekStreak(staffId),
    earned: earnedPoints(staffId),
    balance: balance(staffId),
  };
}

/** 何週連続でカードを送っているか(今週または先週起点) */
export function weekStreak(staffId) {
  const sent = allCards().filter((c) => c.fromId === staffId).map((c) => (c.date || "").slice(0, 10));
  if (!sent.length) return 0;
  const weeks = new Set(sent.map((d) => mondayOf(d)));
  let streak = 0;
  let cursor = mondayOf(todayStr());
  if (!weeks.has(cursor)) cursor = addDays(cursor, -7); // 今週未送信なら先週から数える
  while (weeks.has(cursor)) { streak++; cursor = addDays(cursor, -7); }
  return streak;
}

/** バッジの獲得状況(達成済み/進捗) */
export function badgeProgress(staffId) {
  const st = statsOf(staffId);
  return (store.get("badges") || []).map((b) => {
    const current = st[b.metric] ?? 0;
    return {
      ...b,
      current,
      earned: current >= b.threshold,
      pct: Math.min(100, Math.round((current / b.threshold) * 100)),
    };
  });
}

/** 期間内のランキング(受け取りポイント順) */
export function ranking({ month = null, storeId = null, limit = 10 } = {}) {
  const m = month || monthOf(todayStr());
  const cards = allCards().filter((c) => (c.date || "").startsWith(m));
  const map = new Map();
  for (const c of cards) {
    const per = pointsPerRecipient(c);
    for (const to of c.toIds || []) {
      const s = store.byId("staff", to);
      if (!s) continue;
      if (storeId && s.storeId !== storeId) continue;
      const cur = map.get(to) || { staffId: to, points: 0, count: 0 };
      cur.points += per; cur.count += 1;
      map.set(to, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.points - a.points || b.count - a.count).slice(0, limit);
}

/** 送った枚数のランキング(与える文化を称える) */
export function giverRanking({ month = null, limit = 10 } = {}) {
  const m = month || monthOf(todayStr());
  const map = new Map();
  for (const c of allCards().filter((x) => (x.date || "").startsWith(m))) {
    const cur = map.get(c.fromId) || { staffId: c.fromId, count: 0, points: 0 };
    cur.count += 1;
    cur.points += (c.points || 0) * ((c.toIds || []).length || 1);
    map.set(c.fromId, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.points - a.points).slice(0, limit);
}

/** バリュー別の集計(何が称えられている会社か) */
export function valueBreakdown(month = null) {
  const m = month || monthOf(todayStr());
  const cards = allCards().filter((c) => (c.date || "").startsWith(m));
  return (store.get("thanksValues") || []).map((v) => ({
    ...v,
    count: cards.filter((c) => c.valueId === v.id).length,
  }));
}

/** 店舗間の送り合い(誰と誰がつながっているか) */
export function storeMatrix(month = null) {
  const m = month || monthOf(todayStr());
  const stores = store.get("stores");
  const idx = new Map(stores.map((s, i) => [s.id, i]));
  const mat = stores.map(() => stores.map(() => 0));
  for (const c of allCards().filter((x) => (x.date || "").startsWith(m))) {
    const from = store.byId("staff", c.fromId)?.storeId;
    if (from == null || !idx.has(from)) continue;
    for (const to of c.toIds || []) {
      const ts = store.byId("staff", to)?.storeId;
      if (ts == null || !idx.has(ts)) continue;
      mat[idx.get(from)][idx.get(ts)] += 1;
    }
  }
  return { stores, mat };
}

/** まだ今月カードを受け取っていない人(見落とされている仲間) */
export function notYetThanked(month = null) {
  const m = month || monthOf(todayStr());
  const got = new Set(
    allCards().filter((c) => (c.date || "").startsWith(m)).flatMap((c) => c.toIds || []));
  return store.get("staff").filter((s) => !got.has(s.id));
}

/* ---------------- 送信 ---------------- */

export function nowIso() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${todayStr()}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/**
 * サンクスカードを送る。成功したらカードを返し、失敗理由があれば {error} を返す。
 */
export function sendCard({ toIds, points, valueId, designId, message, media = [], visibility = "all" }) {
  const me = store.me();
  const cost = (points || 0) * (toIds?.length || 0);
  if (!toIds?.length) return { error: "宛先を選んでください" };
  if (!message?.trim()) return { error: "メッセージを入力してください" };
  if (!valueId) return { error: "どのバリューへの感謝かを選んでください" };
  if (cost > remainingPoints()) return { error: `今月の残りポイントが足りません(必要 ${cost}pt / 残り ${remainingPoints()}pt)` };

  const card = store.addFirst("thanksCards", {
    fromId: me.id, toIds: [...toIds], points, valueId, designId,
    date: nowIso(), message: message.trim(), media,
    reactions: {}, comments: [], boosts: [], pinned: false, visibility,
  });
  // 受け取り側の表示用ポイントも更新(スタッフの points はサンクス累計)
  for (const to of toIds) {
    store.update("staff", to, (s) => ({ points: (s.points || 0) + points }));
  }
  return { card };
}

/** 上長からのブースト(追加ポイント) */
export function boostCard(cardId, points, comment = "") {
  const card = store.byId("thanksCards", cardId);
  if (!card) return;
  store.update("thanksCards", cardId, (c) => ({
    boosts: [...(c.boosts || []), { by: store.me().id, points, comment, date: nowIso() }],
  }));
  const per = Math.round(points / ((card.toIds || []).length || 1));
  for (const to of card.toIds || []) {
    store.update("staff", to, (s) => ({ points: (s.points || 0) + per }));
  }
}

/** リアクションのトグル */
export function toggleReaction(cardId, emoji) {
  const meId = store.me().id;
  store.update("thanksCards", cardId, (c) => {
    const r = { ...(c.reactions || {}) };
    const arr = new Set(r[emoji] || []);
    arr.has(meId) ? arr.delete(meId) : arr.add(meId);
    if (arr.size) r[emoji] = [...arr]; else delete r[emoji];
    return { reactions: r };
  });
}

export function addComment(cardId, body) {
  if (!body?.trim()) return;
  store.update("thanksCards", cardId, (c) => ({
    comments: [...(c.comments || []), { id: store.uid("tcm"), authorId: store.me().id, body: body.trim(), date: nowIso() }],
  }));
}

/* ---------------- ごほうび交換 ---------------- */

export function redeemGift(giftId) {
  const me = store.me();
  const gift = store.byId("giftCatalog", giftId);
  if (!gift) return { error: "景品が見つかりません" };
  if (gift.stock <= 0) return { error: "この景品は在庫切れです" };
  if (balance(me.id) < gift.cost) return { error: `ポイントが足りません(必要 ${gift.cost}pt / 残高 ${balance(me.id)}pt)` };
  const code = `KM-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
  const rec = store.addFirst("giftRedemptions", {
    staffId: me.id, giftId, cost: gift.cost, date: todayStr(), status: "processing", code,
  });
  store.update("giftCatalog", giftId, (g) => ({ stock: Math.max(0, (g.stock || 0) - 1) }));
  return { redemption: rec, gift };
}

export function myRedemptions(staffId = null) {
  const id = staffId || store.me().id;
  return (store.get("giftRedemptions") || [])
    .filter((r) => r.staffId === id)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/* ---------------- 文面のヒント ---------------- */

/** 宛先とバリューから、書き出しのテンプレートを提案する */
export function messageHints(toStaff, value) {
  const name = toStaff?.name?.split(" ")[0] || "";
  const base = {
    v1: [`${name}さんの患者様への声かけを見て、`, "患者様が笑顔で帰られたのは", "「痛みの先」を見た対応で"],
    v2: [`${name}さん、あの時の一言に救われました。`, "忙しい中でも気にかけてくださって", "何気ない気遣いが"],
    v3: ["数字と誠実に向き合う姿勢が", "ごまかさずに報告してくれたおかげで", "振り返りが丁寧で"],
    v4: ["教えていただいた技術で", "共有してくれた知識が", "学び続ける姿に刺激をもらって"],
    v5: ["院のために動いてくれて", "地域の方に選ばれる理由は", "みんなが働きやすい環境を"],
  };
  return base[value?.id] || base.v2;
}
