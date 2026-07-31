/* ============================================================
   KUMANOMI Store — アプリ全体の状態管理
   シードデータ + localStorage 永続化 + 変更通知(pub/sub)
   ============================================================ */

import { createSeed, SCHEMA_VERSION, todayStr, addDays, monthOf, dow, mondayOf, SHIFT_TYPES } from "./data.js";

const LS_KEY = "kumanomi.state.v1";

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // スキーマが変わった/日付が変わった場合は作り直す(デモを常に新鮮に保つ)
      if (parsed.schemaVersion === SCHEMA_VERSION && parsed.generatedAt === todayStr()) {
        return parsed;
      }
    }
  } catch (e) { /* 壊れていたら作り直す */ }
  const seed = createSeed();
  try { localStorage.setItem(LS_KEY, JSON.stringify(seed)); } catch (e) { /* private mode */ }
  return seed;
}

let state = load();
const listeners = new Set();
let saveTimer = null;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* noop */ }
  }, 150);
}

let uidCounter = 1000;

export const store = {
  get state() { return state; },

  /** コレクション(配列)を取得 */
  get(coll) { return state[coll]; },

  /** ID で 1 件取得 */
  byId(coll, id) { return (state[coll] || []).find((x) => x.id === id) || null; },

  /** 追加(id が無ければ自動採番)。追加したオブジェクトを返す */
  add(coll, obj) {
    if (!obj.id) obj.id = store.uid(coll.slice(0, 2));
    state[coll].push(obj);
    persist();
    store.notify(coll);
    return obj;
  },

  /** 先頭に追加(タイムライン系) */
  addFirst(coll, obj) {
    if (!obj.id) obj.id = store.uid(coll.slice(0, 2));
    state[coll].unshift(obj);
    persist();
    store.notify(coll);
    return obj;
  },

  /** 部分更新。更新後のオブジェクトを返す */
  update(coll, id, patch) {
    const item = store.byId(coll, id);
    if (item) {
      Object.assign(item, typeof patch === "function" ? patch(item) : patch);
      persist();
      store.notify(coll);
    }
    return item;
  },

  remove(coll, id) {
    const arr = state[coll];
    const i = arr.findIndex((x) => x.id === id);
    if (i >= 0) { arr.splice(i, 1); persist(); store.notify(coll); }
  },

  /** スカラー設定値 */
  setSetting(key, value) {
    state.settings[key] = value;
    persist();
    store.notify("settings");
  },

  uid(prefix = "id") { return `${prefix}-${Date.now().toString(36)}-${(uidCounter++).toString(36)}`; },

  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  notify(coll) { listeners.forEach((fn) => fn(coll)); },

  /** デモデータを初期状態に戻す */
  reset() {
    localStorage.removeItem(LS_KEY);
    state = load();
    listeners.forEach((fn) => fn("*"));
  },

  // ---- 便利アクセサ ----
  me() { return store.byId("staff", state.currentUserId); },
  storeOf(staffOrPatient) { return store.byId("stores", staffOrPatient?.storeId); },
  storeName(storeId) { return store.byId("stores", storeId)?.name || "—"; },
  staffName(staffId) { return store.byId("staff", staffId)?.name || "—"; },
  patientName(patientId) { return store.byId("patients", patientId)?.name || "—"; },
  menuName(menuId) { return store.byId("menus", menuId)?.name || "—"; },

  /** 未読通知数 */
  unreadCount() { return state.notifications.filter((n) => !n.read).length; },

  /** ログインユーザーを切り替える(デモで権限の違いを体験するため) */
  switchUser(staffId) {
    if (!store.byId("staff", staffId)) return;
    state.currentUserId = staffId;
    persist();
    listeners.forEach((fn) => fn("*"));
  },

  /** 自分が参加しているチャットルーム */
  myRooms() {
    const meId = state.currentUserId;
    return (state.chatRooms || []).filter((r) => r.memberIds.includes(meId));
  },

  /** ルーム内の未読件数(自分の readBy に入っていない他人の発言) */
  unreadInRoom(roomId) {
    const meId = state.currentUserId;
    return (state.chatMessages || []).filter(
      (m) => m.roomId === roomId && m.authorId !== meId && !(m.readBy || []).includes(meId)
    ).length;
  },

  /** 全ルームの未読合計 */
  unreadChatCount() {
    return store.myRooms().reduce((a, r) => a + store.unreadInRoom(r.id), 0);
  },

  /** 自分宛メンションの未読件数 */
  unreadMentionCount() {
    const meId = state.currentUserId;
    const roomIds = new Set(store.myRooms().map((r) => r.id));
    return (state.chatMessages || []).filter(
      (m) => roomIds.has(m.roomId) && (m.mentions || []).includes(meId) && !(m.readBy || []).includes(meId)
    ).length;
  },
};

// 日付ユーティリティも re-export(ページから使いやすいように)
export { todayStr, addDays, monthOf, dow, mondayOf, SHIFT_TYPES };
