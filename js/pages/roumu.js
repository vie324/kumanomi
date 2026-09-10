/* ============================================================
   始末書・業務改善書(労務)

   ・誰でも自分の名前で提出できる(下書き → 提出)
   ・読めるのは本人と、組織図で上にいる人(+本部人事・社長)
   ・上の人は内容を確認して「確認済み」にできる(本文は書き換えられない)
   ・提出すると直属の上司にチャットで知らせが届く

   項目は会社の書式に合わせる:
     種類(業務改善書 / 始末書)/ 発生日 / 結論・結果 / 原因 /
     詳細な過程 / 最悪の場合どうなっていたか(仮定でも可)/
     何をどのようにすれば防げたか(改善点)
   ============================================================ */
import {
  el, clear, icon, badge, card, sectionHeader, tabs, segmented, statTile,
  emptyState, modal, confirmDialog, toast, fmtDate, relTime, staffChip,
} from "../ui.js";
import { store, todayStr } from "../store.js";
import { canSeeStaff, rankOf, chainOf } from "../auth.js";
import { ensureDmRoom } from "../taskalerts.js";

const KIND = {
  kaizen: { label: "業務改善書", emoji: "📝", kind: "brand", desc: "ミスやヒヤリハットを、責めるためではなく仕組みを直すために残すもの" },
  shimatsu: { label: "始末書", emoji: "📄", kind: "critical", desc: "会社や患者様に迷惑をかけた事案について、経緯と反省・再発防止を正式に提出するもの" },
};
const STATUS = {
  draft: ["下書き", "warn"],
  submitted: ["提出済(確認待ち)", "brand"],
  acknowledged: ["確認済", "good"],
};

const FIELDS = [
  { key: "conclusion", label: "結論・結果", hint: "何が起きたか、結果としてどうなったかを短く", rows: 2 },
  { key: "cause", label: "原因", hint: "直接の原因と、その背景にあったこと", rows: 3 },
  { key: "processDetail", label: "詳細な過程", hint: "時系列で、誰が・いつ・何をしたか", rows: 5 },
  { key: "worstCase", label: "最悪の場合どうなっていたか(仮定でも構いません)", hint: "起こり得た最悪の結果を想像して書く", rows: 3 },
  { key: "prevention", label: "何をどのようにすれば防げたのか(改善点)", hint: "自分の行動と、仕組みの両方から", rows: 4 },
];

function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${todayStr()}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 自分が「上の人」として読める報告か(本人のものは除く) */
function canReview(r, me) {
  if (!r || r.authorId === me.id) return false;
  if (["hr", "ceo"].includes(rankOf(me))) return true;
  return canSeeStaff(r.authorId, me);
}

export default {
  id: "roumu",
  title: "始末書・改善書",
  icon: "report",

  // このページが必要とするデータ。ルーターがそろえてから render() を呼ぶ
  needs: ["chatMessages", "chatRooms", "incidentReports", "staff", "stores"],
  render(root, params = []) {
    const me = store.me();
    const state = { tab: "mine", focusId: params[0] || null };

    const all = () => store.get("incidentReports") || [];
    const mine = () => all().filter((r) => r.authorId === me.id).sort(byNewest);
    // 上の人として読めるもの。下書きは本人以外に見せない
    const reviewable = () => all().filter((r) => canReview(r, me) && r.status !== "draft").sort(byNewest);
    const byNewest = (a, b) => ((a.submittedAt || a.occurredOn) < (b.submittedAt || b.occurredOn) ? 1 : -1);

    if (state.focusId) {
      const r = store.byId("incidentReports", state.focusId);
      if (r && r.authorId !== me.id) state.tab = "review";
    }

    /* ================= 描画 ================= */
    function draw() {
      clear(root);
      const rev = reviewable();
      const waiting = rev.filter((r) => r.status === "submitted");
      const showReview = rev.length > 0 || ["hr", "ceo"].includes(rankOf(me)) || store.get("staff").some((s) => s.reportsTo === me.id);

      root.appendChild(sectionHeader(
        "始末書・業務改善書",
        "ミスや事故を記録して、同じことを繰り返さない仕組みにつなげます。提出した内容は本人と、組織図で上にいる人だけが読めます。",
        [el("button", { class: "btn primary", onclick: () => openForm() }, icon("plus", 16), "提出する")]));

      const myDrafts = mine().filter((r) => r.status === "draft").length;
      root.appendChild(el("div", { class: "kpi-row rm-kpi" },
        statTile({ label: "自分の提出", value: `${mine().filter((r) => r.status !== "draft").length}件`, icon: "report", tone: "brand", sub: myDrafts ? `下書き ${myDrafts}件` : "下書きはありません" }),
        showReview
          ? statTile({ label: "確認待ち(部下・メンバー)", value: `${waiting.length}件`, icon: "eye", tone: waiting.length ? "warn" : "good", sub: waiting.length ? "内容を確認して「確認済み」にしてください" : "確認待ちはありません" })
          : statTile({ label: "読める人", value: "上司のみ", icon: "eye", tone: "accent", sub: "組織図で上にいる人と本部人事・社長だけが読めます" }),
        statTile({ label: "種類", value: "2つ", icon: "clipboard", tone: "accent", sub: "業務改善書 / 始末書 を選んで提出" })));

      const items = [{ id: "mine", label: "自分の提出", badge: mine().length || null }];
      if (showReview) items.push({ id: "review", label: "確認する", badge: waiting.length || null });
      if (!items.some((i) => i.id === state.tab)) state.tab = "mine";
      root.appendChild(tabs(items, state.tab, (id) => { state.tab = id; draw(); }));

      if (state.tab === "mine") drawMine();
      else drawReview();

      root.appendChild(el("div", { class: "rm-guide card" },
        el("div", { class: "rm-guide-title" }, icon("sparkle", 16), "書き方のポイント"),
        el("ul", {},
          el("li", {}, el("strong", {}, "業務改善書"), ":", KIND.kaizen.desc, "。小さなミスやヒヤリハットも歓迎です。"),
          el("li", {}, el("strong", {}, "始末書"), ":", KIND.shimatsu.desc, "。"),
          el("li", {}, "「最悪の場合」は仮定で構いません。想像することで、対策の優先度がはっきりします。"),
          el("li", {}, "提出すると直属の上司にチャットで知らせが届き、確認されると「確認済」になります。提出後の本文は変更できません。"))));

      if (state.focusId) {
        const r = store.byId("incidentReports", state.focusId);
        state.focusId = null;
        if (r) openDetail(r);
      }
    }

    function drawMine() {
      const rows = mine();
      root.appendChild(card({
        title: "自分の提出",
        sub: "下書きは自分だけに見えます。提出すると上司が読めるようになります",
        body: rows.length
          ? el("div", { class: "rm-list" }, rows.map((r) => reportRow(r, { showAuthor: false })))
          : emptyState({ icon: "📝", title: "まだ提出はありません", hint: "「提出する」から業務改善書・始末書を書けます" }),
      }));
    }

    function drawReview() {
      const rows = reviewable();
      root.appendChild(card({
        title: "確認する",
        sub: "組織図であなたの下にいるメンバーの提出。内容を確認したら「確認済み」にしてください",
        body: rows.length
          ? el("div", { class: "rm-list" }, rows.map((r) => reportRow(r, { showAuthor: true })))
          : emptyState({ icon: "🌿", title: "確認する提出はありません", hint: "メンバーが提出すると、ここに並びます" }),
      }));
    }

    function reportRow(r, { showAuthor }) {
      const k = KIND[r.kind] || KIND.kaizen;
      const [sl, sk] = STATUS[r.status] || STATUS.draft;
      return el("button", { class: `rm-row ${r.status}`, onclick: () => openDetail(r) },
        el("span", { class: `rm-kind ${r.kind}` }, k.emoji),
        el("span", { class: "rm-main" },
          el("span", { class: "rm-line1" },
            badge(k.label, k.kind),
            badge(sl, sk),
            el("span", { class: "rm-date" }, `発生 ${fmtDate(r.occurredOn)}`)),
          el("span", { class: "rm-title" }, r.conclusion || "(結論が未記入)"),
          el("span", { class: "rm-sub" },
            showAuthor ? `${store.staffName(r.authorId)}(${store.storeName(store.byId("staff", r.authorId)?.storeId)})・` : "",
            r.status === "draft" ? "下書き" : `提出 ${relTime(r.submittedAt)}`,
            r.status === "acknowledged" ? `・${store.staffName(r.acknowledgedBy)}が確認` : "")),
        icon("chevR", 15));
    }

    /* ================= 詳細 ================= */
    function openDetail(r) {
      const k = KIND[r.kind] || KIND.kaizen;
      const [sl, sk] = STATUS[r.status] || STATUS.draft;
      const isAuthor = r.authorId === me.id;
      const reviewer = canReview(r, me);
      const actions = [];

      if (isAuthor && r.status === "draft") {
        actions.push(el("button", { class: "btn ghost", onclick: async () => {
          const ok = await confirmDialog({ title: "下書きを削除", message: "この下書きを削除します。", okLabel: "削除する", danger: true });
          if (!ok) return;
          store.remove("incidentReports", r.id); m.close(); toast("下書きを削除しました", "info"); draw();
        } }, icon("trash", 14), "削除"));
        actions.push(el("button", { class: "btn primary", onclick: () => { m.close(); openForm(r); } }, icon("edit", 14), "編集して提出"));
      }
      if (reviewer && r.status === "submitted") {
        const ackIn = el("textarea", { class: "textarea", rows: 2, placeholder: "ひとこと(任意)。例)共有ありがとう。朝礼で周知します" });
        actions.push(el("button", { class: "btn primary", onclick: () => {
          store.update("incidentReports", r.id, { status: "acknowledged", acknowledgedBy: me.id, acknowledgedAt: nowIso(), ackComment: ackIn.value.trim() });
          notifyAck(r, ackIn.value.trim());
          m.close(); toast("確認済みにしました"); draw();
        } }, icon("check", 14), "確認済みにする"));
        r._ackIn = ackIn;
      }

      const sections = FIELDS.map((f) => el("div", { class: "rm-sec" },
        el("div", { class: "rm-sec-label" }, f.label),
        el("div", { class: "rm-sec-body" }, r[f.key] || el("span", { class: "muted" }, "(未記入)"))));

      const body = el("div", { class: "page-roumu rm-detail" },
        el("div", { class: "rm-detail-head" },
          badge(`${k.emoji} ${k.label}`, k.kind), badge(sl, sk),
          el("span", { class: "small muted" }, `発生日 ${fmtDate(r.occurredOn, { withYear: true })}`)),
        el("div", { class: "rm-detail-who" },
          staffChip(r.authorId, { size: 30 }),
          r.submittedAt ? el("span", { class: "small muted" }, `提出 ${fmtDate(r.submittedAt.slice(0, 10), { withYear: true })}`) : null),
        ...sections,
        r.status === "acknowledged"
          ? el("div", { class: "rm-ack" },
              el("div", { class: "rm-ack-head" }, icon("check", 14), `${store.staffName(r.acknowledgedBy)}が確認しました`,
                el("span", { class: "small muted" }, relTime(r.acknowledgedAt))),
              r.ackComment ? el("div", { class: "rm-ack-body" }, r.ackComment) : null)
          : null,
        r._ackIn ? el("div", { class: "field" }, el("label", {}, "確認のひとこと"), r._ackIn) : null,
        !isAuthor && !reviewer ? null : el("p", { class: "small muted" },
          isAuthor ? "この内容は、あなたと組織図で上にいる人(本部人事・社長を含む)だけが読めます。" : "本文は本人だけが書けます。上の人ができるのは確認と、ひとことの返信です。"));
      delete r._ackIn;

      const closeBtn = el("button", { class: "btn ghost" }, "閉じる");
      const m = modal({ title: `${k.label}の内容`, body, actions: [closeBtn, ...actions], wide: true });
      closeBtn.addEventListener("click", () => m.close());
    }

    /* ================= 提出フォーム ================= */
    function openForm(existing = null) {
      let kind = existing?.kind || "kaizen";
      const kindWrap = el("div", {});
      const kindDesc = el("p", { class: "small muted rm-kind-desc" }, KIND[kind].desc);
      const paintKind = () => {
        clear(kindWrap).appendChild(segmented(
          Object.entries(KIND).map(([id, k]) => ({ id, label: `${k.emoji} ${k.label}` })),
          kind,
          (id) => { kind = id; kindDesc.textContent = KIND[id].desc; paintKind(); }));
      };
      paintKind();

      const dateIn = el("input", { class: "input", type: "date", value: existing?.occurredOn || todayStr(), max: todayStr() });
      const inputs = {};
      const fieldNodes = FIELDS.map((f) => {
        const ta = el("textarea", { class: "textarea", rows: f.rows, placeholder: f.hint });
        ta.value = existing?.[f.key] || "";
        inputs[f.key] = ta;
        return el("div", { class: "field" }, el("label", {}, f.label), ta);
      });

      const collect = () => {
        const out = { kind, occurredOn: dateIn.value || todayStr() };
        for (const f of FIELDS) out[f.key] = inputs[f.key].value.trim();
        return out;
      };

      const saveDraft = () => {
        const data = collect();
        if (existing) store.update("incidentReports", existing.id, data);
        else store.add("incidentReports", { ...data, authorId: me.id, status: "draft", submittedAt: null, acknowledgedBy: null, acknowledgedAt: null, ackComment: "" });
        m.close(); toast("下書きを保存しました"); draw();
      };

      const submit = async () => {
        const data = collect();
        const missing = FIELDS.filter((f) => !data[f.key]);
        if (missing.length) { toast(`「${missing[0].label}」を記入してください`, "error"); return; }
        const ok = await confirmDialog({
          title: `${KIND[kind].label}を提出`,
          message: "提出すると本文は変更できなくなり、組織図で上にいる人が読めるようになります。直属の上司にはチャットで知らせが届きます。よろしいですか?",
          okLabel: "提出する",
        });
        if (!ok) return;
        const patch = { ...data, status: "submitted", submittedAt: nowIso() };
        const saved = existing
          ? store.update("incidentReports", existing.id, patch)
          : store.add("incidentReports", { ...patch, authorId: me.id, acknowledgedBy: null, acknowledgedAt: null, ackComment: "" });
        notifySubmitted(saved);
        m.close();
        toast(`${KIND[kind].label}を提出しました`);
        draw();
      };

      const draftBtn = el("button", { class: "btn ghost", onclick: saveDraft }, "下書き保存");
      const submitBtn = el("button", { class: "btn primary", onclick: submit }, icon("send", 15), "提出する");
      const m = modal({
        title: existing ? "下書きを編集" : "業務改善書・始末書を提出",
        wide: true,
        body: el("div", { class: "page-roumu rm-form" },
          el("div", { class: "field" }, el("label", {}, "種類"), kindWrap, kindDesc),
          el("div", { class: "field rm-date" }, el("label", {}, "発生日"), dateIn),
          ...fieldNodes,
          el("p", { class: "small muted" }, "すべての項目を記入して提出してください。途中で保存したい場合は「下書き保存」(自分にだけ見えます)。")),
        actions: [draftBtn, submitBtn],
      });
    }

    /* ================= チャットへの知らせ ================= */
    function notifySubmitted(r) {
      if (!r) return;
      const boss = chainOf(me.id)[0];
      if (!boss) return;
      const room = ensureDmRoom(me.id, boss.id);
      if (!room) return;
      store.add("chatMessages", {
        roomId: room.id, authorId: me.id, date: nowIso(),
        text: `📄 @${boss.name} ${KIND[r.kind].label}を提出しました(発生日 ${fmtDate(r.occurredOn, { withDow: false })})。「始末書・改善書」ページでご確認ください。`,
        mentions: [boss.id], reactions: {}, readBy: [me.id], replyToId: null, attachment: null, edited: false,
      });
    }

    function notifyAck(r, comment) {
      const room = ensureDmRoom(me.id, r.authorId);
      if (!room) return;
      store.add("chatMessages", {
        roomId: room.id, authorId: me.id, date: nowIso(),
        text: `✅ @${store.staffName(r.authorId)} ${KIND[r.kind].label}(発生日 ${fmtDate(r.occurredOn, { withDow: false })})を確認しました。${comment ? `\n${comment}` : ""}`,
        mentions: [r.authorId], reactions: {}, readBy: [me.id], replyToId: null, attachment: null, edited: false,
      });
    }

    draw();
  },
};
