/* ============================================================
   タスクリスト — チャット・議事録で発生したタスクの受け皿。
   ・チャット:メッセージの📋ボタンから「タスク化」
   ・議事録:アクションアイテムの「タスクへ」ボタンから連携
   ・手動追加もここから。未着手→進行中→完了で管理する
   閲覧範囲:自分が担当/自分が作成したタスク+配下(canSeeStaff)のタスク
   ============================================================ */
import {
  el, clear, icon, avatar, badge, card, sectionHeader, tabs, statTile,
  staffChip, emptyState, modal, toast, fmtDate, relTime,
} from "../ui.js";
import { store, todayStr, addDays } from "../store.js";
import { canSeeStaff, rankLevel } from "../auth.js";
import { router } from "../router.js";
import { AUTO_SOURCE_LINK } from "../autotasks.js";

const STATUS_NEXT = { todo: "doing", doing: "done", done: "todo" };
const STATUS_LABEL = { todo: "未着手", doing: "進行中", done: "完了" };
const SOURCE_META = {
  chat: { emoji: "💬", label: "チャット" },
  meeting: { emoji: "📋", label: "議事録" },
  manual: { emoji: "✍️", label: "手動" },
  nippo: { emoji: "📓", label: "日報(毎日)" },
  uriage: { emoji: "📊", label: "売上報告(毎日)" },
  inventory: { emoji: "📦", label: "在庫アラート" },
  expense: { emoji: "🧾", label: "経費申請" },
  kintai: { emoji: "⏰", label: "勤怠の承認" },
  shift: { emoji: "🗓", label: "希望休の提出" },
  order: { emoji: "🚚", label: "発注の追跡" },
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
        : state.filter === "auto" ? arr.filter((t) => t.auto && t.status !== "done")
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
      const kind = t.source?.kind;
      if (!kind) return;
      if (kind === "chat") router.navigate(`chat/${t.source.refId}`);
      else if (kind === "meeting") router.navigate(`meetings/${t.source.refId}`);
      else if (AUTO_SOURCE_LINK[kind]) router.navigate(AUTO_SOURCE_LINK[kind](t));
    }

    /* ---------------- タスクの振り分け ---------------- */
    function openAssignModal(t) {
      const current = store.byId("staff", t.ownerId);
      const candidates = store.get("staff").filter((s) => s.id !== t.ownerId);
      const ownerSel = el("select", { class: "select" },
        candidates.map((s) => el("option", { value: s.id },
          `${s.name}(${store.storeName(s.storeId)}・${s.role})`)));
      const noteIn = el("textarea", {
        class: "textarea", rows: 2,
        placeholder: "引き継ぎのひとこと(任意)。例)本日不在のためお願いします",
      });

      const log = t.assignLog || [];
      const history = log.length
        ? el("div", { class: "tk-assign-log" },
            el("div", { class: "tk-assign-loghead" }, icon("refresh", 13), "振り分けの履歴"),
            log.slice().reverse().map((h) => el("div", { class: "tk-assign-logitem" },
              el("span", { class: "tk-assign-names" },
                store.staffName(h.from), icon("chevR", 12), el("b", {}, store.staffName(h.to))),
              el("span", { class: "small muted" },
                `${store.staffName(h.by)}が変更・${relTime(h.at)}`),
              h.note ? el("span", { class: "tk-assign-note" }, h.note) : null)))
        : null;

      const okBtn = el("button", { class: "btn primary" }, icon("send", 15), "この人に振り分ける");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: "タスクを振り分ける",
        body: el("div", { class: "page-tasks tk-modal" },
          el("div", { class: "tk-assign-task" },
            el("div", { class: "tk-assign-title" }, t.title),
            t.due ? el("span", { class: "small muted" }, `期限 ${fmtDate(t.due)}`) : null),
          el("div", { class: "tk-assign-from" },
            el("span", { class: "small muted" }, "現在の担当"),
            el("span", { class: "flex", style: { gap: "8px", alignItems: "center" } },
              avatar(current, 28),
              el("b", {}, current?.name || "—"),
              el("span", { class: "small muted" }, current ? `${store.storeName(current.storeId)}・${current.role}` : ""))),
          el("div", { class: "field" }, el("label", {}, "新しい担当者"), ownerSel),
          el("div", { class: "field" }, el("label", {}, "引き継ぎメモ"), noteIn),
          t.auto
            ? el("div", { class: "tk-assign-hint" }, icon("info", 14),
                "自動で追加されたタスクです。振り分けると、以後この担当のままになります(自動で戻りません)。")
            : null,
          history),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", () => m.close());
      okBtn.addEventListener("click", () => {
        const toId = ownerSel.value;
        if (!toId) { toast("担当者を選んでください", "error"); return; }
        store.update("tasks", t.id, {
          ownerId: toId,
          reassigned: true,
          assignLog: [...(t.assignLog || []), {
            from: t.ownerId, to: toId, by: me.id,
            at: new Date().toISOString(), note: noteIn.value.trim(),
          }],
        });
        m.close();
        toast(`「${t.title}」を ${store.staffName(toId)} さんに振り分けました`);
        draw();
      });
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
      const kind = t.source?.kind;
      const meta = SOURCE_META[kind] || SOURCE_META.manual;
      const clickable = kind === "chat" || kind === "meeting" || !!AUTO_SOURCE_LINK[kind];
      return el(clickable ? "button" : "span", {
        class: `tk-source ${clickable ? "link" : ""}`,
        title: clickable ? `${meta.label}の画面を開く` : meta.label,
        onclick: clickable ? (e) => { e.stopPropagation(); openSource(t); } : null,
      }, `${meta.emoji} ${t.source?.label || meta.label}`);
    }

    function taskRow(t) {
      // 自動タスクは条件が解消すると自動で消えるため、手で削除させない
      const mayDelete = !t.auto && (t.createdBy === me.id || t.ownerId === me.id || rankLevel(me) >= 3);
      const lastAssign = (t.assignLog || []).slice(-1)[0];
      return el("div", { class: `tk-row ${t.status === "done" ? "done" : ""} ${t.auto ? "auto" : ""}` },
        statusBtn(t),
        el("div", { class: "tk-main" },
          el("div", { class: "tk-title" },
            t.title,
            t.auto ? el("span", { class: "tk-autotag", title: "業務の状況から自動で追加されたタスクです" }, "自動") : null),
          t.note ? el("div", { class: "tk-note" }, t.note) : null,
          el("div", { class: "tk-meta" },
            sourceChip(t),
            staffChip(t.ownerId, { size: 20, withRole: false }),
            t.due ? el("span", { class: "tk-due" }, icon("calendar", 12), `期限 ${fmtDate(t.due)}`) : null,
            isOverdue(t) ? badge("期限超過", "critical") : null,
            lastAssign ? el("span", { class: "tk-reassigned", title: `${store.staffName(lastAssign.from)} から振り分け${lastAssign.note ? `:${lastAssign.note}` : ""}` },
              icon("refresh", 11), `${store.staffName(lastAssign.from)}から`) : null)),
        el("div", { class: "tk-ops" },
          el("button", {
            class: "icon-btn sm", title: "担当を振り分ける", "aria-label": "タスクを振り分ける",
            onclick: () => openAssignModal(t),
          }, icon("users", 14)),
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

      const autoMine = openMine.filter((t) => t.auto).length;

      root.appendChild(sectionHeader(
        "タスク",
        "チャットや議事録から飛ばしたタスクに加えて、業務のなかで発生したタスク(発注・承認待ち・日報など)が自動で積まれます。担当の振り分けもここから行えます。",
        [el("button", { class: "btn primary", onclick: () => openTaskModal() }, icon("plus", 16), "タスクを追加")]));

      root.appendChild(el("div", { class: "kpi-row" },
        statTile({ label: "自分の未完了", value: `${openMine.length}件`, icon: "clipboard", tone: "brand", sub: `全${mine.length}件中` }),
        statTile({ label: "今日が期限", value: `${dueToday}件`, icon: "clock", tone: dueToday ? "warn" : "good", sub: dueToday ? "今日中に対応しましょう" : "本日期限はありません" }),
        statTile({ label: "期限超過", value: `${overdue}件`, icon: "alert", tone: overdue ? "warn" : "good", sub: overdue ? "早めのリスケを" : "遅延はありません" }),
        statTile({ label: "自動で追加", value: `${autoMine}件`, icon: "sparkle", tone: autoMine ? "accent" : "good", sub: autoMine ? "在庫・承認待ち・日報など" : "自動タスクはありません" })));

      const showTeam = team.length > mine.length || rankLevel(me) >= 2;
      const items = [{ id: "mine", label: "自分のタスク", badge: openMine.length || null }];
      if (showTeam) items.push({ id: "team", label: "チームのタスク", badge: team.filter((t) => t.status !== "done").length || null });
      if (!items.some((i) => i.id === state.tab)) state.tab = "mine";
      root.appendChild(tabs(items, state.tab, (id) => { state.tab = id; draw(); }));

      const filterSeg = el("div", { class: "tk-filters" },
        [["open", "未完了"], ["auto", "自動で追加"], ["all", "すべて"], ["done", "完了"]].map(([id, label]) =>
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
          el("strong", {}, "タスクの入口は4つ:"),
          "①チャットのメッセージにマウスを乗せて📋「タスクリストに追加」 ②議事録のアクションアイテムの「タスクへ」 ③この画面の「タスクを追加」 ④",
          el("strong", {}, "業務からの自動追加"),
          "(在庫の発注点割れ・経費や勤怠の承認待ち・日報や売上報告の未提出・希望休の締切・入荷待ちの追跡)。自動タスクは対応が終わると自動で消えます。",
          el("br"),
          el("strong", {}, "振り分け:"),
          "各タスクの👥ボタンから別のスタッフへ担当を変更できます(引き継ぎメモと履歴が残ります)。")));
    }

    draw();
  },
};
