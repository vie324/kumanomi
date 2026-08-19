/* ============================================================
   タスクリスト — チャット・議事録で発生したタスクの受け皿。
   ・チャット:メッセージの📋ボタンから「タスク化」
   ・議事録:アクションアイテムの「タスクへ」ボタンから連携
   ・手動追加もここから。未着手→進行中→完了で管理する
   閲覧範囲:自分が担当/自分が作成したタスク+配下(canSeeStaff)のタスク
   ============================================================ */
import {
  el, clear, icon, badge, card, sectionHeader, tabs, statTile,
  staffChip, emptyState, modal, toast, fmtDate,
} from "../ui.js";
import { store, todayStr, addDays } from "../store.js";
import { canSeeStaff, rankLevel } from "../auth.js";
import { router } from "../router.js";

const STATUS_NEXT = { todo: "doing", doing: "done", done: "todo" };
const STATUS_LABEL = { todo: "未着手", doing: "進行中", done: "完了" };
const SOURCE_META = {
  chat: { emoji: "💬", label: "チャット" },
  meeting: { emoji: "📋", label: "議事録" },
  manual: { emoji: "✍️", label: "手動" },
  nippo: { emoji: "📓", label: "日報(毎日)" },
};

const isOverdue = (t) => !!t.due && t.due < todayStr() && t.status !== "done";

export default {
  id: "tasks",
  title: "タスク",
  icon: "check",

  render(root) {
    const me = store.me();
    const state = { tab: "mine", filter: "open" };

    /* ---------------- データアクセス ---------------- */
    const all = () => store.get("tasks") || [];
    /** 自分に見えるタスク:担当が自分/作成が自分/担当が配下・メンティー */
    const visibleTasks = () => all().filter((t) =>
      t.ownerId === me.id || t.createdBy === me.id || canSeeStaff(t.ownerId));
    const myTasks = () => all().filter((t) => t.ownerId === me.id);

    const sortTasks = (arr) => [...arr].sort((a, b) => {
      const pa = a.status === "done" ? 1 : 0;
      const pb = b.status === "done" ? 1 : 0;
      if (pa !== pb) return pa - pb;
      return (a.due || "9999-99-99") < (b.due || "9999-99-99") ? -1 : 1;
    });

    const applyFilter = (arr) =>
      state.filter === "open" ? arr.filter((t) => t.status !== "done")
        : state.filter === "done" ? arr.filter((t) => t.status === "done")
        : arr;

    /* ---------------- 操作 ---------------- */
    function cycleStatus(t) {
      const next = STATUS_NEXT[t.status] || "todo";
      store.update("tasks", t.id, { status: next });
      if (next === "done") toast(`「${t.title}」を完了にしました 🎉`);
      draw();
    }

    function removeTask(t) {
      store.remove("tasks", t.id);
      toast("タスクを削除しました", "info");
      draw();
    }

    function openSource(t) {
      if (!t.source) return;
      if (t.source.kind === "chat") router.navigate(`chat/${t.source.refId}`);
      else if (t.source.kind === "meeting") router.navigate(`meetings/${t.source.refId}`);
      else if (t.source.kind === "nippo") router.navigate("nippo");
    }

    /* ---------------- 新規・編集モーダル ---------------- */
    function openTaskModal(existing = null) {
      const owners = store.get("staff");
      const titleIn = el("input", { class: "input", placeholder: "例)LINE配信文面のレビュー" });
      titleIn.value = existing?.title || "";
      const ownerSel = el("select", { class: "select" },
        owners.map((s) => el("option", {
          value: s.id,
          selected: s.id === (existing?.ownerId || me.id),
        }, `${s.name}(${store.storeName(s.storeId)}・${s.role})`)));
      const dueIn = el("input", { class: "input", type: "date", value: existing?.due || addDays(todayStr(), 3) });
      const noteIn = el("textarea", { class: "textarea", rows: 3, placeholder: "補足メモ(任意)" });
      noteIn.value = existing?.note || "";

      const okBtn = el("button", { class: "btn primary" }, icon("check", 15), existing ? "保存する" : "タスクを追加");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: existing ? "タスクを編集" : "タスクを追加",
        body: el("div", { class: "page-tasks tk-modal" },
          el("div", { class: "field" }, el("label", {}, "タスクの内容"), titleIn),
          el("div", { class: "form-row" },
            el("div", { class: "field" }, el("label", {}, "担当者"), ownerSel),
            el("div", { class: "field" }, el("label", {}, "期限"), dueIn)),
          el("div", { class: "field" }, el("label", {}, "メモ"), noteIn)),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", () => m.close());
      okBtn.addEventListener("click", () => {
        const title = titleIn.value.trim();
        if (!title) { toast("タスクの内容を入力してください", "error"); return; }
        if (existing) {
          store.update("tasks", existing.id, {
            title, ownerId: ownerSel.value, due: dueIn.value || null, note: noteIn.value.trim(),
          });
          toast("タスクを更新しました");
        } else {
          store.add("tasks", {
            title,
            note: noteIn.value.trim(),
            ownerId: ownerSel.value,
            createdBy: me.id,
            due: dueIn.value || null,
            status: "todo",
            source: { kind: "manual", refId: null, label: "手動追加" },
            createdAt: todayStr(),
          });
          toast(`タスクを追加しました(担当:${store.staffName(ownerSel.value)})`);
        }
        m.close();
        draw();
      });
    }

    /* ---------------- 行の描画 ---------------- */
    function statusBtn(t) {
      return el("button", {
        class: `tk-st ${t.status}`,
        title: "クリックで 未着手 → 進行中 → 完了 を切替",
        onclick: (e) => { e.stopPropagation(); cycleStatus(t); },
      },
        t.status === "done" ? icon("check", 13) : null,
        STATUS_LABEL[t.status] || t.status);
    }

    function sourceChip(t) {
      const meta = SOURCE_META[t.source?.kind] || SOURCE_META.manual;
      const clickable = ["chat", "meeting", "nippo"].includes(t.source?.kind);
      return el(clickable ? "button" : "span", {
        class: `tk-source ${clickable ? "link" : ""}`,
        title: t.source?.kind === "nippo" ? "日報ページを開く"
          : clickable ? `${meta.label}「${t.source?.label || ""}」を開く` : meta.label,
        onclick: clickable ? (e) => { e.stopPropagation(); openSource(t); } : null,
      }, `${meta.emoji} ${t.source?.label || meta.label}`);
    }

    function taskRow(t) {
      const mayDelete = t.createdBy === me.id || t.ownerId === me.id || rankLevel(me) >= 3;
      return el("div", { class: `tk-row ${t.status === "done" ? "done" : ""}` },
        statusBtn(t),
        el("div", { class: "tk-main" },
          el("div", { class: "tk-title" }, t.title),
          t.note ? el("div", { class: "tk-note" }, t.note) : null,
          el("div", { class: "tk-meta" },
            sourceChip(t),
            staffChip(t.ownerId, { size: 20, withRole: false }),
            t.due ? el("span", { class: "tk-due" }, icon("calendar", 12), `期限 ${fmtDate(t.due)}`) : null,
            isOverdue(t) ? badge("期限超過", "critical") : null)),
        el("div", { class: "tk-ops" },
          el("button", {
            class: "icon-btn sm", title: "編集", "aria-label": "タスクを編集",
            onclick: () => openTaskModal(t),
          }, icon("edit", 14)),
          mayDelete ? el("button", {
            class: "icon-btn sm", title: "削除", "aria-label": "タスクを削除",
            onclick: () => removeTask(t),
          }, icon("trash", 14)) : null));
    }

    /* ---------------- 描画 ---------------- */
    function draw() {
      clear(root);

      const mine = myTasks();
      const team = visibleTasks();
      const openMine = mine.filter((t) => t.status !== "done");
      const dueToday = openMine.filter((t) => t.due === todayStr()).length;
      const overdue = openMine.filter(isOverdue).length;

      root.appendChild(sectionHeader(
        "タスク",
        "チャットのメッセージ(📋ボタン)や議事録のアクション(「タスクへ」)から飛ばしたタスクを、ここで一元管理します。",
        [el("button", { class: "btn primary", onclick: () => openTaskModal() }, icon("plus", 16), "タスクを追加")]));

      root.appendChild(el("div", { class: "kpi-row" },
        statTile({ label: "自分の未完了", value: `${openMine.length}件`, icon: "clipboard", tone: "brand", sub: `全${mine.length}件中` }),
        statTile({ label: "今日が期限", value: `${dueToday}件`, icon: "clock", tone: dueToday ? "warn" : "good", sub: dueToday ? "今日中に対応しましょう" : "本日期限はありません" }),
        statTile({ label: "期限超過", value: `${overdue}件`, icon: "alert", tone: overdue ? "warn" : "good", sub: overdue ? "早めのリスケを" : "遅延はありません" }),
        statTile({ label: "チームの未完了", value: `${team.filter((t) => t.status !== "done").length}件`, icon: "users", tone: "accent", sub: "閲覧範囲内の合計" })));

      const showTeam = team.length > mine.length || rankLevel(me) >= 2;
      const items = [{ id: "mine", label: "自分のタスク", badge: openMine.length || null }];
      if (showTeam) items.push({ id: "team", label: "チームのタスク", badge: team.filter((t) => t.status !== "done").length || null });
      if (!items.some((i) => i.id === state.tab)) state.tab = "mine";
      root.appendChild(tabs(items, state.tab, (id) => { state.tab = id; draw(); }));

      const filterSeg = el("div", { class: "tk-filters" },
        [["open", "未完了"], ["all", "すべて"], ["done", "完了"]].map(([id, label]) =>
          el("button", {
            class: `chip ${state.filter === id ? "on" : ""}`,
            onclick: () => { state.filter = id; draw(); },
          }, label)));
      root.appendChild(filterSeg);

      const base = state.tab === "mine" ? mine : team;
      const rows = sortTasks(applyFilter(base));

      root.appendChild(card({
        title: state.tab === "mine" ? "自分のタスク" : "チームのタスク",
        sub: state.tab === "mine"
          ? "担当が自分のタスク"
          : "自分+配下・メンティー・自分が作成したタスク",
        body: rows.length
          ? el("div", { class: "tk-list" }, rows.map(taskRow))
          : emptyState({
              icon: "✅",
              title: state.filter === "done" ? "完了したタスクはありません" : "タスクはありません",
              hint: "チャットの📋ボタンや議事録の「タスクへ」からも追加できます",
            }),
      }));

      root.appendChild(el("div", { class: "tk-hint card" },
        el("span", { class: "tk-hint-ic" }, icon("sparkle", 16)),
        el("span", {},
          el("strong", {}, "タスクの入口は3つ:"),
          "①チャットのメッセージにマウスを乗せて📋「タスクリストに追加」 ②議事録のアクションアイテムの「タスクへ」 ③この画面の「タスクを追加」")));
    }

    draw();
  },
};
