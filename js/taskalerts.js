/* ============================================================
   タスク × チャットの連携

   ・振り分け  … チャットからタスクを振ると、そのルームに「タスクカード」が流れる
   ・アラート  … 期限当日・期限超過のタスクは、振った人の端末から相手へ
                 チャットでリマインドが飛ぶ(1日1回)
   ・完了      … 振られたタスクを完了にすると、振った人に完了の知らせが届く

   メッセージは attachment: { kind: "task", taskId } を持ち、
   チャット側でタスクの現在の状態(未着手/進行中/完了・進捗)を映して表示する。

   送り先のルームの決め方:
     1. タスクがチャット発(source.kind === "chat")なら、そのルーム
     2. それ以外は、2人のダイレクトメッセージ(無ければ作る)
   ============================================================ */

import { store, todayStr } from "./store.js";

function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${todayStr()}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const fmtMD = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "期限なし");

/** 2人のダイレクトメッセージ(無ければ作る)。id を決め打ちにして、どの端末から作っても同じ1部屋になる */
export function ensureDmRoom(aId, bId) {
  if (!aId || !bId || aId === bId) return null;
  const rooms = store.get("chatRooms") || [];
  const found = rooms.find((r) => r.kind === "dm" && r.memberIds.length === 2
    && r.memberIds.includes(aId) && r.memberIds.includes(bId));
  if (found) return found;
  const [x, y] = [aId, bId].sort();
  return store.add("chatRooms", {
    id: `cr-dm-${x}-${y}`,
    kind: "dm",
    name: null,
    icon: null,
    desc: "",
    memberIds: [aId, bId],
    announceOnly: false,
    pinnedMessageId: null,
    createdBy: aId,
  });
}

/** このタスクのやり取りを流すルーム(自分と相手の両方が入っている部屋) */
export function taskRoomFor(task, meId, otherId) {
  if (task?.source?.kind === "chat" && task.source.refId) {
    const room = store.byId("chatRooms", task.source.refId);
    if (room && room.memberIds.includes(meId) && (!otherId || room.memberIds.includes(otherId))) return room;
  }
  return ensureDmRoom(meId, otherId);
}

/** タスクカード付きのメッセージを送る */
export function postTaskMessage(room, { authorId, text, taskId, mentions = [], note = "" }) {
  if (!room) return null;
  return store.add("chatMessages", {
    roomId: room.id,
    authorId,
    date: nowIso(),
    text,
    mentions,
    reactions: {},
    readBy: [authorId],
    replyToId: null,
    attachment: { kind: "task", taskId, note },
    edited: false,
  });
}

/** 振り分けの知らせ(チャットからでもタスク画面からでも) */
export function notifyTaskAssigned(task, { by, room = null, note = "" } = {}) {
  const target = room || taskRoomFor(task, by, task.ownerId);
  if (!target || task.ownerId === by) return null;
  const owner = store.staffName(task.ownerId);
  return postTaskMessage(target, {
    authorId: by,
    text: `📋 @${owner} タスクをお願いします:「${task.title}」(期限 ${fmtMD(task.due)})${note ? `\n${note}` : ""}`,
    taskId: task.id,
    mentions: [task.ownerId],
  });
}

/** 期限のリマインド。1日1回まで(alertedAt で制御) */
export function sendTaskAlert(task, { by, force = false } = {}) {
  const today = todayStr();
  if (!task || task.status === "done") return null;
  if (!force && (task.alertedAt || "").startsWith(today)) return null;
  const target = taskRoomFor(task, by, task.ownerId);
  if (!target) return null;
  const owner = store.staffName(task.ownerId);
  const overdue = !!task.due && task.due < today;
  const text = overdue
    ? `⏰ @${owner} タスク「${task.title}」の期限(${fmtMD(task.due)})を過ぎています。進捗を更新するか、完了にしてください。`
    : `⏰ @${owner} タスク「${task.title}」は今日が期限です。`;
  const msg = postTaskMessage(target, { authorId: by, text, taskId: task.id, mentions: [task.ownerId] });
  store.update("tasks", task.id, { alertedAt: nowIso() });
  return msg;
}

/** 完了の知らせ(振った人へ) */
export function notifyTaskDone(task, { by } = {}) {
  const to = task.createdBy && task.createdBy !== by ? task.createdBy : null;
  if (!to) return null;
  const target = taskRoomFor(task, by, to);
  if (!target) return null;
  return postTaskMessage(target, {
    authorId: by,
    text: `✅ @${store.staffName(to)} タスク「${task.title}」を完了しました。`,
    taskId: task.id,
    mentions: [to],
  });
}

/** 進捗の知らせ(進行中の割合を振った人へ。完了は notifyTaskDone) */
export function notifyTaskProgress(task, { by } = {}) {
  const to = task.createdBy && task.createdBy !== by ? task.createdBy : null;
  if (!to) return null;
  const target = taskRoomFor(task, by, to);
  if (!target) return null;
  return postTaskMessage(target, {
    authorId: by,
    text: `🔄 タスク「${task.title}」の進捗を ${task.progress ?? 0}% に更新しました。`,
    taskId: task.id,
    mentions: [],
  });
}

/**
 * 自分が振ったタスクのうち、期限が今日か過ぎているものにリマインドを送る。
 * 自分の端末が「振った人」として送るので、相手の名前で書き込むことはない。
 * @returns {number} 送った件数
 */
export function syncTaskAlerts() {
  const me = store.me();
  if (!me) return 0;
  const today = todayStr();
  let n = 0;
  for (const t of store.get("tasks") || []) {
    if (t.createdBy !== me.id || t.ownerId === me.id) continue;
    if (t.status === "done" || !t.due || t.due > today) continue;
    if ((t.alertedAt || "").startsWith(today)) continue;
    if (sendTaskAlert(t, { by: me.id })) n++;
  }
  return n;
}
