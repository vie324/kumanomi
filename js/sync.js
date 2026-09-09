/* ============================================================
   背面同期エンジン(案B:ローカルキャッシュ + 裏での送受信)

   画面はここを直接は使わない。必ず store.js 経由で触る。
   役割は 3 つだけ:

     1. 送信キュー(アウトボックス)
        画面の操作はまず端末内に保存され、成功扱いで即座に反映される。
        実際のサーバー送信はここが順番に、失敗したら再送しながら行う。
        端末を閉じても localStorage に残るので、次に開いたとき続きから送る。

     2. 取得(プル)
        サーバーの最新をとってきてキャッシュに流し込む。

     3. 状態の通知
        「同期中」「未送信 N 件」「オフライン」をヘッダーに出すため。

   ◎ 競合の扱い
     更新は「変えた項目だけ」を PATCH で送る。
     同じ予約を 2 人が別の項目(時間 / メモ)で編集しても打ち消し合わない。
     同じ項目を同時に編集したときは後勝ち(last-write-wins)。

   ◎ 案A(全面非同期)へ移すとき
     このファイルは丸ごと不要になる。store.load() の中身を
     「キャッシュを返す」から「毎回 pull する」に変えるだけでよい。
   ============================================================ */

import { supabase } from "./supabase.js";
import { remoteOf, isRemote, remoteCollections } from "./remote.js";

const OUTBOX_KEY = "kumanomi.outbox.v1";
const REJECTED_KEY = "kumanomi.outbox.rejected.v1";
const MAX_ATTEMPTS = 3;        // これを超えたら再送をやめて記録に回す
const MAX_BACKOFF_MS = 60_000; // 再送間隔の上限
const POLL_MS = 90_000;        // 画面を開いている間の自動取り込み間隔

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* プライベートモード */ }
}

let queue = readJSON(OUTBOX_KEY, []);
let rejected = readJSON(REJECTED_KEY, []);
let applier = null;      // (coll, rows) => void  … 取得結果をキャッシュへ流す
let flushing = false;
let failures = 0;
let retryTimer = null;
let pollTimer = null;
let seq = 0;

const listeners = new Set();
const lastPull = new Map(); // coll -> 取得時刻(ms)

const status = {
  /** demo(未接続) / online / offline */
  mode: supabase.isConfigured() ? "online" : "demo",
  /** idle / syncing / error */
  state: "idle",
  pending: queue.length,
  rejected: rejected.length,
  lastSyncAt: null,
  error: null,
};

function emit() {
  status.pending = queue.length;
  status.rejected = rejected.length;
  const snapshot = { ...status };
  listeners.forEach((fn) => { try { fn(snapshot); } catch (e) { console.error(e); } });
}

function saveQueue() { writeJSON(OUTBOX_KEY, queue); }
function saveRejected() { writeJSON(REJECTED_KEY, rejected); }

/** いま送受信してよいか */
function canSync() {
  if (!supabase.isConfigured()) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  return true;
}

function refreshMode() {
  if (!supabase.isConfigured()) status.mode = "demo";
  else if (typeof navigator !== "undefined" && navigator.onLine === false) status.mode = "offline";
  else status.mode = "online";
}

/** ネットワーク起因(=再送する価値がある)エラーか */
function isNetworkError(err) {
  const m = String(err?.message || "");
  return m.includes("接続できません") || m.includes("Failed to fetch") || m.includes("NetworkError");
}

/* ---------------- 送信キュー ---------------- */

/**
 * 変更を送信キューに積む。サーバーに無いコレクションは何もしない。
 *   enqueue({ type:"update", coll:"stores", id:"st-omiya", data:{ phone:"…" } })
 */
function enqueue(op) {
  if (!isRemote(op.coll)) return null;        // PHASE 2 待ちのコレクションは端末内だけ
  if (!supabase.isConfigured()) return null;  // デモモードでは何も送らない

  const entry = { ...op, seq: ++seq, at: new Date().toISOString(), attempts: 0 };

  // 同じレコードへの連続した更新はまとめる(打鍵のたびに往復させない)
  const last = queue[queue.length - 1];
  if (
    entry.type === "update" && last?.type === "update" &&
    last.coll === entry.coll && last.id === entry.id && last.attempts === 0
  ) {
    last.data = { ...last.data, ...entry.data };
    last.at = entry.at;
  } else {
    queue.push(entry);
  }

  saveQueue();
  emit();
  scheduleFlush(0);
  return entry;
}

/** 1 件をサーバーへ反映する */
async function send(op) {
  const def = remoteOf(op.coll);
  if (!def) return;
  const where = { [def.key]: op.id };

  if (op.type === "insert") {
    // ビュー越しに書くコレクションは ON CONFLICT が使えない。
    // 代わりにビュー側のトリガが同じ id を上書きしてくれる。
    const useUpsert = def.upsert !== false;
    await supabase.insert(def.table, [def.toRemote(op.data)], {
      upsert: useUpsert,
      onConflict: useUpsert ? def.key : null,
    });
  } else if (op.type === "update") {
    // 変えた項目だけを送る(= 項目単位の後勝ち)。
    // toRemote は渡された項目しか書き出さないので、そのまま部分更新になる。
    const patch = def.toRemote(op.data);
    delete patch[def.key]; // キー列は動かさない
    if (Object.keys(patch).length) await supabase.update(def.table, patch, where);
  } else if (op.type === "delete") {
    if (def.softDelete) {
      // 店舗・メンバーは消さずに在籍フラグを落とす(履歴を守るため)
      await supabase.update(def.table, { [def.softDelete]: false }, where);
    } else {
      await supabase.remove(def.table, where);
    }
  }
}

function scheduleFlush(delay = 0) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { flush(); }, delay);
}

/** キューを先頭から順に送る */
async function flush() {
  refreshMode();
  if (flushing || !queue.length) { emit(); return; }
  if (!canSync()) { emit(); return; }

  flushing = true;
  status.state = "syncing";
  status.error = null;
  emit();

  try {
    while (queue.length) {
      const op = queue[0];
      try {
        await send(op);
        queue.shift();
        saveQueue();
        failures = 0;
        emit();
      } catch (err) {
        if (isNetworkError(err)) throw err; // 通信断:順番を崩さずまとめて再送
        op.attempts = (op.attempts || 0) + 1;
        if (op.attempts >= MAX_ATTEMPTS) {
          // 権限エラーや制約違反は何度送っても通らない。捨てずに記録して先へ進む
          queue.shift();
          rejected.unshift({ ...op, error: String(err?.message || err), failedAt: new Date().toISOString() });
          rejected = rejected.slice(0, 50);
          saveRejected();
          console.warn(`[sync] 送信できなかった変更を保留にしました(${op.coll}/${op.id}):`, err);
        }
        saveQueue();
        emit();
        if (op.attempts < MAX_ATTEMPTS) throw err; // 少し待ってから同じ件を再挑戦
      }
    }
    status.state = "idle";
    status.lastSyncAt = new Date().toISOString();
    failures = 0;
  } catch (err) {
    failures += 1;
    status.state = "error";
    status.error = String(err?.message || err);
    refreshMode();
    scheduleFlush(Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (failures - 1)));
  } finally {
    flushing = false;
    emit();
  }
}

/* ---------------- 取得 ---------------- */

/**
 * サーバーから 1 コレクションを取り込み、キャッシュへ流す。
 * 取り込めたら true、対象外・失敗なら false。
 */
async function pull(coll) {
  const def = remoteOf(coll);
  if (!def || !canSync()) return false;
  try {
    // 投稿(画像つき)やチャットのように増え続けるものは、新しい順に上限までを取る
    const rows = await supabase.select(def.view || def.table, { order: def.order || undefined, limit: def.limit || undefined });
    if (!Array.isArray(rows)) return false;
    applier?.(coll, rows.map((r) => def.toLocal(r)));
    lastPull.set(coll, Date.now());
    status.lastSyncAt = new Date().toISOString();
    if (status.state === "error") { status.state = "idle"; status.error = null; }
    emit();
    return true;
  } catch (err) {
    status.state = "error";
    status.error = String(err?.message || err);
    refreshMode();
    emit();
    console.warn(`[sync] ${coll} の取得に失敗しました:`, err);
    return false;
  }
}

/** 前回取得から maxAgeMs 以上たっていれば取り直す(裏側で走らせる用) */
function refresh(coll, maxAgeMs = 30_000) {
  if (!isRemote(coll) || !canSync()) return Promise.resolve(false);
  const last = lastPull.get(coll) || 0;
  if (Date.now() - last < maxAgeMs) return Promise.resolve(false);
  lastPull.set(coll, Date.now()); // 同時多重呼び出しの抑止
  return pull(coll);
}

/* ---------------- 起動と停止 ---------------- */

function startPolling() {
  clearInterval(pollTimer);
  if (!canSync()) return;
  pollTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    for (const coll of remoteCollections()) refresh(coll, POLL_MS);
  }, POLL_MS);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => { refreshMode(); failures = 0; scheduleFlush(0); emit(); });
  window.addEventListener("offline", () => { refreshMode(); emit(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleFlush(0); });
  supabase.subscribe(() => { refreshMode(); startPolling(); scheduleFlush(0); emit(); });
}

export const sync = {
  /** 取得結果をキャッシュへ流し込む関数を登録する(store.js が呼ぶ) */
  attach(fn) {
    applier = fn;
    refreshMode();
    startPolling();
    if (queue.length) scheduleFlush(500);
    emit();
  },

  state() { return { ...status }; },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  enqueue,
  pull,
  refresh,
  flush: () => flush(),
  isRemote,

  /** そのコレクションで未送信のまま残っている変更(取り込み後に上書きし直すため) */
  pendingFor(coll) { return queue.filter((op) => op.coll === coll); },

  /** 送れなかった変更の一覧(ユーザーに知らせるため) */
  rejected() { return [...rejected]; },
  clearRejected() { rejected = []; saveRejected(); emit(); },

  /** 端末に残った未送信をすべて捨てる(サポート操作) */
  clearQueue() { queue = []; saveQueue(); emit(); },
};
