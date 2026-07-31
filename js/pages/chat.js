/* ============================================================
   チャット — グループ / 店舗 / ダイレクト + メンション
   LINE のような使い心地の社内チャット。
   ・左=ルーム一覧 / 右=会話(モバイルは1カラム切替)
   ・@メンション(入力補助つき)/ リアクション / 返信 / 既読 / 添付
   ============================================================ */
import {
  el, clear, icon, avatar, badge, emptyState, modal, toast, relTime, staffChip,
} from "../ui.js";
import { store, todayStr, addDays } from "../store.js";

const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];
const REACTIONS = ["👍", "🙏", "🎉", "💡", "😊", "❤️"];
const QUICK_EMOJI = ["😊", "🙏", "👍", "🎉", "🙌", "💪", "✨", "🐠", "🌸", "😂", "🔥", "💡", "⏰", "✅", "📌", "🥲"];
const ROOM_EMOJI = ["💬", "📢", "🏠", "🧭", "✋", "🌱", "🎯", "📚", "🍀", "⚡"];
const DUMMY_FILES = [
  { kind: "image", name: "院内写真.jpg" },
  { kind: "file", name: "施術メニュー改定案.pdf" },
];
const MOBILE_Q = "(max-width: 860px)";
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** 下書きはページ再描画をまたいで保持する */
const drafts = new Map();

/* ---------------- 小さなヘルパー ---------------- */

function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${todayStr()}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function excerpt(s, n = 40) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function hhmm(iso) { return String(iso || "").slice(11, 16); }

function dateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const w = new Date(y, m - 1, d).getDay();
  const base = `${m}月${d}日(${DOW_JA[w]})`;
  if (dateStr === todayStr()) return `${base}・今日`;
  if (dateStr === addDays(todayStr(), -1)) return `${base}・昨日`;
  return base;
}

function isMobile() { return window.matchMedia(MOBILE_Q).matches; }

/* ============================================================
   ページ
   ============================================================ */
export default {
  id: "chat",
  title: "チャット",
  icon: "chat",

  render(root, params = []) {
    const meId = store.state.currentUserId;
    const me = store.me();

    /* ---------------- 状態 ---------------- */
    let activeRoomId = null;
    let roomQuery = "";
    let msgQuery = "";
    let searchOpen = false;
    let replyToId = null;
    let pendingAttachment = null;
    let unreadFromId = null;                 // 「ここから未読」の位置
    let mentionOpen = false, mentionIdx = 0, mentionCands = [];
    let popEl = null, popCloser = null;

    /* ---------------- データアクセス ---------------- */
    const myRooms = () => store.myRooms();
    const roomById = (id) => myRooms().find((r) => r.id === id) || null;

    const msgsOf = (roomId) => store.get("chatMessages")
      .filter((m) => m.roomId === roomId)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const lastMsgOf = (roomId) => { const a = msgsOf(roomId); return a[a.length - 1] || null; };

    /** 送信時刻。デモデータが現在時刻より先の場合でも必ず最下部に並ぶようにする */
    function nextMessageDate(roomId) {
      const now = nowIso();
      const last = lastMsgOf(roomId);
      if (!last || last.date <= now) return now;
      const d = new Date(last.date);
      d.setMinutes(d.getMinutes() + 1);
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    const otherOf = (room) => store.byId("staff", room.memberIds.find((id) => id !== meId) || room.memberIds[0]);

    const roomTitle = (room) => (room.kind === "dm" ? (otherOf(room)?.name || "ダイレクト") : room.name);

    const roomIconNode = (room, size = 40) => (room.kind === "dm"
      ? avatar(otherOf(room), size)
      : el("span", { class: "cr-emoji", style: { width: size + "px", height: size + "px", fontSize: Math.round(size * 0.46) + "px" } }, room.icon || "💬"));

    const mentionUnread = (roomId) => msgsOf(roomId).filter(
      (m) => m.authorId !== meId && (m.mentions || []).includes(meId) && !(m.readBy || []).includes(meId)).length;

    /* ---------------- 初期ルームの決定 ---------------- */
    const list = myRooms();
    if (params[0] && roomById(params[0])) activeRoomId = params[0];
    if (!activeRoomId) {
      const mine = list.find((r) => r.kind === "store" && r.memberIds.includes(meId) && r.name === store.storeName(me?.storeId));
      activeRoomId = mine?.id
        || [...list].sort((a, b) => String(lastMsgOf(b.id)?.date || "").localeCompare(String(lastMsgOf(a.id)?.date || "")))[0]?.id
        || null;
    }
    let showConv = !!params[0] || !isMobile();

    /* ============================================================
       レイアウト構築
       ============================================================ */
    root.appendChild(el("div", { class: "page-head chat-head" },
      el("div", {},
        el("h1", {}, "チャット"),
        el("div", { class: "page-desc" }, "店舗・グループ・個別のやり取りを1箇所に。@メンションで確実に届きます。")),
      el("div", { class: "page-actions" },
        el("button", { class: "btn ghost sm", onclick: markAllRead }, icon("check", 15), "すべて既読"),
        el("button", { class: "btn primary sm", onclick: openNewRoom }, icon("plus", 15), "新しいルーム"))));

    const roomsPane = el("aside", { class: "chat-rooms" });
    const convPane = el("section", { class: "chat-conv" });
    const shell = el("div", { class: `chat-shell ${showConv ? "show-conv" : ""}` }, roomsPane, convPane);
    root.appendChild(shell);

    /* ---- ルーム一覧のヘッダ(検索は再描画で作り直さない) ---- */
    const roomSearch = el("input", {
      class: "input cr-search", type: "search", placeholder: "ルーム・メンバーを検索",
      oninput: (e) => { roomQuery = e.target.value; drawRoomList(); },
    });
    const roomScroll = el("div", { class: "cr-scroll" });
    roomsPane.append(
      el("div", { class: "cr-head" },
        el("div", { class: "cr-head-top" },
          el("span", { class: "cr-head-title" }, "トーク"),
          el("button", { class: "icon-btn cr-new", title: "新しいルームを作成", "aria-label": "新しいルームを作成", onclick: openNewRoom }, icon("plus", 18))),
        el("div", { class: "cr-search-wrap" }, el("span", { class: "cr-search-ic" }, icon("search", 15)), roomSearch)),
      roomScroll);

    /* ============================================================
       ルーム一覧
       ============================================================ */
    function drawRoomList() {
      clear(roomScroll);
      const q = roomQuery.trim();
      const sections = [
        { kind: "group", label: "グループ" },
        { kind: "store", label: "店舗" },
        { kind: "dm", label: "ダイレクト" },
      ];
      let hit = 0;
      for (const sec of sections) {
        const rs = myRooms()
          .filter((r) => r.kind === sec.kind)
          .filter((r) => {
            if (!q) return true;
            const names = r.memberIds.map((id) => store.staffName(id)).join(" ");
            return `${roomTitle(r)} ${r.desc || ""} ${names} ${lastMsgOf(r.id)?.text || ""}`.includes(q);
          })
          .sort((a, b) => String(lastMsgOf(b.id)?.date || "").localeCompare(String(lastMsgOf(a.id)?.date || "")));
        if (!rs.length) continue;
        hit += rs.length;
        roomScroll.appendChild(el("div", { class: "cr-sec" }, sec.label, el("span", { class: "cr-sec-n" }, rs.length)));
        rs.forEach((r) => roomScroll.appendChild(roomRow(r)));
      }
      if (!hit) roomScroll.appendChild(emptyState({ icon: "🔍", title: "該当するルームがありません", hint: "別のキーワードでお試しください" }));
    }

    function roomRow(room) {
      const last = lastMsgOf(room.id);
      const unread = store.unreadInRoom(room.id);
      const atMe = mentionUnread(room.id);
      const prevAuthor = last && room.kind !== "dm" && last.authorId !== meId
        ? (store.staffName(last.authorId).split(" ")[0] + ": ") : (last && last.authorId === meId ? "自分: " : "");
      const prevText = last
        ? (last.attachment && !last.text ? `${last.attachment.kind === "image" ? "🖼" : "📎"} ${last.attachment.name}` : excerpt(last.text, 30))
        : "まだメッセージがありません";

      return el("button", {
        class: `cr-item ${room.id === activeRoomId ? "on" : ""} ${unread ? "unread" : ""}`,
        onclick: () => openRoom(room.id),
      },
        roomIconNode(room, 42),
        el("span", { class: "cr-main" },
          el("span", { class: "cr-line1" },
            el("span", { class: "cr-name" }, roomTitle(room)),
            el("span", { class: "cr-time" }, last ? relTime(last.date) : "")),
          el("span", { class: "cr-line2" },
            el("span", { class: "cr-prev" }, prevAuthor + prevText),
            el("span", { class: "cr-badges" },
              atMe > 0 ? el("span", { class: "cr-badge at" }, "@", String(atMe)) : null,
              unread > 0 && !atMe ? el("span", { class: "cr-badge" }, String(unread)) : null))));
    }

    /* ============================================================
       会話ペイン
       ============================================================ */
    const convHead = el("header", { class: "cv-head" });
    const convPin = el("div", { class: "cv-pin-slot" });
    const convSearch = el("div", { class: "cv-search-slot" });
    const convBody = el("div", { class: "cv-body" });
    const convFoot = el("div", { class: "cv-foot" });
    convPane.append(convHead, convPin, convSearch, convBody, convFoot);

    /* ---- ヘッダー ---- */
    function drawHead() {
      clear(convHead);
      clear(convPin);
      const room = roomById(activeRoomId);
      if (!room) return;
      const members = room.memberIds.map((id) => store.byId("staff", id)).filter(Boolean);

      const stack = el("button", {
        class: "cv-stack", title: "メンバーを見る", "aria-label": "メンバーを見る",
        onclick: () => openMembers(room),
      },
        el("span", { class: "avatar-stack" }, members.slice(0, 4).map((s) => avatar(s, 26))),
        members.length > 4 ? el("span", { class: "cv-more" }, `+${members.length - 4}`) : null);

      convHead.append(
        el("button", { class: "icon-btn cv-back", "aria-label": "ルーム一覧に戻る", onclick: backToList }, icon("chevL", 20)),
        roomIconNode(room, 38),
        el("div", { class: "cv-title" },
          el("div", { class: "cv-name" }, roomTitle(room),
            room.kind === "dm" ? badge("ダイレクト", "accent") : null),
          el("div", { class: "cv-sub" },
            `メンバー ${members.length}名`,
            room.kind === "dm"
              ? ` ・ ${store.storeName(otherOf(room)?.storeId)}・${otherOf(room)?.role || ""}`
              : (room.desc ? ` ・ ${room.desc}` : ""))),
        el("span", { class: "spacer" }),
        stack,
        el("button", {
          class: `icon-btn cv-searchbtn ${searchOpen ? "on" : ""}`, "aria-label": "このルーム内を検索",
          title: "このルーム内を検索",
          onclick: () => { searchOpen = !searchOpen; if (!searchOpen) msgQuery = ""; drawSearchBar(); drawMessages(); },
        }, icon("search", 18)));

      // ピン留め
      if (room.pinnedMessageId) {
        const pm = store.byId("chatMessages", room.pinnedMessageId);
        if (pm) {
          convPin.appendChild(el("div", { class: "cv-pin" },
            el("span", { class: "pin-ic" }, icon("pin", 14)),
            el("button", { class: "pin-body", onclick: () => jumpTo(pm.id) },
              el("span", { class: "pin-name" }, store.staffName(pm.authorId)),
              el("span", { class: "pin-text" }, excerpt(pm.text, 52))),
            el("button", {
              class: "icon-btn sm", title: "ピン留めを外す", "aria-label": "ピン留めを外す",
              onclick: () => { store.update("chatRooms", room.id, { pinnedMessageId: null }); drawHead(); toast("ピン留めを外しました", "info"); },
            }, icon("x", 14))));
        }
      }
    }

    function drawSearchBar() {
      clear(convSearch);
      if (!searchOpen) return;
      const input = el("input", {
        class: "input", type: "search", placeholder: "このルームのメッセージを検索",
        oninput: (e) => { msgQuery = e.target.value; drawMessages(); updateHitCount(); },
      });
      input.value = msgQuery;
      const count = el("span", { class: "cv-hit muted small" }, "");
      convSearch.appendChild(el("div", { class: "cv-search" },
        el("span", { class: "cv-search-ic" }, icon("search", 15)),
        input, count,
        el("button", {
          class: "icon-btn sm", "aria-label": "検索を閉じる",
          onclick: () => { searchOpen = false; msgQuery = ""; drawSearchBar(); drawMessages(); drawHead(); },
        }, icon("x", 15))));
      setTimeout(() => input.focus(), 0);
      updateHitCount();

      function updateHitCount() {
        const q = msgQuery.trim();
        count.textContent = q ? `${msgsOf(activeRoomId).filter((m) => m.text.includes(q)).length}件` : "";
      }
    }

    /* ---- メッセージ一覧 ---- */
    function drawMessages(keepScroll = false) {
      const prev = convBody.scrollTop;
      clear(convBody);
      const room = roomById(activeRoomId);
      if (!room) {
        convBody.appendChild(emptyState({ icon: "💬", title: "ルームを選択してください" }));
        return;
      }
      const q = msgQuery.trim();
      let msgs = msgsOf(room.id);
      if (q) msgs = msgs.filter((m) => m.text.includes(q));
      if (!msgs.length) {
        convBody.appendChild(emptyState({
          icon: q ? "🔍" : "💬",
          title: q ? "一致するメッセージがありません" : "まだメッセージがありません",
          hint: q ? "キーワードを変えてお試しください" : "最初のひとことを送ってみましょう",
        }));
        return;
      }

      // 少数のメッセージでも入力欄側に寄せる(margin-top:auto)
      const stream = el("div", { class: "cv-stream" });
      convBody.appendChild(stream);

      let lastDate = null, lastAuthor = null, lastTime = 0;
      for (const m of msgs) {
        const d = m.date.slice(0, 10);
        if (d !== lastDate) {
          stream.appendChild(el("div", { class: "day-sep" }, el("span", {}, dateLabel(d))));
          lastDate = d; lastAuthor = null;
        }
        let breakGroup = false;
        if (m.id === unreadFromId) {
          stream.appendChild(el("div", { class: "unread-sep" }, el("span", {}, "ここから未読")));
          breakGroup = true;
        }
        const t = new Date(m.date).getTime();
        const grouped = !breakGroup && !q && m.authorId === lastAuthor && t - lastTime < GROUP_WINDOW_MS;
        stream.appendChild(messageRow(m, room, grouped, q));
        lastAuthor = m.authorId; lastTime = t;
      }
      if (keepScroll) convBody.scrollTop = prev;
    }

    function messageRow(m, room, grouped, q) {
      const mine = m.authorId === meId;
      const author = store.byId("staff", m.authorId);
      const atMe = !mine && (m.mentions || []).includes(meId);

      const col = el("div", { class: "msg-col" });
      if (!mine && !grouped) {
        col.appendChild(el("div", { class: "msg-name" },
          author?.name || "退職スタッフ",
          el("span", { class: "msg-role" }, `${store.storeName(author?.storeId)}・${author?.role || ""}`)));
      }

      const bubble = el("div", { class: "msg-bubble" });
      if (m.replyToId) bubble.appendChild(quoteNode(m.replyToId));
      if (m.attachment) bubble.appendChild(attachNode(m.attachment));
      if (m.text) bubble.appendChild(el("div", { class: "msg-text" }, renderText(m.text, room, q)));
      if (m.edited) bubble.appendChild(el("span", { class: "msg-edited" }, "編集済み"));

      const readN = mine ? (m.readBy || []).filter((id) => id !== meId).length : 0;
      const meta = el("div", { class: "msg-meta" },
        mine && readN > 0
          ? el("span", { class: "msg-read", title: (m.readBy || []).filter((id) => id !== meId).map((id) => store.staffName(id)).join("、") }, `既読 ${readN}`)
          : null,
        el("span", { class: "msg-time" }, hhmm(m.date)));

      col.appendChild(el("div", { class: "msg-wrap" }, bubble, meta));
      col.appendChild(toolsNode(m, room));
      const reacts = reactionsNode(m);
      if (reacts) col.appendChild(reacts);

      return el("div", {
        class: `msg ${mine ? "mine" : "other"} ${grouped ? "grouped" : ""} ${atMe ? "at-me" : ""}`,
        dataset: { id: m.id },
      },
        mine ? null : (grouped ? el("span", { class: "msg-av-sp" }) : avatar(author, 34)),
        col);
    }

    /* ---- 本文(メンション強調 + 検索ハイライト) ---- */
    function renderText(text, room, q) {
      const names = ["全員", ...room.memberIds.map((id) => store.staffName(id))]
        .filter((n) => n && n !== "—")
        .sort((a, b) => b.length - a.length);
      const out = [];
      const re = new RegExp("@(" + names.map(escRe).join("|") + ")", "g");
      let last = 0, mm;
      while ((mm = re.exec(text)) !== null) {
        if (mm.index > last) out.push(...hlNodes(text.slice(last, mm.index), q));
        const nm = mm[1];
        const forMe = nm === "全員" || nm === store.staffName(meId);
        out.push(el("span", { class: `mention ${forMe ? "me" : ""}` }, "@" + nm));
        last = mm.index + mm[0].length;
      }
      if (last < text.length) out.push(...hlNodes(text.slice(last), q));
      return out;
    }

    function hlNodes(s, q) {
      if (!q) return [document.createTextNode(s)];
      const parts = s.split(q);
      const out = [];
      parts.forEach((p, i) => {
        if (i > 0) out.push(el("mark", { class: "msg-hit" }, q));
        if (p) out.push(document.createTextNode(p));
      });
      return out;
    }

    function quoteNode(id) {
      const src = store.byId("chatMessages", id);
      if (!src) return el("div", { class: "msg-quote gone" }, "元のメッセージは見つかりません");
      return el("button", { class: "msg-quote", onclick: (e) => { e.stopPropagation(); jumpTo(id); } },
        el("span", { class: "q-name" }, store.staffName(src.authorId)),
        el("span", { class: "q-text" }, excerpt(src.text || (src.attachment?.name ?? ""), 38)));
    }

    function attachNode(a) {
      return el("div", { class: "msg-attach" },
        el("span", { class: "at-ic" }, a.kind === "image" ? "🖼" : "📎"),
        el("span", { class: "at-name" }, a.name),
        el("span", { class: "at-hint" }, a.kind === "image" ? "画像" : "ファイル"));
    }

    function reactionsNode(m) {
      const entries = Object.entries(m.reactions || {}).filter(([, ids]) => ids && ids.length);
      if (!entries.length) return null;
      const wrap = el("div", { class: "msg-reacts" });
      for (const [emoji, ids] of entries) {
        const on = ids.includes(meId);
        wrap.appendChild(el("button", {
          class: `react-chip ${on ? "on" : ""}`,
          title: ids.map((id) => store.staffName(id)).join("、"),
          onclick: () => toggleReaction(m, emoji),
        }, el("span", { class: "rc-e" }, emoji), el("span", { class: "rc-n" }, String(ids.length))));
      }
      return wrap;
    }

    function toolsNode(m, room) {
      const tools = el("div", { class: "msg-tools" });
      tools.appendChild(el("button", {
        class: "tool-btn tool-toggle", title: "リアクションを選ぶ", "aria-label": "リアクションを選ぶ",
        onclick: () => tools.classList.toggle("open"),
      }, "☺"));
      for (const e of REACTIONS) {
        tools.appendChild(el("button", {
          class: `tool-btn tl-emoji ${(m.reactions?.[e] || []).includes(meId) ? "on" : ""}`,
          title: `${e} でリアクション`,
          onclick: () => toggleReaction(m, e),
        }, e));
      }
      tools.appendChild(el("button", {
        class: "tool-btn tl-ic", title: "このメッセージに返信", "aria-label": "返信",
        onclick: () => startReply(m),
      }, "↩"));
      tools.appendChild(el("button", {
        class: "tool-btn tl-ic", title: "ピン留めする", "aria-label": "ピン留め",
        onclick: () => {
          store.update("chatRooms", room.id, { pinnedMessageId: m.id });
          drawHead(); toast("ピン留めしました");
        },
      }, icon("pin", 13)));
      return tools;
    }

    /* ---------------- 操作 ---------------- */
    function toggleReaction(m, emoji) {
      const map = { ...(m.reactions || {}) };
      const arr = [...(map[emoji] || [])];
      const i = arr.indexOf(meId);
      if (i >= 0) arr.splice(i, 1); else arr.push(meId);
      if (arr.length) map[emoji] = arr; else delete map[emoji];
      store.update("chatMessages", m.id, { reactions: map });
      drawMessages(true);
    }

    function startReply(m) {
      replyToId = m.id;
      drawReplyBar();
      ta.focus();
    }

    function jumpTo(id) {
      if (msgQuery) { msgQuery = ""; searchOpen = false; drawSearchBar(); drawHead(); drawMessages(); }
      const node = convBody.querySelector(`.msg[data-id="${id}"]`);
      if (!node) { toast("元のメッセージが見つかりませんでした", "info"); return; }
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.classList.add("flash");
      setTimeout(() => node.classList.remove("flash"), 1400);
    }

    function markRoomRead(roomId) {
      let first = null;
      for (const m of msgsOf(roomId)) {
        if (m.authorId !== meId && !(m.readBy || []).includes(meId)) {
          if (!first) first = m.id;
          store.update("chatMessages", m.id, { readBy: [...(m.readBy || []), meId] });
        }
      }
      refreshNavBadge();
      return first;
    }

    function markAllRead() {
      const n = store.unreadChatCount();
      if (!n) { toast("未読はありません", "info"); return; }
      myRooms().forEach((r) => markRoomRead(r.id));
      unreadFromId = null;
      drawRoomList(); drawMessages(true);
      toast(`${n}件のメッセージを既読にしました`);
    }

    function refreshNavBadge() {
      const n = store.unreadChatCount();
      const b = document.querySelector('.nav-badge[data-role="chat-badge"]');
      if (!b) return;
      if (n > 0) b.textContent = String(n); else b.remove();
    }

    function openRoom(id) {
      if (!roomById(id)) return;
      saveDraft();
      activeRoomId = id;
      replyToId = null;
      pendingAttachment = null;
      msgQuery = ""; searchOpen = false;
      showConv = true;
      shell.classList.add("show-conv");
      try { history.replaceState(null, "", `#/chat/${id}`); } catch (e) { /* noop */ }
      unreadFromId = markRoomRead(id);
      buildConv();
      drawRoomList();
      scrollToBottom();
    }

    function backToList() {
      saveDraft();
      showConv = false;
      shell.classList.remove("show-conv");
      try { history.replaceState(null, "", "#/chat"); } catch (e) { /* noop */ }
      drawRoomList();
    }

    /* ============================================================
       入力欄
       ============================================================ */
    const ta = el("textarea", {
      class: "textarea cv-input", rows: 1, placeholder: "メッセージを入力(@でメンション / Shift+Enterで改行)",
    });
    const replySlot = el("div", { class: "cv-reply-slot" });
    const attachSlot = el("div", { class: "cv-attach-slot" });
    const mentionPop = el("div", { class: "mention-pop", hidden: true });
    const popLayer = el("div", { class: "cv-pop-layer" });

    const sendBtn = el("button", { class: "btn primary cv-send", onclick: send, title: "送信(Enter)" }, icon("send", 16), el("span", { class: "hide-mobile" }, "送信"));

    convFoot.append(
      replySlot, attachSlot,
      el("div", { class: "cv-inputrow" },
        el("div", { class: "cv-tools" },
          el("button", { class: "icon-btn cv-tool", title: "ファイルを添付", "aria-label": "ファイルを添付", onclick: openAttachPop }, "📎"),
          el("button", { class: "icon-btn cv-tool", title: "絵文字を挿入", "aria-label": "絵文字を挿入", onclick: openEmojiPop }, "😊"),
          el("button", { class: "icon-btn cv-tool", title: "メンバーをメンション", "aria-label": "メンション", onclick: () => insertAtCaret("@") }, "@")),
        el("div", { class: "cv-inputwrap" }, ta, mentionPop),
        sendBtn),
      popLayer);

    ta.addEventListener("input", () => { autoGrow(); saveDraft(); updateMentionPop(); });
    ta.addEventListener("click", updateMentionPop);
    ta.addEventListener("blur", () => setTimeout(closeMentionPop, 180));
    ta.addEventListener("keydown", (e) => {
      if (mentionOpen) {
        if (e.key === "ArrowDown") { e.preventDefault(); mentionIdx = (mentionIdx + 1) % mentionCands.length; paintMentionPop(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); mentionIdx = (mentionIdx - 1 + mentionCands.length) % mentionCands.length; paintMentionPop(); return; }
        if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); applyMention(mentionCands[mentionIdx]); return; }
        if (e.key === "Escape") { e.preventDefault(); closeMentionPop(); return; }
        if (e.key === "Tab") { e.preventDefault(); applyMention(mentionCands[mentionIdx]); return; }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        if (e.isComposing || e.keyCode === 229) return;   // 日本語IME変換中は送信しない
        e.preventDefault();
        send();
      }
    });

    function autoGrow() {
      ta.style.height = "auto";
      ta.style.height = Math.min(132, Math.max(40, ta.scrollHeight)) + "px";
    }

    function saveDraft() { if (activeRoomId) drafts.set(activeRoomId, ta.value); }

    function insertAtCaret(s) {
      const p = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, p) + s + ta.value.slice(ta.selectionEnd ?? p);
      const np = p + s.length;
      ta.focus(); ta.setSelectionRange(np, np);
      autoGrow(); saveDraft(); updateMentionPop();
    }

    /* ---- 返信プレビュー / 添付プレビュー ---- */
    function drawReplyBar() {
      clear(replySlot);
      if (!replyToId) return;
      const src = store.byId("chatMessages", replyToId);
      if (!src) { replyToId = null; return; }
      replySlot.appendChild(el("div", { class: "cv-reply" },
        el("span", { class: "rp-ic" }, "↩"),
        el("span", { class: "rp-body" },
          el("span", { class: "rp-name" }, `${store.staffName(src.authorId)} に返信`),
          el("span", { class: "rp-text" }, excerpt(src.text || src.attachment?.name || "", 46))),
        el("button", {
          class: "icon-btn sm", "aria-label": "返信をやめる",
          onclick: () => { replyToId = null; drawReplyBar(); },
        }, icon("x", 14))));
    }

    function drawAttachBar() {
      clear(attachSlot);
      if (!pendingAttachment) return;
      attachSlot.appendChild(el("div", { class: "cv-attachbar" },
        el("span", { class: "at-ic" }, pendingAttachment.kind === "image" ? "🖼" : "📎"),
        el("span", { class: "at-name" }, pendingAttachment.name),
        el("span", { class: "small muted" }, "(デモ用のダミー添付)"),
        el("button", {
          class: "icon-btn sm", "aria-label": "添付を外す",
          onclick: () => { pendingAttachment = null; drawAttachBar(); },
        }, icon("x", 14))));
    }

    /* ---- ポップオーバー(添付・絵文字) ---- */
    function closePop() {
      if (popEl) { popEl.remove(); popEl = null; }
      if (popCloser) { document.removeEventListener("click", popCloser, true); popCloser = null; }
    }

    function openPop(node) {
      closePop();
      popEl = node;
      popLayer.appendChild(node);
      popCloser = (ev) => { if (popEl && !popEl.contains(ev.target)) closePop(); };
      setTimeout(() => document.addEventListener("click", popCloser, true), 0);
    }

    function openAttachPop() {
      if (popEl?.classList.contains("attach-pop")) { closePop(); return; }
      openPop(el("div", { class: "chat-pop attach-pop" },
        el("div", { class: "pop-title" }, "添付するもの(デモ)"),
        DUMMY_FILES.map((f) => el("button", {
          class: "pop-item",
          onclick: () => { pendingAttachment = { ...f }; drawAttachBar(); closePop(); ta.focus(); },
        }, el("span", { class: "pi-ic" }, f.kind === "image" ? "🖼" : "📎"), f.name))));
    }

    function openEmojiPop() {
      if (popEl?.classList.contains("emoji-pop")) { closePop(); return; }
      openPop(el("div", { class: "chat-pop emoji-pop" },
        QUICK_EMOJI.map((e) => el("button", { class: "pop-emoji", onclick: () => { insertAtCaret(e); closePop(); } }, e))));
    }

    /* ---- メンション入力補助 ---- */
    function mentionCandidates(q) {
      const room = roomById(activeRoomId);
      if (!room) return [];
      const out = [];
      if (!q || "全員".includes(q) || "ぜんいん".includes(q) || "all".startsWith(q.toLowerCase())) {
        out.push({ id: "__all__", name: "全員", sub: `ルームの${room.memberIds.length}名全員に通知`, color: "var(--accent)" });
      }
      for (const id of room.memberIds) {
        if (id === meId) continue;
        const s = store.byId("staff", id);
        if (!s) continue;
        if (q && !(s.name.includes(q) || s.kana.includes(q) || s.name.replace(/\s/g, "").includes(q))) continue;
        out.push({ id: s.id, name: s.name, sub: `${store.storeName(s.storeId)}・${s.role}`, staff: s });
      }
      return out.slice(0, 8);
    }

    function updateMentionPop() {
      const pos = ta.selectionStart ?? 0;
      const before = ta.value.slice(0, pos);
      const m = /(?:^|[\s\n(（])@([^\s@]{0,14})$/.exec(before) || /^@([^\s@]{0,14})$/.exec(before);
      if (!m) { closeMentionPop(); return; }
      mentionCands = mentionCandidates(m[1]);
      if (!mentionCands.length) { closeMentionPop(); return; }
      mentionOpen = true;
      mentionIdx = Math.min(mentionIdx, mentionCands.length - 1);
      paintMentionPop();
    }

    function paintMentionPop() {
      clear(mentionPop);
      mentionPop.hidden = false;
      mentionPop.appendChild(el("div", { class: "mp-title" }, "メンションする相手を選ぶ ↑↓ + Enter"));
      mentionCands.forEach((c, i) => {
        mentionPop.appendChild(el("button", {
          class: `mp-item ${i === mentionIdx ? "on" : ""}`,
          onmousedown: (e) => { e.preventDefault(); applyMention(c); },
        },
          c.staff ? avatar(c.staff, 26) : el("span", { class: "mp-all" }, "@"),
          el("span", { class: "mp-meta" },
            el("span", { class: "mp-name" }, c.name),
            el("span", { class: "mp-sub" }, c.sub))));
      });
    }

    function closeMentionPop() {
      mentionOpen = false; mentionIdx = 0; mentionCands = [];
      mentionPop.hidden = true; clear(mentionPop);
    }

    function applyMention(c) {
      if (!c) return;
      const pos = ta.selectionStart ?? ta.value.length;
      const before = ta.value.slice(0, pos).replace(/@([^\s@]{0,14})$/, "");
      const after = ta.value.slice(pos);
      const ins = `@${c.name} `;
      ta.value = before + ins + after;
      const np = (before + ins).length;
      ta.focus(); ta.setSelectionRange(np, np);
      closeMentionPop(); autoGrow(); saveDraft();
    }

    function detectMentions(text, room) {
      const ids = new Set();
      if (text.includes("@全員")) room.memberIds.forEach((id) => { if (id !== meId) ids.add(id); });
      for (const id of room.memberIds) {
        if (id === meId) continue;
        const n = store.staffName(id);
        if (n && n !== "—" && text.includes("@" + n)) ids.add(id);
      }
      return [...ids];
    }

    /* ---- 送信 ---- */
    function send() {
      const room = roomById(activeRoomId);
      if (!room) return;
      const text = ta.value.trim();
      if (!text && !pendingAttachment) { toast("メッセージを入力してください", "error"); return; }
      const mentions = detectMentions(text, room);
      store.add("chatMessages", {
        roomId: room.id,
        authorId: meId,
        date: nextMessageDate(room.id),
        text,
        mentions,
        reactions: {},
        readBy: [meId],
        replyToId,
        attachment: pendingAttachment,
        edited: false,
      });
      ta.value = ""; autoGrow(); saveDraft();
      replyToId = null; pendingAttachment = null;
      unreadFromId = null;
      if (msgQuery) { msgQuery = ""; searchOpen = false; drawSearchBar(); drawHead(); }
      drawReplyBar(); drawAttachBar(); closeMentionPop(); closePop();
      drawMessages(); scrollToBottom(); drawRoomList();
      if (mentions.length) toast(`${mentions.length}名にメンションを送りました`, "success");
    }

    function scrollToBottom() {
      requestAnimationFrame(() => { convBody.scrollTop = convBody.scrollHeight; });
      setTimeout(() => { convBody.scrollTop = convBody.scrollHeight; }, 60);
    }

    /* ============================================================
       会話ペインの組み立て
       ============================================================ */
    function buildConv() {
      const room = roomById(activeRoomId);
      clear(convSearch);
      if (!room) {
        clear(convHead); clear(convPin); clear(convBody);
        convBody.appendChild(emptyState({ title: "参加中のルームがありません", hint: "「新しいルーム」から作成できます" }));
        convFoot.style.display = "none";
        return;
      }
      convFoot.style.display = "";
      drawHead();
      drawSearchBar();
      drawMessages();
      ta.value = drafts.get(room.id) || "";
      ta.placeholder = room.kind === "dm"
        ? `${roomTitle(room)} さんへメッセージ(Enterで送信)`
        : `${roomTitle(room)} に投稿(@でメンション / Shift+Enterで改行)`;
      autoGrow();
      drawReplyBar(); drawAttachBar(); closeMentionPop(); closePop();
    }

    /* ============================================================
       メンバー一覧 / 新規ルーム
       ============================================================ */
    function openMembers(room) {
      const body = el("div", { class: "page-chat chat-modal chat-members" },
        room.memberIds.map((id) => el("div", { class: "cm-row" },
          staffChip(id, { size: 34 }),
          id === meId ? badge("自分", "brand") : null)));
      modal({ title: `${roomTitle(room)} のメンバー(${room.memberIds.length}名)`, body });
    }

    function openNewRoom() {
      const nameInput = el("input", { class: "input", placeholder: "例:新人フォロー班" });
      let emoji = "💬";
      const emojiRow = el("div", { class: "emoji-row" });
      const paintEmoji = () => {
        clear(emojiRow);
        ROOM_EMOJI.forEach((e) => emojiRow.appendChild(el("button", {
          class: `emoji-pick ${e === emoji ? "on" : ""}`,
          onclick: () => { emoji = e; paintEmoji(); },
        }, e)));
      };
      paintEmoji();

      const picked = new Set();
      const countLabel = el("span", { class: "small muted" }, "0名を選択中");
      const memberBox = el("div", { class: "member-pick" });
      const paintCount = () => {
        countLabel.textContent = picked.size === 1
          ? "1名を選択中(ダイレクトメッセージとして作成されます)"
          : `${picked.size}名を選択中`;
      };
      store.get("staff").filter((s) => s.id !== meId).forEach((s) => {
        const cb = el("input", { type: "checkbox", value: s.id });
        cb.addEventListener("change", () => {
          if (cb.checked) picked.add(s.id); else picked.delete(s.id);
          paintCount();
        });
        memberBox.appendChild(el("label", { class: "mp-row" },
          cb, avatar(s, 30),
          el("span", { class: "mp-info" },
            el("span", { class: "mp-n" }, s.name),
            el("span", { class: "mp-s" }, `${store.storeName(s.storeId)}・${s.role}`))));
      });
      paintCount();

      const create = el("button", { class: "btn primary" }, icon("check", 16), "作成する");
      const cancel = el("button", { class: "btn ghost" }, "キャンセル");
      const body = el("div", { class: "page-chat chat-modal new-room" },
        el("div", { class: "field" }, el("label", {}, "ルーム名"), nameInput,
          el("span", { class: "hint" }, "1名だけ選ぶとダイレクトメッセージになり、ルーム名は不要です。")),
        el("div", { class: "field" }, el("label", {}, "アイコン"), emojiRow),
        el("div", { class: "field" },
          el("label", {}, "メンバー"), countLabel, memberBox));

      const m = modal({ title: "新しいルームを作成", body, actions: [cancel, create] });
      cancel.addEventListener("click", () => m.close());
      create.addEventListener("click", () => {
        const ids = [...picked];
        if (!ids.length) { toast("メンバーを1名以上選んでください", "error"); return; }
        const kind = ids.length === 1 ? "dm" : "group";
        const name = nameInput.value.trim();
        if (kind === "group" && !name) { toast("ルーム名を入力してください", "error"); return; }
        const room = store.add("chatRooms", {
          id: store.uid("cr"),
          kind,
          name: kind === "dm" ? null : name,
          icon: kind === "dm" ? null : emoji,
          desc: kind === "dm" ? "" : "新しく作成されたルーム",
          memberIds: [meId, ...ids],
          pinnedMessageId: null,
        });
        m.close();
        openRoom(room.id);
        toast(kind === "dm" ? "ダイレクトメッセージを開きました" : `「${name}」を作成しました`);
      });
    }

    /* ============================================================
       高さ調整(会話ペインをビューポート内に収める)
       ============================================================ */
    function fitHeight() {
      if (!document.body.contains(shell)) { window.removeEventListener("resize", fitHeight); return; }
      const main = shell.closest(".main");
      const pad = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      const mb = parseFloat(getComputedStyle(root).marginBottom) || 0;
      const top = shell.getBoundingClientRect().top;
      const h = Math.max(360, Math.round(window.innerHeight - top - (pad + mb)));
      shell.style.height = h + "px";
    }
    requestAnimationFrame(() => { fitHeight(); setTimeout(fitHeight, 500); });
    window.addEventListener("resize", fitHeight);

    /* ---------------- 初期描画 ---------------- */
    if (activeRoomId && (showConv || !isMobile())) unreadFromId = markRoomRead(activeRoomId);
    drawRoomList();
    buildConv();
    scrollToBottom();
    refreshNavBadge();
  },
};
