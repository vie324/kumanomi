/* ============================================================
   KUMANOMI Store — アプリ全体のデータ入口

   構成は「案B:ローカルキャッシュ + 背面同期」。
   画面はこのファイルだけを見ていればよく、localStorage も
   Supabase も直接は触らない。差し替えるのはここの中身だけ。

   ┌ 画面 ─────────────────────────────┐
   │  await store.load("attendance")   ← 非同期の入口(1本)   │
   │  store.get("attendance")          ← キャッシュ読み(同期) │
   │  store.update(...)                ← 即座に反映 + 送信予約 │
   └───────────────────────────────────┘
            ↓ キャッシュ(メモリ)+ localStorage
            ↓ js/sync.js が裏でサーバーと往復

   ◎ あとから案A(全面非同期)へ移すとき
     画面は 1 行も変えなくてよい。store.load() の中身を
     「キャッシュがあれば即返す」から「毎回サーバーから取る」に
     変え、js/sync.js を外すだけで案Aになる。
     そのために、画面から同期的に取れるのは load() 済みの
     コレクションだけ、という約束を守ること。
   ============================================================ */

import { createSeed, SCHEMA_VERSION, todayStr, addDays, monthOf, dow, mondayOf, SHIFT_TYPES, LEAVE_TYPES, bedsOf } from "./data.js";
import { sync } from "./sync.js";
import { supabase } from "./supabase.js";

const LS_KEY = "kumanomi.state.v1";

/**
 * いまどちらの中身を持つべきか。
 *   demo … 接続先が未設定。作り込んだデモデータで動かす
 *   live … Supabase につながっている。記録は空から始める
 * 接続した瞬間に架空の患者や日報が残っていると実データと紛らわしいので、
 * モードが変わったら端末内を作り直す。
 */
function seedMode() {
  return supabase.isConfigured() ? "live" : "demo";
}

function load() {
  const mode = seedMode();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const sameShape = parsed.schemaVersion === SCHEMA_VERSION && (parsed.seedMode || "demo") === mode;
      // 本番は毎日作り直す必要がない(サーバーが正)。デモだけ日付で作り直して新鮮に保つ
      const fresh = mode === "live" ? true : parsed.generatedAt === todayStr();
      if (sameShape && fresh) return parsed;
    }
  } catch (e) { /* 壊れていたら作り直す */ }
  const seed = createSeed({ demo: mode === "demo" });
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

/* ---------------- 非同期の入口 ----------------
   案B では端末内のキャッシュがそのまま答えなので、
   load() は初回だけサーバーを待ち、以降は即座に解決する。 */

/** このセッションで一度でもサーバーから取り込んだコレクション */
const pulledOnce = new Set();
/** 取り込み中の約束(同じコレクションを二重に取りに行かないため) */
const inflight = new Map();

/** サーバーから届いた行をキャッシュへ流し込む */
function applyRemote(coll, rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  state[coll] = rows;

  // まだ送れていない自分の変更は、取り込みで消えないよう載せ直す
  for (const op of sync.pendingFor(coll)) {
    const i = state[coll].findIndex((x) => x.id === op.id);
    if (op.type === "insert" && i < 0) state[coll].push(op.data);
    else if (op.type === "update" && i >= 0) Object.assign(state[coll][i], op.data);
    else if (op.type === "delete" && i >= 0) state[coll].splice(i, 1);
  }

  // デモは s01 が居なくなったら先頭の人に寄せる。
  // 本番で勝手に選ぶと一瞬だけ別人として表示されるので、
  // ログイン処理(login.js)が決めるまで空のままにしておく。
  if (coll === "staff" && seedMode() === "demo"
      && !state.staff.some((x) => x.id === state.currentUserId)) {
    state.currentUserId = state.staff[0]?.id || state.currentUserId;
  }

  persist();
  listeners.forEach((fn) => fn(coll));
}

sync.attach(applyRemote);

/**
 * 画面が必要とするコレクションをそろえる。
 * 案B:キャッシュがあるので実質待ち時間ゼロ(初回のみサーバーを待つ)。
 * 案A:ここが毎回サーバー取得になる。呼び出し側は変えなくてよい。
 */
async function loadColls(...colls) {
  const list = colls.flat().filter(Boolean);
  const waits = [];
  for (const coll of list) {
    if (!sync.isRemote(coll)) continue;           // まだ端末内だけのコレクション
    if (pulledOnce.has(coll)) { sync.refresh(coll); continue; } // 2回目以降は裏で更新
    if (!inflight.has(coll)) {
      inflight.set(coll, sync.pull(coll).finally(() => {
        pulledOnce.add(coll);
        inflight.delete(coll);
      }));
    }
    waits.push(inflight.get(coll));
  }
  if (waits.length) await Promise.all(waits);
}

export const store = {
  get state() { return state; },

  /* ---- 非同期の入口(画面はまずこれを await する) ---- */

  /** 必要なコレクションをそろえる。await してから get() を使う */
  load(...colls) { return loadColls(...colls); },

  /** 初期化の完了。起動時に一度だけ待てばよい */
  ready() { return Promise.resolve(); },

  /** サーバーから取り直す(引っぱって更新するUI用) */
  refresh(...colls) {
    const list = colls.flat().filter(Boolean);
    const targets = list.length ? list : [...pulledOnce];
    return Promise.all(targets.map((c) => sync.pull(c)));
  },

  /* ---- 同期の状態(ヘッダー表示用) ---- */

  syncState() { return sync.state(); },
  onSync(fn) { return sync.subscribe(fn); },
  /** 送れなかった変更(権限エラーなど)。ユーザーに知らせる */
  syncRejected() { return sync.rejected(); },
  clearSyncRejected() { sync.clearRejected(); },
  flushSync() { return sync.flush(); },

  /* ---- 読み取り(load 済みのキャッシュから同期で返す) ---- */

  /** コレクション(配列)を取得 */
  get(coll) { return state[coll]; },

  /** ID で 1 件取得 */
  byId(coll, id) { return (state[coll] || []).find((x) => x.id === id) || null; },

  /* ---- 書き込み(端末に即反映 → 裏で送信) ---- */

  /** 追加(id が無ければ自動採番)。追加したオブジェクトを返す */
  add(coll, obj) {
    if (!obj.id) obj.id = store.uid(coll.slice(0, 2));
    state[coll].push(obj);
    persist();
    sync.enqueue({ type: "insert", coll, id: obj.id, data: obj });
    store.notify(coll);
    return obj;
  },

  /** 先頭に追加(タイムライン系) */
  addFirst(coll, obj) {
    if (!obj.id) obj.id = store.uid(coll.slice(0, 2));
    state[coll].unshift(obj);
    persist();
    sync.enqueue({ type: "insert", coll, id: obj.id, data: obj });
    store.notify(coll);
    return obj;
  },

  /** 部分更新。更新後のオブジェクトを返す */
  update(coll, id, patch) {
    const item = store.byId(coll, id);
    if (item) {
      const resolved = typeof patch === "function" ? patch(item) : patch;
      Object.assign(item, resolved);
      persist();
      // 変えた項目だけを送る(同じレコードを別の人が別項目で直しても衝突しない)
      sync.enqueue({ type: "update", coll, id, data: { ...resolved } });
      store.notify(coll);
    }
    return item;
  },

  remove(coll, id) {
    const arr = state[coll];
    const i = arr.findIndex((x) => x.id === id);
    if (i >= 0) {
      arr.splice(i, 1);
      persist();
      sync.enqueue({ type: "delete", coll, id });
      store.notify(coll);
    }
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

  /** 端末内のデータを初期状態に戻す(デモ=作り直し / 本番=空にして取り込み直し) */
  reset() {
    localStorage.removeItem(LS_KEY);
    sync.clearQueue();
    sync.clearRejected();
    pulledOnce.clear();
    state = load();
    listeners.forEach((fn) => fn("*"));
  },

  // ---- 便利アクセサ ----
  me() { return state.currentUserId ? store.byId("staff", state.currentUserId) : null; },
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
export { todayStr, addDays, monthOf, dow, mondayOf, SHIFT_TYPES, LEAVE_TYPES, bedsOf };
