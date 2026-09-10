/* ============================================================
   所属から自動で決まるチャットルーム(端末内=デモモード用)

   本番では Supabase 側のトリガ(0010 の app.sync_auto_rooms)が同じことをする。
   ここは接続先が無いデモモードで、同じ動きを端末内で再現するためのもの。

     ・全社ルーム(all)            … 在籍者全員がずっと入っている
     ・店舗ルーム(store:<店舗id>)  … その店舗が主所属 or 追加所属の人
     ・委員会ルーム(committee:<id>)… その委員会に任命された人

   メンバーを足す・異動する・委員会に任命すると、次の描画でルームの参加者が合う。
   成増店 → 浦和店に異動すれば、成増店のルームから外れて浦和店のルームに入る。
   ============================================================ */

import { store } from "./store.js";

const ROOM_ID = {
  all: () => "cr-all",
  store: (id) => `cr-store-${id}`,
  committee: (id) => `cr-committee-${id}`,
};

/** そのルームに居るべき人(在籍者のみ) */
export function autoRoomMembers(autoKey) {
  const staff = (store.get("staff") || []).filter((s) => s.isActive !== false);
  if (autoKey === "all") return staff.map((s) => s.id);
  if (autoKey.startsWith("store:")) {
    const sid = autoKey.slice(6);
    return staff.filter((s) => s.storeId === sid || (s.storeIds || []).includes(sid)).map((s) => s.id);
  }
  if (autoKey.startsWith("committee:")) {
    const cid = autoKey.slice(10);
    return staff.filter((s) => (s.committeeIds || []).includes(cid)).map((s) => s.id);
  }
  return [];
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** 全社・全店舗・全委員会のルームをそろえ、参加者を所属に合わせる。デモモードでだけ呼ぶ */
export function syncAutoRooms() {
  if ((store.state.seedMode || "demo") === "live") return { created: 0, updated: 0 };
  const rooms = store.get("chatRooms") || [];
  const me = store.me();
  let created = 0, updated = 0;

  const ensure = ({ autoKey, id, kind, name, icon, desc, storeId = null }) => {
    const members = autoRoomMembers(autoKey);
    const room = rooms.find((r) => r.autoKey === autoKey) || rooms.find((r) => r.id === id);
    if (!room) {
      store.add("chatRooms", {
        id, autoKey, kind, name, icon, desc, storeId,
        memberIds: members, announceOnly: false, pinnedMessageId: null, createdBy: me?.id || null,
      });
      created++;
      return;
    }
    const patch = {};
    if (!room.autoKey) patch.autoKey = autoKey;
    if (!sameSet(room.memberIds || [], members)) patch.memberIds = members;
    if (room.name !== name && room.autoKey !== autoKey) patch.name = name;
    if (Object.keys(patch).length) { store.update("chatRooms", room.id, patch); updated++; }
  };

  ensure({ autoKey: "all", id: ROOM_ID.all(), kind: "group", name: "全社アナウンス", icon: "📢", desc: "全社員向けの連絡(全員が参加)" });
  for (const st of (store.get("stores") || []).filter((s) => s.isActive !== false)) {
    ensure({ autoKey: `store:${st.id}`, id: ROOM_ID.store(st.id), kind: "store", name: st.name, icon: "🏠",
      desc: `${st.name}のスタッフルーム(所属から自動で更新)`, storeId: st.id });
  }
  for (const c of (store.get("committees") || []).filter((x) => x.isActive !== false)) {
    ensure({ autoKey: `committee:${c.id}`, id: ROOM_ID.committee(c.id), kind: "committee", name: c.name,
      icon: c.icon || "🗂", desc: c.desc || `${c.name}のルーム` });
  }
  return { created, updated };
}

/** 自動ルームか(参加者は所属から決まるので、手では変えられない) */
export const isAutoRoom = (room) => !!room?.autoKey;

/** 自動ルームの説明(チャット画面のヘッダーに出す) */
export function autoRoomHint(room) {
  if (!room?.autoKey) return "";
  if (room.autoKey === "all") return "在籍者全員が参加するルームです";
  if (room.autoKey.startsWith("store:")) return "この店舗に所属する人が自動で参加します。異動すると自動で入れ替わります";
  if (room.autoKey.startsWith("committee:")) return "この委員会に任命された人が自動で参加します";
  return "";
}
