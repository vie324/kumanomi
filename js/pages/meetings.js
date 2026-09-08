/* ============================================================
   会議・議事録 — マネージャー会議(週次)/幹部会議(月次)の
   議事録・タスクチェック・AI整形・アクションアイテム管理
   ============================================================ */
import {
  el, clear, icon, badge, avatar, card, sectionHeader, table, emptyState,
  staffChip, fmtDate, toast, aiButton, aiPanel, micButton,
} from "../ui.js";
import { store, todayStr } from "../store.js";
import { summarizeMeeting, sampleMeetingVoice } from "../ai.js";

/* ---------------- 定数・ヘルパー ---------------- */

const TYPE_META = {
  manager: { label: "マネージャー会議・週次", kind: "brand" },
  executive: { label: "幹部会議・月次", kind: "accent" },
  adhoc: { label: "臨時", kind: "" },
};

const STATUS_NEXT = { todo: "doing", doing: "done", done: "todo" };
const STATUS_LABEL = { todo: "未着手", doing: "進行中", done: "完了" };

function typeBadge(type) {
  const t = TYPE_META[type] || TYPE_META.adhoc;
  return badge(t.label, t.kind);
}

function endTime(start, durationMin) {
  if (!start) return "";
  const [h, m] = start.split(":").map(Number);
  const t = h * 60 + m + (Number(durationMin) || 0);
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function isOverdue(it) {
  return !!it.due && it.due < todayStr() && it.status !== "done";
}

/** 全会議を日付降順(新しい順)で */
function sortedMeetings() {
  return [...store.get("meetings")].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** 同じ種別で、この会議より前の直近の会議 */
function prevMeetingOf(meeting) {
  return store.get("meetings")
    .filter((m) => m.type === meeting.type && m.date < meeting.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0] || null;
}

const openMeeting = (id) => { location.hash = `#/meetings/${id}`; };

/** 参加者アバターの重ねスタック */
function attendeeStack(ids = [], size = 30, max = 8) {
  const shown = ids.slice(0, max);
  return el("div", { class: "avatar-stack" },
    shown.map((id) => avatar(store.byId("staff", id), size)),
    ids.length > max
      ? el("span", {
          class: "avatar pm-more",
          style: { width: size + "px", height: size + "px", fontSize: Math.round(size * 0.36) + "px" },
        }, `+${ids.length - max}`)
      : null);
}

/** アジェンダの番号付きリスト */
function agendaList(agenda = [], small = false) {
  return el("ol", { class: `pm-agenda ${small ? "sm" : ""}` },
    agenda.map((a, i) => el("li", {},
      el("span", { class: "pm-agenda-no" }, i + 1),
      el("span", {}, a))));
}

/** 状態切替ボタン(todo→doing→done→todo) */
function statusBtn(meetingId, item, onChanged) {
  return el("button", {
    class: `pm-st ${item.status}`,
    title: "クリックで 未着手 → 進行中 → 完了 を切替",
    onclick: (e) => {
      e.stopPropagation();
      store.update("meetings", meetingId, (m) => {
        const target = (m.actionItems || []).find((x) => x.id === item.id);
        if (target) target.status = STATUS_NEXT[target.status] || "todo";
        return { actionItems: m.actionItems };
      });
      onChanged?.();
    },
  },
    item.status === "done" ? icon("check", 13) : null,
    STATUS_LABEL[item.status] || item.status);
}

/** 議事録のアクションアイテムをタスクリストへ送る(重複は追加しない)。追加できたら true */
function sendActionToTasks(meeting, it, { silent = false } = {}) {
  const dup = store.get("tasks").some((t) =>
    t.source?.kind === "meeting" && t.source?.refId === meeting.id && t.title === it.title);
  if (dup) {
    if (!silent) toast("このアクションはすでにタスクリストにあります", "info");
    return false;
  }
  store.add("tasks", {
    title: it.title,
    note: `議事録「${meeting.title}(${fmtDate(meeting.date)})」から作成`,
    ownerId: it.ownerId,
    createdBy: store.me().id,
    due: it.due || null,
    status: it.status === "done" ? "done" : it.status === "doing" ? "doing" : "todo",
    source: { kind: "meeting", refId: meeting.id, label: meeting.title },
    createdAt: todayStr(),
  });
  if (!silent) toast(`「${it.title}」をタスクリストへ送りました(担当:${store.staffName(it.ownerId)})`);
  return true;
}

/** アクションアイテム 1 行(担当・期限・期限超過つき)
    meeting を渡すと「タスクへ」ボタン(タスクリスト連携)が付く */
function actionRow(meetingId, it, onChanged, meeting = null) {
  return el("div", { class: "pm-ai-row" },
    statusBtn(meetingId, it, onChanged),
    el("div", { class: "pm-ai-main" },
      el("div", { class: `pm-ai-title ${it.status === "done" ? "done" : ""}` }, it.title),
      el("div", { class: "pm-ai-meta" },
        staffChip(it.ownerId, { size: 22, withRole: false }),
        el("span", { class: "pm-due" }, icon("calendar", 12), `期限 ${fmtDate(it.due)}`),
        isOverdue(it) ? badge("期限超過", "critical") : null)),
    meeting ? el("button", {
      class: "btn ghost sm pm-totask",
      title: "タスクリストへ送る",
      onclick: (e) => { e.stopPropagation(); sendActionToTasks(meeting, it); },
    }, icon("clipboard", 13), "タスクへ") : null);
}

/* ============================================================
   一覧ビュー
   ============================================================ */

function renderList(root) {
  const rerender = () => { clear(root); renderList(root); };
  const today = todayStr();
  const meetings = sortedMeetings();

  root.appendChild(sectionHeader("会議・議事録",
    "マネージャー会議(週1・90分)/幹部会議(月1)の議事録とアクションアイテムを一元管理"));

  // ---- 次回会議カード ----
  const next = meetings.filter((m) => m.date >= today)
    .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0))[0];
  if (next) root.appendChild(nextMeetingCard(next, today));

  // ---- 会議一覧(タイムライン) ----
  const tl = el("div", { class: "timeline" },
    meetings.map((m) => timelineItem(m, today)));
  root.appendChild(card({
    title: "会議一覧", sub: `${meetings.length}件・クリックで議事録へ`,
    body: tl, class: "mt-16",
  }));

  // ---- 全会議のアクションアイテム横断 ----
  root.appendChild(allActionsCard(meetings, rerender));
}

function nextMeetingCard(m, today) {
  return el("div", { class: "card pm-next" },
    el("div", { class: "pm-next-tag" }, icon("calendar", 14),
      m.date === today ? "本日の会議" : "次回の会議"),
    el("div", { class: "pm-next-grid" },
      el("div", { class: "pm-next-main" },
        el("div", { class: "flex wrap", style: { gap: "8px" } },
          typeBadge(m.type),
          el("span", { class: "pm-next-title" }, m.title)),
        el("div", { class: "pm-next-when" },
          el("strong", {}, fmtDate(m.date)),
          `${m.start}〜${endTime(m.start, m.durationMin)}(所要 ${m.durationMin}分)`),
        agendaList(m.agenda, true)),
      el("div", { class: "pm-next-side" },
        el("span", { class: "small muted" }, `参加者 ${(m.attendees || []).length}名`),
        attendeeStack(m.attendees, 32),
        el("button", { class: "btn primary", onclick: () => openMeeting(m.id) },
          icon("clipboard", 16), "議事録を開く"))));
}

function timelineItem(m, today) {
  const openCnt = (m.actionItems || []).filter((it) => it.status !== "done").length;
  const isFuture = m.date >= today;
  const cls = m.type === "executive" ? "accent" : m.type === "adhoc" ? "pm-adhoc" : "";
  return el("div", { class: `tl-item ${cls}` },
    el("div", {
      class: "pm-tl-card", role: "button", tabindex: "0",
      onclick: () => openMeeting(m.id),
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMeeting(m.id); } },
    },
      el("div", { class: "pm-tl-top" },
        el("span", { class: "tl-date" }, `${fmtDate(m.date)} ${m.start}〜`),
        typeBadge(m.type),
        m.date === today ? badge("本日", "accent") : (isFuture ? badge("予定") : null)),
      el("div", { class: "pm-tl-title" }, m.title),
      el("div", { class: "pm-tl-meta" },
        attendeeStack(m.attendees, 24, 6),
        el("span", { class: "small muted" }, `${m.durationMin}分`),
        m.minutes
          ? el("span", { class: "small pm-ok" }, icon("check", 12), "議事録あり")
          : el("span", { class: "small muted" }, isFuture ? "議事録は未作成" : "議事録未記入"),
        openCnt ? el("span", { class: "small pm-warn" }, `未完了タスク ${openCnt}件`) : null),
      el("span", { class: "pm-tl-chev" }, icon("chevR", 16))));
}

function allActionsCard(meetings, rerender) {
  const rows = [];
  for (const m of meetings) {
    for (const it of (m.actionItems || [])) {
      if (it.status !== "done") rows.push({ m, it });
    }
  }
  rows.sort((a, b) => ((a.it.due || "9999-99-99") < (b.it.due || "9999-99-99") ? -1 : 1));
  const overdue = rows.filter((r) => isOverdue(r.it)).length;

  const body = table({
    columns: [
      { key: "meeting", label: "会議", render: (r) => el("span", {},
          el("span", { style: { display: "block", fontWeight: "700" } }, r.m.title),
          el("span", { class: "small muted" }, fmtDate(r.m.date))) },
      { key: "title", label: "アクションアイテム", render: (r) => el("span", { class: "pm-cell-action" }, r.it.title) },
      { key: "owner", label: "担当", render: (r) => staffChip(r.it.ownerId, { size: 26, withRole: false }) },
      { key: "due", label: "期限", render: (r) => el("span", { class: "flex", style: { gap: "6px" } },
          el("span", { class: "mono-num" }, fmtDate(r.it.due)),
          isOverdue(r.it) ? badge("期限超過", "critical") : null) },
      { key: "status", label: "状態", align: "center", render: (r) => statusBtn(r.m.id, r.it, rerender) },
    ],
    rows,
    empty: "未完了のアクションアイテムはありません 🎉",
  });

  return card({
    title: "全会議のアクションアイテム",
    sub: overdue ? `未完了 ${rows.length}件(うち期限超過 ${overdue}件)` : `未完了 ${rows.length}件`,
    body, class: "mt-16",
  });
}

/* ============================================================
   詳細ビュー
   ============================================================ */

function backButton() {
  return el("button", { class: "btn ghost sm", onclick: () => { location.hash = "#/meetings"; } },
    icon("chevL", 15), "一覧へ戻る");
}

function renderDetail(root, meeting) {
  const rerender = () => { clear(root); renderDetail(root, store.byId("meetings", meeting.id)); };

  root.appendChild(el("div", { class: "pm-back-row" }, backButton()));

  // ---- 会議情報ヘッダ ----
  root.appendChild(el("div", { class: "card pm-head" },
    el("div", { class: "pm-head-main" },
      el("div", { class: "flex wrap", style: { gap: "8px" } }, typeBadge(meeting.type)),
      el("h2", { class: "pm-head-title" }, meeting.title),
      el("div", { class: "pm-head-meta" },
        el("span", { class: "pm-meta-item" }, icon("calendar", 15), fmtDate(meeting.date, { withYear: true })),
        el("span", { class: "pm-meta-item" }, icon("clock", 15),
          `${meeting.start}〜${endTime(meeting.start, meeting.durationMin)}(所要 ${meeting.durationMin}分)`),
        el("span", { class: "pm-meta-item" }, icon("users", 15), `参加者 ${(meeting.attendees || []).length}名`)),
      attendeeStack(meeting.attendees, 30)),
    el("div", { class: "page-actions pm-head-actions" },
      el("button", { class: "btn ghost", onclick: () => window.print() }, icon("print", 16), "印刷"))));

  // ---- アジェンダ + タスクチェック ----
  root.appendChild(el("div", { class: "grid cols-2 mt-16" },
    agendaCard(meeting),
    taskCheckCard(meeting, rerender)));

  // ---- 議事録(編集 + AI整形) ----
  root.appendChild(minutesCard(meeting, rerender));

  // ---- 決定事項 + この会議のアクション ----
  root.appendChild(el("div", { class: "grid cols-2 mt-16" },
    decisionsCard(meeting),
    ownActionsCard(meeting, rerender)));
}

function agendaCard(meeting) {
  const body = (meeting.agenda || []).length
    ? agendaList(meeting.agenda)
    : emptyState({ icon: "📋", title: "アジェンダは未設定です" });
  return card({ title: "アジェンダ", sub: `所要 ${meeting.durationMin}分`, body });
}

function taskCheckCard(meeting, rerender) {
  const prev = prevMeetingOf(meeting);
  const note = el("div", { class: "pm-note" }, icon("info", 14),
    el("span", {}, "会議の冒頭で前回タスクを一緒に確認します(事前チェックはしない運用)"));

  let body;
  if (!prev) {
    body = el("div", {}, note,
      emptyState({ icon: "🗒", title: "前回の会議がありません", hint: "同じ種別の過去の会議が見つかりませんでした" }));
  } else if (!(prev.actionItems || []).length) {
    body = el("div", {}, note,
      el("div", { class: "small muted mb-8" }, `前回:${prev.title}(${fmtDate(prev.date)})`),
      emptyState({ icon: "✅", title: "前回のアクションアイテムはありません" }));
  } else {
    const doneCnt = prev.actionItems.filter((x) => x.status === "done").length;
    body = el("div", {},
      note,
      el("div", { class: "pm-prev-line" },
        el("span", { class: "small muted" }, `前回:${prev.title}(${fmtDate(prev.date)})`),
        badge(`完了 ${doneCnt}/${prev.actionItems.length}`, doneCnt === prev.actionItems.length ? "good" : "warn")),
      el("div", { class: "pm-ai-list" },
        prev.actionItems.map((it) => actionRow(prev.id, it, rerender))));
  }
  return card({ title: "タスクチェック", sub: "前回会議のアクション", body });
}

function minutesCard(meeting, rerender) {
  const ta = el("textarea", {
    class: "textarea pm-minutes",
    rows: 9,
    placeholder: "「ボイス入力」を押して会議の内容を話すだけでOK。走り書きの入力でもかまいません。\n例)\n・全店で前月比+4.2%。成増店の回数券成約が好調\n・川越店の夕方枠対策としてLINE配信を8月第1週に実施\n・次回までに離反リスク患者リストの声かけ結果を確認",
  }, meeting.minutes || "");

  const mic = micButton(ta, {
    samples: [sampleMeetingVoice(0), sampleMeetingVoice(1)],
    label: "ボイス入力",
  });

  const saveBtn = el("button", {
    class: "btn ghost",
    onclick: () => {
      store.update("meetings", meeting.id, { minutes: ta.value });
      toast("議事録を保存しました");
    },
  }, icon("check", 16), "保存");

  const host = el("div", { class: "mt-12" });
  const panel = aiPanel("AI議事録アシスタント");

  const aiBtn = aiButton("AIで議事録に整形", async () => {
    const text = ta.value.trim();
    if (!text) {
      toast("メモが空です。ボイス入力または走り書きで入力してください", "error");
      return;
    }
    if (!panel.el.isConnected) host.appendChild(panel.el);
    panel.thinking("メモを解析しています");
    const res = await summarizeMeeting(text, meeting);
    panel.setNode(aiResultNode(meeting, ta, res, rerender));
  });

  return card({
    title: "議事録",
    sub: "ボイス入力→AIが要点・決定事項・アクションに整形します",
    class: "mt-16",
    body: el("div", {},
      ta,
      el("div", { class: "pm-ta-actions" }, mic, saveBtn, aiBtn),
      meeting.aiSummary
        ? el("div", { class: "pm-aisum mt-12" },
            el("div", { class: "pm-aisum-head" }, icon("sparkle", 14), "AI要約(保存済み)"),
            el("div", { class: "pm-aisum-body" }, meeting.aiSummary))
        : null,
      host),
  });
}

function aiResultNode(meeting, ta, res, rerender) {
  const realDecisions = (res.decisions || []).filter((d) => !d.includes("検出されませんでした"));
  const items = res.actionItems || [];

  const adoptBtn = el("button", {
    class: "btn primary sm",
    onclick: () => {
      store.update("meetings", meeting.id, (m) => ({
        minutes: ta.value,
        aiSummary: res.summary,
        decisions: [...(m.decisions || []), ...realDecisions.filter((d) => !(m.decisions || []).includes(d))],
        actionItems: [...(m.actionItems || []), ...items],
      }));
      toast("AI整形の内容を議事録に反映しました");
      rerender();
    },
  }, icon("check", 14), "この内容を採用");

  return el("div", {},
    el("h4", {}, "要点"),
    el("p", {}, res.summary),
    el("h4", {}, "決定事項"),
    el("ul", {}, (res.decisions || []).map((d) => el("li", {}, d))),
    el("h4", {}, "アクションアイテム案(担当・期限つき)"),
    items.length
      ? el("ul", {}, items.map((a) =>
          el("li", {}, `${a.title} — 担当:${store.staffName(a.ownerId)}/期限 ${fmtDate(a.due)}`)))
      : el("p", { class: "muted" }, "抽出できるアクションはありませんでした。"),
    el("div", { class: "pm-adopt-row" },
      adoptBtn,
      el("span", { class: "small muted" }, "採用すると要約・決定事項が保存され、アクションは既存リストに追記されます")));
}

function decisionsCard(meeting) {
  const list = meeting.decisions || [];
  const body = list.length
    ? el("ul", { class: "pm-decisions" },
        list.map((d) => el("li", {}, el("span", { class: "pm-dec-ic" }, icon("check", 13)), el("span", {}, d))))
    : emptyState({ icon: "📌", title: "決定事項はまだありません", hint: "議事録のAI整形「この内容を採用」で追加されます" });
  return card({ title: "決定事項", sub: `${list.length}件`, body });
}

function ownActionsCard(meeting, rerender) {
  const items = meeting.actionItems || [];
  const openCnt = items.filter((x) => x.status !== "done").length;
  const sendAllBtn = items.length
    ? el("button", {
        class: "btn soft sm",
        onclick: () => {
          const added = items.filter((it) => sendActionToTasks(meeting, it, { silent: true })).length;
          toast(added ? `${added}件のアクションをタスクリストへ送りました` : "すべて送信済みです", added ? "success" : "info");
        },
      }, icon("clipboard", 13), "すべてタスクへ")
    : null;
  const body = items.length
    ? el("div", { class: "pm-ai-list" }, items.map((it) => actionRow(meeting.id, it, rerender, meeting)))
    : emptyState({ icon: "🎯", title: "アクションアイテムはまだありません", hint: "議事録のAI整形から追加できます" });
  return card({
    title: "この会議のアクションアイテム",
    sub: `未完了 ${openCnt}/${items.length}件・「タスクへ」でタスクリストに送れます`,
    actions: sendAllBtn,
    body,
  });
}

/* ============================================================
   ページ定義
   ============================================================ */

export default {
  id: "meetings",
  title: "会議・議事録",
  icon: "clipboard",

  // このページが必要とするデータ。ルーターがそろえてから render() を呼ぶ
  needs: ["meetings", "staff", "stores", "tasks"],
  render(root, params) {
    const meetingId = params?.[0];
    if (meetingId) {
      const meeting = store.byId("meetings", meetingId);
      if (meeting) { renderDetail(root, meeting); return; }
      root.appendChild(el("div", { class: "pm-back-row" }, backButton()));
      root.appendChild(el("div", { class: "card" },
        emptyState({ icon: "🔍", title: "会議が見つかりませんでした", hint: "一覧から選び直してください" })));
      return;
    }
    renderList(root);
  },
};
