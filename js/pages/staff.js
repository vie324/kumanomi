/* ============================================================
   スタッフ管理 — メンバー / テスト / 研修 / 評価 / 面談
   ・テスト問題はAIが自動作成し、実行度合い(受験状況)を可視化
   ・個人評価は日報・契約率・テスト結果から自動集計(手作業ゼロ)
   ・面談の走り書きメモはAIが構造化要約
   ============================================================ */
import {
  el, clear, icon, badge, avatar, card, sectionHeader, tabs, table, emptyState,
  staffChip, kv, fmtDate, toast, aiButton, aiPanel, meter, modal, chip, segmented, celebrate,
  micButton,
} from "../ui.js";
import { radar } from "../charts.js";
import { store, todayStr } from "../store.js";
import { makeTest, testTopics, summarizeInterview, sampleInterviewVoice } from "../ai.js";
import { can, canSeeStaff, rankLevel } from "../auth.js";
import { pointsOf } from "./sns.js";

/* ---------------- 共通ヘルパー ---------------- */

const PRACT_ROLES = ["院長", "柔道整復師", "鍼灸師"];
const practitioners = () => store.get("staff").filter((s) => PRACT_ROLES.includes(s.role));

/** その人の点数(テスト・スキルスコア・評価)を見られるか。
    一般社員は自分(+メンティー)のみ。院長以上は配下を閲覧できる。 */
const canViewScore = (staffId) => can("staff.viewScores", { staffId });

/** 点数が非公開のときのプレースホルダ */
function scoreLockNote(size = "sm") {
  return el("div", { class: `st-scorelock ${size}` },
    icon("eye", 14),
    el("span", {}, "点数は本人と責任者のみ閲覧できます"));
}

function skillsRadar(s, size = 150) {
  return radar({
    axes: Object.keys(s.skills || {}),
    values: [{ name: s.name, scores: Object.values(s.skills || {}), color: s.color }],
    size, max: 5,
  });
}

function endTime(start, durationMin) {
  if (!start) return "";
  const [h, m] = start.split(":").map(Number);
  const t = h * 60 + m + (Number(durationMin) || 0);
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function avatarStack(ids = [], size = 26, max = 6) {
  const shown = ids.slice(0, max);
  return el("div", { class: "avatar-stack" },
    shown.map((id) => avatar(store.byId("staff", id), size)),
    ids.length > max
      ? el("span", {
          class: "avatar st-more",
          style: { width: size + "px", height: size + "px", fontSize: Math.round(size * 0.36) + "px" },
        }, `+${ids.length - max}`)
      : null);
}

function scoreBadge(score) {
  return el("span", { class: "st-scorecell" },
    el("strong", { class: "mono-num" }, `${score}点`),
    score < 80 ? badge("要復習", "warn") : badge("合格", "good"));
}

const avgScore = (t) => (t.results.length
  ? Math.round(t.results.reduce((a, r) => a + r.score, 0) / t.results.length)
  : null);
const takenCount = (t) => new Set(t.results.map((r) => r.staffId)).size;

/* セクション見出し(モーダル内でも使用) */
const h4 = (text) => el("h4", { class: "st-h4" }, text);

/* ============================================================
   タブ 1:メンバー
   ============================================================ */

function membersView(body) {
  if (rankLevel(store.me()) < 3) {
    body.appendChild(el("div", { class: "st-note st-note-block" }, icon("eye", 15),
      el("span", {}, "スキルスコアやテストの点数は、", el("strong", {}, "本人と責任者(院長以上)のみ"), "が閲覧できます。")));
  }
  const grid = el("div", { class: "st-mgrid" });
  for (const s of store.get("staff")) {
    const open = () => openMemberModal(s);
    grid.appendChild(el("div", {
      class: "st-mcard", role: "button", tabindex: "0",
      onclick: open,
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } },
    },
      el("div", { class: "st-mtop" },
        avatar(s, 56),
        el("div", { class: "st-mname" },
          el("div", { class: "st-name" }, s.name),
          el("div", { class: "st-kana" }, s.kana))),
      el("div", { class: "st-mbadges" },
        badge(store.storeName(s.storeId), "brand"),
        badge(s.role),
        el("span", { class: "st-pts", title: "サンクスポイント" }, icon("gift", 13), `${pointsOf(s.id)}pt`)),
      el("div", { class: "st-mradar" },
        canViewScore(s.id) ? skillsRadar(s, 150) : scoreLockNote())));
  }
  body.appendChild(grid);
}

function openMemberModal(s) {
  const showScore = canViewScore(s.id);
  const history = store.get("tests")
    .flatMap((t) => t.results.filter((r) => r.staffId === s.id).map((r) => ({ test: t, r })))
    .sort((a, b) => (a.r.date < b.r.date ? 1 : -1));

  const historyBody = !showScore
    ? scoreLockNote()
    : history.length
      ? table({
          columns: [
            { key: "title", label: "テスト", render: (x) => el("span", { class: "st-cellwrap" }, x.test.title) },
            { key: "date", label: "受験日", render: (x) => el("span", { class: "mono-num small" }, fmtDate(x.r.date)) },
            { key: "score", label: "スコア", align: "right", render: (x) => scoreBadge(x.r.score) },
          ],
          rows: history,
        })
      : el("p", { class: "muted small" }, "テストの受験履歴はまだありません");

  const closeBtn = el("button", { class: "btn ghost" }, "閉じる");
  const m = modal({
    title: `メンバー詳細 — ${s.name}`,
    wide: true,
    body: el("div", { class: "page-staff" },
      el("div", { class: "st-detail" },
        el("div", { class: "st-detail-left" },
          el("div", { class: "st-detail-id" },
            avatar(s, 64),
            el("div", {},
              el("div", { class: "st-name" }, s.name),
              el("div", { class: "st-kana" }, s.kana),
              el("div", { class: "st-mbadges", style: { marginTop: "6px" } },
                badge(store.storeName(s.storeId), "brand"), badge(s.role)))),
          showScore ? skillsRadar(s, 250) : scoreLockNote("lg")),
        el("div", { class: "st-detail-right" },
          h4("基本情報"),
          kv("入社", fmtDate(s.joined, { withYear: true, withDow: false })),
          kv("保有資格", s.licenses?.length ? s.licenses.join("・") : "—"),
          kv("サンクスポイント", `${pointsOf(s.id)} pt`),
          showScore && Object.keys(s.skills || {}).length
            ? kv("スキル平均", (Object.values(s.skills).reduce((a, v) => a + v, 0) / Object.keys(s.skills).length).toFixed(1) + " / 5.0")
            : null,
          h4("テスト受験履歴"),
          historyBody))),
    actions: [closeBtn],
  });
  closeBtn.addEventListener("click", m.close);
}

/* ============================================================
   タブ 2:テスト
   ============================================================ */

function testsView(body, rerender) {
  const createBtn = can("staff.manageTests")
    ? aiButton("AIでテストを作成", async () => openCreateTestModal(rerender))
    : null;
  body.appendChild(el("div", { class: "st-toolrow" },
    el("div", { class: "st-note" }, icon("sparkle", 15),
      el("span", {}, "研修テーマからAIが問題・解説を自動作成します。受験結果は個人評価に自動反映されます。")),
    createBtn));

  const tests = [...store.get("tests")].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (!tests.length) {
    body.appendChild(el("div", { class: "card" },
      emptyState({ icon: "📝", title: "テストがありません", hint: "「AIでテストを作成」から追加できます" })));
    return;
  }
  const grid = el("div", { class: "grid cols-2" });
  tests.forEach((t) => grid.appendChild(testCard(t, rerender)));
  body.appendChild(grid);
}

function testCard(t, rerender) {
  const me = store.me();
  const canAllScores = rankLevel(me) >= 3;
  const avg = avgScore(t);
  const taken = takenCount(t);
  const total = t.assignedTo.length || 1;
  const myResult = t.results.find((r) => r.staffId === me.id);
  const assignedToMe = t.assignedTo.includes(me.id);

  // 一般社員には自分(+メンティー等、canSeeStaff の範囲)の点数だけを見せる
  const results = [...t.results]
    .filter((r) => canViewScore(r.staffId))
    .sort((a, b) => b.score - a.score);
  const hiddenN = t.results.length - results.length;
  const resultTable = results.length
    ? el("div", {},
        table({
          columns: [
            { key: "staff", label: "スタッフ", render: (r) => staffChip(r.staffId, { size: 26 }) },
            { key: "date", label: "受験日", render: (r) => el("span", { class: "mono-num small" }, fmtDate(r.date)) },
            { key: "score", label: "スコア", align: "right", render: (r) => scoreBadge(r.score) },
          ],
          rows: results,
        }),
        hiddenN > 0 ? el("p", { class: "small muted", style: { marginTop: "6px" } },
          `他 ${hiddenN}名の点数は非公開です(本人と責任者のみ閲覧できます)`) : null)
    : t.results.length
      ? scoreLockNote()
      : emptyState({ icon: "🗒", title: "まだ受験者がいません", hint: "「受験する」から回答できます" });

  const takeBtn = assignedToMe
    ? el("button", {
        class: `btn ${myResult ? "ghost" : "primary"}`,
        onclick: () => openTakeTestModal(t, rerender),
      }, icon("edit", 15), myResult ? "再受験する" : "受験する")
    : el("span", { class: "small muted" }, "このテストの対象外です");

  return card({
    class: "st-testcard",
    body: el("div", {},
      el("div", { class: "st-test-head" },
        el("div", { class: "st-test-title" }, t.title),
        el("span", { class: "badge brand st-aibadge" }, icon("sparkle", 12), "AI作成")),
      el("div", { class: "st-test-meta" },
        badge(t.topic),
        el("span", { class: "small muted" }, `${t.questions.length}問・作成 ${fmtDate(t.createdAt)}`)),
      el("div", { class: "st-test-stats" },
        el("div", { class: "st-avg" },
          el("div", { class: "st-avg-val" }, !canAllScores || avg == null ? "—" : avg,
            !canAllScores || avg == null ? null : el("span", { class: "st-avg-unit" }, "点")),
          el("div", { class: "st-avg-label" }, canAllScores ? "平均点" : "平均点(責任者のみ)")),
        meter({
          label: "受験状況",
          value: taken, max: total,
          fmt: (v, mx) => `${v}/${mx}名`,
          kind: taken / total < 0.5 ? "warn" : "",
        })),
      el("div", { class: "st-test-results" }, resultTable),
      el("div", { class: "st-test-foot" },
        takeBtn,
        myResult ? el("span", { class: "small muted" }, `あなたのスコア:${myResult.score}点(${fmtDate(myResult.date)})`) : null)),
  });
}

/* ---- AIテスト作成モーダル ---- */

function openCreateTestModal(rerender) {
  const topics = testTopics();
  let topic = topics[0];
  let count = 5;
  let generated = null;

  const topicRow = el("div", { class: "st-chiprow" });
  const drawTopics = () => {
    clear(topicRow);
    topics.forEach((tp) => topicRow.appendChild(chip(tp, { on: tp === topic, onClick: () => { topic = tp; drawTopics(); } })));
  };
  drawTopics();

  const segHolder = el("div", {});
  const drawSeg = () => {
    clear(segHolder).appendChild(segmented(
      [{ id: "3", label: "3問" }, { id: "5", label: "5問" }],
      String(count),
      (id) => { count = Number(id); drawSeg(); }));
  };
  drawSeg();

  const host = el("div", { class: "mt-12" });
  const panel = aiPanel("AIテスト作成");
  const saveBtn = el("button", { class: "btn primary", disabled: true }, icon("check", 15), "保存して割当");
  const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");

  const genBtn = aiButton("この条件で問題を生成", async () => {
    if (!host.contains(panel.el)) host.appendChild(panel.el);
    panel.thinking("研修資料と過去の出題傾向を分析しています");
    generated = await makeTest(topic, count);
    panel.setNode(testPreviewNode(generated));
    saveBtn.disabled = false;
  });

  const m = modal({
    title: "AIでテストを作成",
    wide: true,
    body: el("div", { class: "page-staff" },
      el("div", { class: "field" }, el("label", {}, "トピックを選択"), topicRow),
      el("div", { class: "field mt-12" }, el("label", {}, "問題数"), segHolder),
      el("div", { class: "st-ta-actions" }, genBtn),
      host),
    actions: [cancelBtn, saveBtn],
  });
  cancelBtn.addEventListener("click", m.close);
  saveBtn.addEventListener("click", () => {
    if (!generated) return;
    store.add("tests", {
      id: store.uid("ts"),
      title: generated.title,
      topic: generated.topic,
      createdBy: "AI",
      createdAt: todayStr(),
      assignedTo: practitioners().map((s) => s.id),
      questions: generated.questions,
      results: [],
    });
    m.close();
    toast("テストを保存し、施術者全員に割り当てました");
    rerender();
  });
}

function testPreviewNode(gen) {
  return el("div", {},
    el("div", { class: "st-prev-head" },
      el("strong", {}, gen.title),
      badge(`${gen.questions.length}問`, "brand")),
    el("ol", { class: "st-qlist" },
      gen.questions.map((q) => el("li", {},
        el("div", { class: "st-qtext" }, q.q),
        el("div", { class: "st-qchoices" },
          q.choices.map((c, ci) => el("span", { class: `st-qc ${ci === q.answer ? "correct" : ""}` },
            ci === q.answer ? icon("check", 11) : null, c))),
        el("div", { class: "st-qexp" }, q.explanation)))),
    el("p", { class: "small muted", style: { marginTop: "8px" } },
      "「保存して割当」で施術者全員に割り当てられます(受付・本部職は対象外)。"));
}

/* ---- 受験モーダル ---- */

function openTakeTestModal(t, rerender) {
  const me = store.me();
  const qs = t.questions;
  const answers = [];
  const body = el("div", { class: "page-staff" });
  const closeBtn = el("button", { class: "btn ghost" }, "中断する");
  const m = modal({ title: `受験 — ${t.title}`, body, actions: [closeBtn] });
  closeBtn.addEventListener("click", m.close);

  function renderQ(i) {
    const q = qs[i];
    clear(body).appendChild(el("div", {},
      el("div", { class: "st-quiz-prog" },
        el("span", { class: "small muted" }, `問 ${i + 1} / ${qs.length}`),
        el("div", { class: "st-prog" },
          el("div", { class: "st-prog-fill", style: { width: `${(i / qs.length) * 100}%` } }))),
      el("div", { class: "st-qbig" }, q.q),
      el("div", { class: "st-choices" },
        q.choices.map((c, ci) => el("button", {
          class: "st-choice",
          onclick: () => {
            answers.push(ci);
            if (i + 1 < qs.length) renderQ(i + 1);
            else showResult();
          },
        }, el("span", { class: "st-choice-no" }, "ABCD"[ci] || "?"), c)))));
  }

  function showResult() {
    const correct = qs.filter((q, i) => answers[i] === q.answer).length;
    const score = Math.round((correct / qs.length) * 100);
    store.update("tests", t.id, (tt) => {
      const results = [...tt.results];
      const mine = results.find((r) => r.staffId === me.id);
      if (mine) { mine.score = score; mine.date = todayStr(); }
      else results.push({ staffId: me.id, score, date: todayStr() });
      return { results };
    });
    if (score >= 80) celebrate(`${score}点!合格ラインクリアです`);
    else toast("採点結果を保存しました");
    rerender();

    clear(closeBtn).append(icon("check", 15), "閉じる");
    closeBtn.className = "btn primary";

    clear(body).appendChild(el("div", {},
      el("div", { class: `st-score-hero ${score >= 80 ? "good" : "warn"}` },
        el("div", { class: "st-score-val" }, `${score}`, el("span", { class: "st-score-unit" }, "点")),
        el("div", { class: "st-score-sub" }, `${correct}/${qs.length}問正解`,
          score >= 80 ? badge("合格ライン(80点)クリア", "good") : badge("80点未満・要復習", "warn"))),
      h4("解答と解説"),
      el("div", {},
        qs.map((q, i) => {
          const ok = answers[i] === q.answer;
          return el("div", { class: "st-rq" },
            el("div", { class: "st-rq-head" },
              el("span", { class: `st-rq-ic ${ok ? "ok" : "ng"}` }, icon(ok ? "check" : "x", 13)),
              el("span", { class: "st-rq-q" }, `問${i + 1}. ${q.q}`)),
            el("div", { class: "st-rq-ans" },
              ok
                ? el("span", {}, "あなたの解答:", el("strong", {}, q.choices[answers[i]] ?? "—"))
                : el("span", {}, "あなたの解答:", el("strong", { class: "st-ng" }, q.choices[answers[i]] ?? "—"),
                    " / 正解:", el("strong", { class: "st-ok" }, q.choices[q.answer]))),
            el("div", { class: "st-qexp" }, q.explanation));
        }))));
  }

  renderQ(0);
}

/* ============================================================
   タブ 3:研修
   ============================================================ */

const TRAINING_KIND = { 技術研修: "brand", 鍼研修: "accent", 座学: "" };

function trainingsView(body, rerender) {
  const today = todayStr();
  const trainings = store.get("trainings");
  const future = trainings.filter((t) => t.date >= today).sort((a, b) => (a.date > b.date ? 1 : -1));
  const past = trainings.filter((t) => t.date < today).sort((a, b) => (a.date < b.date ? 1 : -1));

  body.appendChild(el("div", { class: "st-note st-note-block" }, icon("info", 15),
    el("span", {},
      el("strong", {}, "研修は月3回。"),
      "うち技術研修1回・鍼研修1回(該当職種)は必須参加です。出欠の回答はシフト自動作成の条件に反映されます。")));

  body.appendChild(card({
    title: "今後の研修", sub: `${future.length}件・出欠を回答してください`,
    body: future.length
      ? el("div", {}, future.map((t) => trainingRow(t, true, rerender)))
      : emptyState({ icon: "📅", title: "予定されている研修はありません" }),
  }));
  body.appendChild(card({
    title: "実施済みの研修", sub: `${past.length}件`, class: "mt-16",
    body: past.length
      ? el("div", {}, past.map((t) => trainingRow(t, false, rerender)))
      : emptyState({ icon: "🗂", title: "実施済みの研修はありません" }),
  }));
}

function trainingRow(t, isFuture, rerender) {
  const me = store.me();
  const attendees = t.attendees || [];
  const yes = attendees.filter((a) => a.status === "参加" || a.status === "出席");
  const mine = attendees.find((a) => a.staffId === me.id);

  const respond = (status) => {
    store.update("trainings", t.id, (tr) => {
      const a = (tr.attendees || []).find((x) => x.staffId === me.id);
      if (a) a.status = status;
      return { attendees: tr.attendees };
    });
    toast(`「${t.title}」の出欠を「${status}」で回答しました`);
    rerender();
  };

  return el("div", { class: `st-trrow ${isFuture ? "" : "past"}` },
    el("div", { class: "st-trdate" },
      el("span", { class: "st-trday" }, fmtDate(t.date, { withDow: false })),
      el("span", { class: "st-trdow" }, `(${"日月火水木金土"[new Date(t.date + "T00:00:00").getDay()]})`)),
    el("div", { class: "st-trmain" },
      el("div", { class: "st-trtitle" }, t.title),
      el("div", { class: "st-trmeta" },
        badge(t.type, TRAINING_KIND[t.type] ?? ""),
        t.required ? badge("必須参加", "critical") : null,
        el("span", { class: "st-trfact" }, icon("clock", 12), `${t.start}〜${endTime(t.start, t.durationMin)}`),
        el("span", { class: "st-trfact" }, icon("pin", 12), t.place)),
      el("div", { class: "st-trpeople" },
        avatarStack(yes.map((a) => a.staffId), 24),
        el("span", { class: "small muted" },
          `${isFuture ? "参加" : "出席"} ${yes.length}/${attendees.length}名`))),
    el("div", { class: "st-trside" },
      isFuture && mine
        ? el("div", { class: "st-rsvp" },
            el("button", {
              class: `st-rsvp-btn yes ${mine.status === "参加" ? "on" : ""}`,
              onclick: () => respond("参加"),
            }, icon("check", 13), "参加"),
            el("button", {
              class: `st-rsvp-btn no ${mine.status === "欠席" ? "on" : ""}`,
              onclick: () => respond("欠席"),
            }, icon("x", 13), "欠席"))
        : null,
      isFuture && mine && mine.status === "未回答" ? badge("未回答", "warn") : null,
      isFuture && !mine ? el("span", { class: "small muted" }, "対象外") : null,
      !isFuture && mine ? badge(mine.status, mine.status === "出席" ? "good" : "critical") : null));
}

/* ============================================================
   タブ 4:評価
   ============================================================ */

const GRADE_KIND = { A: "good", B: "brand", C: "warn" };
const evalAvg = (ev) => {
  const v = Object.values(ev.scores || {});
  return v.length ? v.reduce((a, x) => a + x, 0) / v.length : 0;
};

function evalsView(body) {
  body.appendChild(el("div", { class: "st-note st-note-block st-note-good" }, icon("sparkle", 15),
    el("span", {},
      el("strong", {}, "評価集計の手作業はなくなりました。"),
      "日報・テスト結果から自動集計され、半期評価のドラフトが自動作成されます。")));

  // 一般社員は自分の評価のみ。責任者は配下の評価を閲覧できる
  const evals = [...store.get("evaluations")]
    .filter((ev) => canViewScore(ev.staffId))
    .sort((a, b) => evalAvg(b) - evalAvg(a));
  const isLimited = rankLevel(store.me()) < 3;

  body.appendChild(card({
    title: "個人評価",
    sub: isLimited
      ? `${evals[0]?.period || ""}・自分の評価のみ表示されます(他のスタッフの点数は非公開)`
      : `${evals[0]?.period || ""}・行をクリックで詳細`,
    body: evals.length
      ? table({
          columns: [
            { key: "staff", label: "スタッフ", render: (ev) => staffChip(ev.staffId, { size: 30 }) },
            { key: "period", label: "期", render: (ev) => el("span", { class: "small mono-num" }, ev.period) },
            { key: "grade", label: "総合", align: "center", render: (ev) => badge(`${ev.grade}評価`, GRADE_KIND[ev.grade] || "") },
            { key: "avg", label: "スコア平均", align: "right", render: (ev) => el("strong", { class: "mono-num" }, evalAvg(ev).toFixed(1)) },
          ],
          rows: evals,
          onRowClick: (ev) => openEvalModal(ev),
        })
      : emptyState({ icon: "🗂", title: "閲覧できる評価はありません", hint: "評価対象は施術者のみです" }),
  }));
}

function openEvalModal(ev) {
  const s = store.byId("staff", ev.staffId);
  if (!s) return;
  const closeBtn = el("button", { class: "btn ghost" }, "閉じる");
  const m = modal({
    title: `評価詳細 — ${s.name}`,
    wide: true,
    body: el("div", { class: "page-staff" },
      el("div", { class: "st-eval-top" },
        staffChip(ev.staffId, { size: 38 }),
        el("span", { class: "spacer" }),
        badge(ev.period),
        badge(`総合 ${ev.grade}評価`, GRADE_KIND[ev.grade] || "")),
      el("div", { class: "st-detail" },
        el("div", { class: "st-detail-left" },
          radar({
            axes: Object.keys(ev.scores),
            values: [{ name: s.name, scores: Object.values(ev.scores), color: s.color }],
            size: 250, max: 5,
          })),
        el("div", { class: "st-detail-right" },
          h4("項目別スコア"),
          Object.entries(ev.scores).map(([k, v]) => kv(k, `${v.toFixed(1)} / 5.0`)),
          kv("スコア平均", evalAvg(ev).toFixed(1)))),
      el("div", { class: "st-note", style: { marginTop: "14px" } }, icon("sparkle", 14),
        el("span", {}, ev.autoNote || "数値評価は自動集計されています。"))),
    actions: [closeBtn],
  });
  closeBtn.addEventListener("click", m.close);
}

/* ============================================================
   タブ 5:面談
   ============================================================ */

function interviewsView(body, rerender) {
  const me = store.me();
  const newBtn = el("button", { class: "btn primary", onclick: () => openNewInterviewModal(rerender) },
    icon("plus", 16), "新規面談メモ");
  body.appendChild(el("div", { class: "st-toolrow" },
    el("div", { class: "st-note" }, icon("mic", 15),
      el("span", {}, "面談の内容は", el("strong", {}, "ボイス入力"), "でそのまま記録し、AIが問題点・要因・ネクストアクション・ムードに整理します。")),
    newBtn));

  // 面談記録は「自分が受けた/自分が面談した/配下・メンティー」のみ閲覧できる
  const list = [...store.get("interviews")]
    .filter((iv) => iv.interviewerId === me.id || canSeeStaff(iv.staffId))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  body.appendChild(card({
    title: "面談記録", sub: `${list.length}件・クリックで詳細`,
    body: list.length
      ? el("div", { class: "row-list" }, list.map((iv) => interviewRow(iv)))
      : emptyState({ icon: "💬", title: "面談記録はまだありません", hint: "「新規面談メモ」から追加できます" }),
  }));
}

function interviewRow(iv) {
  const s = store.byId("staff", iv.staffId);
  const n = iv.aiSummary?.problems?.length || 0;
  return el("div", { class: "row-item clickable st-ivrow", onclick: () => openInterviewModal(iv) },
    avatar(s, 38),
    el("span", { class: "row-main" },
      el("span", { class: "row-title" }, s?.name || "—",
        el("span", { class: "small muted", style: { marginLeft: "7px", fontWeight: "500" } },
          `${fmtDate(iv.date)}・面談者 ${store.staffName(iv.interviewerId)}`)),
      el("span", { class: "row-sub" }, iv.notes)),
    badge(`問題点 ${n}件`, n >= 2 ? "warn" : "brand"),
    icon("chevR", 16));
}

function summaryNode(sum) {
  if (!sum) return el("p", { class: "muted small" }, "AI要約はまだありません");
  const sec = (emoji, label, items) => el("div", { class: "st-sumsec" },
    el("div", { class: "st-sumhead" }, `${emoji} ${label}`),
    Array.isArray(items)
      ? el("ul", { class: "st-sumlist" }, items.map((x) => el("li", {}, x)))
      : el("p", { class: "st-sumtext" }, items || "—"));
  return el("div", { class: "st-summary" },
    sec("🔍", "問題点", sum.problems || []),
    sec("🧩", "要因", sum.causes || []),
    sec("✅", "ネクストアクション", sum.actions || []),
    sec("💬", "ムード", sum.mood));
}

function openInterviewModal(iv) {
  const s = store.byId("staff", iv.staffId);
  const closeBtn = el("button", { class: "btn ghost" }, "閉じる");
  const m = modal({
    title: `面談メモ — ${s?.name || "—"}`,
    wide: true,
    body: el("div", { class: "page-staff" },
      el("div", { class: "st-eval-top" },
        staffChip(iv.staffId, { size: 36 }),
        el("span", { class: "spacer" }),
        badge(fmtDate(iv.date, { withYear: true })),
        el("span", { class: "small muted" }, `面談者:${store.staffName(iv.interviewerId)}`)),
      h4("面談メモ(原文)"),
      el("div", { class: "st-notes" }, iv.notes),
      h4("AI要約"),
      summaryNode(iv.aiSummary)),
    actions: [closeBtn],
  });
  closeBtn.addEventListener("click", m.close);
}

function openNewInterviewModal(rerender) {
  const me = store.me();
  const others = store.get("staff").filter((s) => s.id !== me.id);
  const sel = el("select", { class: "select" },
    others.map((s) => el("option", { value: s.id }, `${s.name}(${store.storeName(s.storeId)}・${s.role})`)));
  const ta = el("textarea", {
    class: "textarea", rows: 7,
    placeholder: "「ボイス入力」を押して話すだけでOK。走り書きの入力でもかまいません。\n例)テストの点数が伸びず落ち込んでいる様子。勉強の仕方が分からないと話す。シフトが合わず先輩の施術見学ができていない。",
  });
  const mic = micButton(ta, {
    samples: [sampleInterviewVoice(0), sampleInterviewVoice(1)],
    label: "ボイス入力",
  });

  let summary = null;
  const host = el("div", { class: "mt-12" });
  const panel = aiPanel("AI面談整理");
  const saveBtn = el("button", { class: "btn primary", disabled: true }, icon("check", 15), "保存");
  const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");

  const sumBtn = aiButton("AIで整理", async () => {
    const text = ta.value.trim();
    if (!text) { toast("メモが空です。ボイス入力または走り書きで入力してください", "error"); return; }
    if (!host.contains(panel.el)) host.appendChild(panel.el);
    panel.thinking("面談メモを分析しています");
    summary = await summarizeInterview(text);
    panel.setNode(el("div", {},
      summaryNode(summary),
      el("p", { class: "small muted", style: { marginTop: "8px" } }, "内容を確認して「保存」を押すと面談記録に追加されます。")));
    saveBtn.disabled = false;
  });

  const m = modal({
    title: "新規面談メモ(ボイス入力対応)",
    wide: true,
    body: el("div", { class: "page-staff" },
      el("div", { class: "field" }, el("label", {}, "面談したスタッフ"), sel),
      el("div", { class: "field mt-12" },
        el("div", { class: "flex between wrap", style: { gap: "8px" } },
          el("label", {}, "面談メモ(話すだけでOK)"), mic),
        ta),
      el("div", { class: "st-ta-actions" }, sumBtn),
      host),
    actions: [cancelBtn, saveBtn],
  });
  cancelBtn.addEventListener("click", m.close);
  saveBtn.addEventListener("click", () => {
    if (!summary) return;
    store.add("interviews", {
      id: store.uid("iv"),
      staffId: sel.value,
      interviewerId: me.id,
      date: todayStr(),
      notes: ta.value.trim(),
      aiSummary: summary,
    });
    m.close();
    toast("面談メモとAI要約を保存しました");
    rerender();
  });
}

/* ============================================================
   ページ定義
   ============================================================ */

const VIEWS = {
  members: membersView,
  tests: testsView,
  trainings: trainingsView,
  evaluations: evalsView,
  interviews: interviewsView,
};

function renderPage(root, tab) {
  const rerender = () => { clear(root); renderPage(root, tab); };

  root.appendChild(sectionHeader("スタッフ管理",
    "テスト・研修・評価・面談をひとつに。問題作成・評価集計・面談要約はAIが担当します"));

  root.appendChild(tabs([
    { id: "members", label: "メンバー", badge: store.get("staff").length },
    { id: "tests", label: "テスト", badge: store.get("tests").length },
    { id: "trainings", label: "研修", badge: store.get("trainings").length },
    { id: "evaluations", label: "評価" },
    { id: "interviews", label: "面談", badge: store.get("interviews").length },
  ], tab, (id) => { location.hash = `#/staff/${id}`; }));

  const body = el("div", { class: "st-body" });
  root.appendChild(body);
  (VIEWS[tab] || membersView)(body, rerender);
}

export default {
  id: "staff",
  title: "スタッフ管理",
  icon: "grad",

  // このページが必要とするデータ。ルーターがそろえてから render() を呼ぶ
  needs: ["evaluations", "interviews", "staff", "stores", "tests", "trainings"],
  render(root, params) {
    const tab = VIEWS[params?.[0]] ? params[0] : "members";
    renderPage(root, tab);
  },
};
