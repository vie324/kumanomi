/* ============================================================
   ロープレ練習 — ボイス録音 × トークスクリプト比較 × AIフィードバック
   ・お手本スクリプトを見ながら録音(デモは擬似録音)
   ・書き起こしをスクリプトと突き合わせて AI が採点
   ・行ごとの「話せた/抜けた」を可視化し、次のアクションまで提示
   実運用では音声認識(Whisper等)+ LLM 評価に差し替わる。
   ============================================================ */
import {
  el, clear, esc, icon, badge, card, sectionHeader, tabs, table, emptyState, statTile,
  staffChip, fmtDate, toast, aiButton, aiPanel, meter, modal, segmented, celebrate,
} from "../ui.js";
import { radar, lineChart, hBars } from "../charts.js";
import { store, todayStr } from "../store.js";
import { can, visibleStaff, scopeLabel } from "../auth.js";
import { evaluateRoleplay, sampleRoleplaySpeech } from "../ai.js";

/* ---------------- 練習セッションの一時状態(ページ内で保持) ---------------- */

const S = {
  scriptId: null,
  phase: "select",     // select | practice | result
  quality: "mid",      // high | mid | low
  transcript: "",
  recording: false,
  elapsed: 0,
  durationSec: 0,
  result: null,
  savedId: null,
};

let recTimer = null;
function stopTimer() { if (recTimer) { clearInterval(recTimer); recTimer = null; } }

/** 現在のタブを再描画するためのフック(モーダルからの更新反映用) */
let rerenderCurrent = () => {};

const QUALITIES = [
  { id: "high", label: "お手本どおり" },
  { id: "mid", label: "だいたい話せた" },
  { id: "low", label: "かなり抜けた" },
];

/* ---------------- 小さなヘルパー ---------------- */

const allScripts = () => store.get("talkScripts") || [];
const allSessions = () => store.get("roleplaySessions") || [];
const scriptById = (id) => allScripts().find((s) => s.id === id) || null;
const scriptTitle = (id) => scriptById(id)?.title || "(不明なスクリプト)";

const fmtSec = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, Math.round(s)) % 60).padStart(2, "0")}`;
const scoreTone = (n) => (n >= 80 ? "good" : n >= 60 ? "warn" : "critical");
const scoreWord = (n) => (n >= 80 ? "良好" : n >= 60 ? "あと一歩" : "要練習");
const fluency = (filler) => Math.max(0, 100 - (Number(filler) || 0) * 15);

const LEVEL_TONE = { 基礎: "accent", 実践: "brand", 応用: "warn" };

/** 新しい順(同日は後から追加したものが上) */
function newestFirst(list) {
  return [...list].reverse().sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
}

function verdict(score) {
  if (score >= 88) return "お手本レベルです。この型を安定して再現できるようにしましょう。";
  if (score >= 76) return "実践投入できる水準です。あと少しの詰めで満点が狙えます。";
  if (score >= 60) return "話の骨格は掴めています。抜けた要素を1つずつ足していきましょう。";
  if (score >= 40) return "流れは追えていますが、要素の抜けが目立ちます。お手本を読み直しましょう。";
  return "まずはお手本を見ながら、声に出して読む練習から始めましょう。";
}

/** 本文中のキーワードを <mark> で強調(最長一致・前方から走査) */
function markup(text, kwClass) {
  const kws = [...kwClass.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  const src = String(text || "");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const k = kws.find((w) => src.startsWith(w, i));
    if (k) { out += `<mark class="rp-kw ${kwClass.get(k) || ""}">${esc(k)}</mark>`; i += k.length; }
    else { out += esc(src[i]); i += 1; }
  }
  return out;
}

function kwMap(keywords, cls = "") {
  const m = new Map();
  (keywords || []).forEach((k) => m.set(k, cls));
  return m;
}

function myBest(scriptId, staffId) {
  const list = allSessions().filter((s) => s.staffId === staffId && s.scriptId === scriptId);
  return list.length ? Math.max(...list.map((s) => s.score)) : null;
}

function scoreBadge(score) {
  return el("span", { class: `rp-scorebadge ${scoreTone(score)}` },
    el("strong", { class: "mono-num" }, String(score)), el("span", { class: "rp-sb-unit" }, "点"));
}

function fillerBadge(n) {
  const kind = n === 0 ? "good" : n <= 2 ? "warn" : "critical";
  const label = n === 0 ? "フィラーなし" : n <= 2 ? "許容範囲" : "多い";
  return el("span", { class: "flex", style: { gap: "7px" } },
    el("strong", { class: "mono-num rp-filler-num" }, `${n}回`), badge(label, kind));
}

const liveNote = (text) => el("div", { class: "rp-note" },
  icon("info", 13),
  el("span", {}, text || "デモ環境のため録音は擬似再現です。実運用では音声認識(Whisper等)とLLM評価に接続されます。"));

/** スコアのドーナツ表示(conic-gradient・依存ゼロ) */
function scoreRing(score) {
  return el("div", { class: "rp-ring", style: { "--rp-pct": String(Math.max(0, Math.min(100, score))) } },
    el("div", { class: "rp-ring-in" },
      el("span", { class: "rp-hero-num mono-num" }, String(score)),
      el("span", { class: "rp-hero-unit" }, "点")));
}

/* ---------------- 指標ブロック(結果ビュー・詳細モーダル共通) ---------------- */

function metricsBlock(m) {
  const met = m || { coverage: 0, pace: 0, filler: 0, empathy: 0 };
  const brandC = getComputedStyle(document.documentElement).getPropertyValue("--brand").trim() || "#e2621a";
  return el("div", { class: "rp-metrics" },
    el("div", { class: "rp-radar" },
      radar({
        axes: ["網羅", "速さ", "共感", "流暢"],
        values: [{ name: "今回", scores: [met.coverage, met.pace, met.empathy, fluency(met.filler)], color: brandC }],
        size: 240, max: 100,
      })),
    el("div", { class: "rp-meterlist" },
      meter({
        label: "カバレッジ(要点の網羅)", value: met.coverage, max: 100, fmt: (v) => `${v}%`,
        kind: met.coverage >= 80 ? "" : met.coverage >= 55 ? "warn" : "critical",
      }),
      meter({
        label: "ペース(話す量と時間)", value: met.pace, max: 100, fmt: (v) => `${v}%`,
        kind: met.pace >= 80 ? "accent" : met.pace >= 55 ? "warn" : "critical",
      }),
      meter({
        label: "共感表現", value: met.empathy, max: 100, fmt: (v) => `${v}%`,
        kind: met.empathy >= 75 ? "" : met.empathy >= 45 ? "warn" : "critical",
      }),
      el("div", { class: "rp-fillerrow" },
        el("span", { class: "rp-fillerlabel" }, "フィラー(えーっと 等)"),
        fillerBadge(Number(met.filler) || 0))));
}

/* ---------------- AIフィードバック ---------------- */

function feedbackNode(fb) {
  const f = fb || { good: [], improve: [], nextAction: "" };
  const block = (emoji, title, items, kind) => el("div", { class: `rp-fb ${kind}` },
    el("div", { class: "rp-fb-head" }, el("span", { class: "rp-fb-emo" }, emoji), title),
    el("ul", { class: "rp-fb-list" }, (items || []).length
      ? items.map((t) => el("li", {}, t))
      : el("li", { class: "muted" }, "—")));
  return el("div", { class: "rp-fb-wrap" },
    block("👍", "よかった点", f.good, "good"),
    block("🔧", "改善点", f.improve, "warn"),
    el("div", { class: "rp-fb next" },
      el("div", { class: "rp-fb-head" }, el("span", { class: "rp-fb-emo" }, "🎯"), "次のアクション"),
      el("p", { class: "rp-next-text" }, f.nextAction || "—")));
}

/* ---------------- スクリプト比較ビュー ---------------- */

const STATUS_META = {
  ok: { label: "話せています", ic: "check" },
  partial: { label: "一部が抜けています", ic: "alert" },
  missing: { label: "抜けています", ic: "x" },
};

function comparisonNode(lineResults) {
  if (!lineResults?.length) {
    return emptyState({
      icon: "📝", title: "この記録には行ごとの比較データがありません",
      hint: "新しく採点した記録では、行単位のキーワード比較が表示されます",
    });
  }
  const wrap = el("div", { class: "rp-cmp-list" });
  lineResults.forEach((r, i) => {
    const meta = STATUS_META[r.status] || STATUS_META.partial;
    const m = kwMap(r.hitKeywords, "hit");
    (r.missKeywords || []).forEach((k) => m.set(k, "miss"));
    wrap.appendChild(el("div", { class: `rp-cmp ${r.status}` },
      el("span", { class: "rp-cmp-no mono-num" }, String(i + 1)),
      el("div", { class: "rp-cmp-main" },
        el("div", { class: "rp-cmp-head" },
          el("span", { class: "rp-cmp-stat" }, icon(meta.ic, 13), meta.label),
          el("span", { class: "rp-cmp-ratio mono-num" },
            `${(r.hitKeywords || []).length} / ${(r.keywords || []).length} キーワード`)),
        el("p", { class: "rp-cmp-text", html: markup(r.text, m) }),
        el("div", { class: "rp-chips" },
          (r.hitKeywords || []).map((k) => el("span", { class: "rp-chip hit" }, icon("check", 11), k)),
          (r.missKeywords || []).map((k) => el("span", { class: "rp-chip miss" }, icon("x", 11), k)),
          !(r.keywords || []).length ? el("span", { class: "rp-chip" }, "キーワード指定なし") : null))));
  });
  return wrap;
}

/* ============================================================
   タブ1:練習する
   ============================================================ */

function practiceView(host) {
  stopTimer();
  clear(host);
  const sc = scriptById(S.scriptId);
  if (S.phase === "result" && S.result && sc) { resultPane(host, sc); return; }
  if (S.phase === "practice" && sc) { practicePane(host, sc); return; }
  S.phase = "select";
  selectPane(host);
}

/* ---- スクリプト選択 ---- */
function selectPane(host) {
  const me = store.me();
  const list = allScripts();

  host.appendChild(el("div", { class: "rp-lead" },
    el("span", { class: "rp-lead-ic" }, icon("mic", 18)),
    el("div", {},
      el("div", { class: "rp-lead-title" }, "練習するトークを選んでください"),
      el("div", { class: "rp-lead-sub" }, "お手本を見ながら録音 → AIがスクリプトと突き合わせて採点します"))));

  if (!list.length) {
    host.appendChild(el("div", { class: "card" }, emptyState({ title: "トークスクリプトが登録されていません" })));
    return;
  }

  const grid = el("div", { class: "rp-script-grid" });
  for (const sc of list) {
    const best = myBest(sc.id, me.id);
    grid.appendChild(el("button", {
      class: "rp-script-card",
      onclick: () => {
        Object.assign(S, {
          scriptId: sc.id, phase: "practice", transcript: "", result: null,
          recording: false, elapsed: 0, durationSec: 0, savedId: null,
        });
        practiceView(host);
      },
    },
      el("div", { class: "rp-sc-top" },
        badge(sc.category, "brand"),
        badge(sc.level, LEVEL_TONE[sc.level] || ""),
        el("span", { class: "rp-sc-dur mono-num" }, icon("clock", 12), `${sc.durationSec}秒`)),
      el("div", { class: "rp-sc-title" }, sc.title),
      el("div", { class: "rp-sc-goal" }, el("span", { class: "rp-sc-goal-tag" }, "ゴール"), sc.goal),
      el("div", { class: "rp-sc-foot" },
        el("span", { class: "rp-sc-lines" }, `${sc.lines.length}ステップ`),
        best != null
          ? el("span", { class: "rp-sc-best" }, "自己ベスト", scoreBadge(best))
          : el("span", { class: "rp-sc-best none" }, "未挑戦"),
        el("span", { class: "rp-sc-go" }, "練習する", icon("chevR", 14)))));
  }
  host.appendChild(grid);
  host.appendChild(liveNote());
}

/* ---- 練習(お手本 + 録音パネル) ---- */
function practicePane(host, sc) {
  host.appendChild(el("div", { class: "rp-crumb" },
    el("button", {
      class: "btn ghost sm",
      onclick: () => { stopTimer(); S.phase = "select"; S.recording = false; practiceView(host); },
    }, icon("chevL", 14), "スクリプト一覧"),
    el("span", { class: "rp-crumb-title" }, sc.title),
    badge(sc.category, "brand"),
    badge(sc.level, LEVEL_TONE[sc.level] || "")));

  /* --- 左:お手本スクリプト --- */
  const lines = el("div", { class: "rp-lines" });
  sc.lines.forEach((l, i) => {
    lines.appendChild(el("div", { class: "rp-line" },
      el("span", { class: "rp-line-no mono-num" }, String(i + 1)),
      el("div", { class: "rp-bubble" },
        el("span", { class: "rp-bubble-role" }, l.role),
        el("p", { class: "rp-bubble-text", html: markup(l.text, kwMap(l.keywords)) }))));
  });
  const modelCard = card({
    title: "お手本スクリプト", sub: `${sc.lines.length}ステップ / 目安 ${sc.durationSec}秒`, class: "rp-model",
    body: el("div", { class: "stack", style: { gap: "12px" } },
      el("div", { class: "rp-goal" }, el("span", { class: "rp-goal-tag" }, "🎯 ゴール"), sc.goal),
      lines,
      el("div", { class: "rp-kw-legend" },
        el("mark", { class: "rp-kw" }, "強調"), "された語はAI採点で必ずチェックされるキーワードです")),
  });

  /* --- 右:録音パネル --- */
  const recBody = el("div", { class: "stack", style: { gap: "12px" } });
  const recCard = card({ title: "ボイス録音", sub: "デモ:擬似録音", class: "rp-reccard", body: recBody });

  const paintRec = () => {
    clear(recBody);

    if (S.recording) {
      const timerEl = el("span", { class: "rp-timer mono-num" }, fmtSec(S.elapsed));
      recBody.append(
        el("div", { class: "rp-live" },
          el("span", { class: "rp-mic" }, icon("mic", 22)),
          el("span", { class: "rp-eq" }, [0, 1, 2, 3, 4, 5, 6, 7, 8].map(() => el("i"))),
          el("div", { class: "rp-live-meta" },
            el("span", { class: "rp-live-label" }, "録音中… お手本を見ずに話してみましょう"),
            timerEl)),
        el("button", {
          class: "btn danger block lg rp-stopbtn",
          onclick: () => {
            stopTimer();
            S.recording = false;
            S.durationSec = Math.max(1, S.elapsed);
            S.transcript = sampleRoleplaySpeech(sc, S.quality);
            practiceView(host);
          },
        }, el("span", { class: "rp-stop-sq" }), "停止して書き起こす"));
      stopTimer();
      recTimer = setInterval(() => {
        S.elapsed += 1;
        timerEl.textContent = fmtSec(S.elapsed);
        if (S.elapsed >= 300) stopTimer();
      }, 1000);
      return;
    }

    recBody.append(el("div", { class: "field" },
      el("label", {}, "デモ用:練習の出来を選ぶ"),
      segmented(QUALITIES, S.quality, (id) => { S.quality = id; paintRec(); }),
      el("span", { class: "hint" }, "選んだ度合いに応じて書き起こしが変わり、採点結果の違いを確認できます")));

    if (S.transcript) {
      recBody.append(el("div", { class: "rp-recorded" },
        el("span", { class: "rp-recorded-ic" }, icon("check", 16)),
        el("div", {},
          el("div", { class: "rp-recorded-title" }, `録音完了 ${fmtSec(S.durationSec)}`),
          el("div", { class: "rp-recorded-sub" }, `目安 ${fmtSec(sc.durationSec)} / 自動で書き起こしました`))));
    }

    recBody.append(el("button", {
      class: `btn ${S.transcript ? "ghost" : "primary"} block lg rp-recbtn`,
      onclick: () => {
        S.recording = true; S.elapsed = 0; S.result = null; S.savedId = null;
        practiceView(host);
      },
    }, S.transcript ? icon("refresh", 17) : el("span", { class: "rp-recbtn-emo" }, "🎤"),
      S.transcript ? "もう一度録音する" : "録音を開始"));

    recBody.append(liveNote());
  };
  paintRec();

  const rightStack = el("div", { class: "rp-right" }, recCard);

  /* --- 書き起こし + 採点 --- */
  if (S.transcript) {
    const ta = el("textarea", {
      class: "textarea rp-transcript", rows: "6",
      placeholder: "聞き取り結果がここに入ります",
    });
    ta.value = S.transcript;
    const chars = el("span", { class: "hint mono-num" }, `${S.transcript.length}文字`);
    ta.addEventListener("input", () => {
      S.transcript = ta.value;
      chars.textContent = `${ta.value.length}文字`;
    });

    const runBtn = aiButton("AIで採点する", async () => {
      const text = ta.value.trim();
      if (!text) { toast("書き起こしが空です。録音するか、テキストを入力してください", "error"); return; }
      S.transcript = text;
      S.result = await evaluateRoleplay(sc, text);
      S.phase = "result";
      S.savedId = null;
      practiceView(host);
    });

    rightStack.appendChild(card({
      title: "聞き取り結果を修正", sub: "誤認識はここで直せます", class: "rp-tcard",
      body: el("div", { class: "stack", style: { gap: "10px" } },
        ta,
        el("div", { class: "flex between wrap", style: { gap: "8px" } },
          chars,
          el("span", { class: "hint" }, "お手本とはキーワード単位で比較されます")),
        runBtn),
    }));
  }

  host.appendChild(el("div", { class: "rp-practice" }, modelCard, rightStack));
}

/* ---- 結果ビュー ---- */
function resultPane(host, sc) {
  const r = S.result;
  const me = store.me();
  const tone = scoreTone(r.score);
  const okN = r.lineResults.filter((x) => x.status === "ok").length;
  const partN = r.lineResults.filter((x) => x.status === "partial").length;
  const missN = r.lineResults.filter((x) => x.status === "missing").length;

  host.appendChild(el("div", { class: "rp-crumb" },
    el("button", {
      class: "btn ghost sm",
      onclick: () => { S.phase = "select"; practiceView(host); },
    }, icon("chevL", 14), "スクリプト一覧"),
    el("span", { class: "rp-crumb-title" }, sc.title),
    badge("採点結果", "accent")));

  /* スコアヒーロー */
  host.appendChild(el("div", { class: `rp-hero ${tone}` },
    scoreRing(r.score),
    el("div", { class: "rp-hero-body" },
      el("div", { class: "rp-hero-toprow" },
        el("span", { class: `rp-hero-word ${tone}` }, scoreWord(r.score)),
        el("span", { class: "rp-hero-sub" }, `${sc.category}・${sc.level} / カバレッジ ${r.metrics.coverage}%`)),
      el("div", { class: "rp-hero-title" }, verdict(r.score)),
      el("div", { class: "rp-hero-meta" },
        el("span", {}, icon("clock", 13), `録音 ${fmtSec(S.durationSec)}(目安 ${fmtSec(sc.durationSec)})`),
        el("span", {}, icon("book", 13), `${sc.lines.length}ステップ中 ${okN}ステップ合格`),
        el("span", {}, icon("user", 13), me.name)))));

  /* 4指標 */
  host.appendChild(card({
    title: "4指標で見る話し方", sub: "カバレッジ / ペース / 共感 / フィラー",
    body: metricsBlock(r.metrics),
  }));

  /* スクリプト比較 */
  host.appendChild(card({
    title: "お手本との比較", sub: "行ごとにキーワードをチェック",
    actions: el("div", { class: "rp-cmp-legend" },
      el("span", { class: "rp-lg ok" }, icon("check", 12), `話せた ${okN}`),
      el("span", { class: "rp-lg partial" }, icon("alert", 12), `一部 ${partN}`),
      el("span", { class: "rp-lg missing" }, icon("x", 12), `抜け ${missN}`)),
    body: comparisonNode(r.lineResults),
  }));

  /* AIフィードバック */
  const panel = aiPanel("AIフィードバック");
  panel.setNode(feedbackNode(r.feedback));
  host.appendChild(panel.el);

  /* アクション */
  const saveBtn = el("button", { class: "btn primary lg" }, icon("check", 17), "この結果を保存");
  saveBtn.addEventListener("click", () => {
    if (S.savedId) { toast("この結果はすでに保存済みです", "info"); return; }
    if (!Array.isArray(store.get("roleplaySessions"))) { toast("保存先が見つかりませんでした", "error"); return; }
    const rec = store.add("roleplaySessions", {
      staffId: me.id,
      scriptId: sc.id,
      date: todayStr(),
      durationSec: S.durationSec || sc.durationSec,
      transcript: S.transcript,
      score: r.score,
      metrics: r.metrics,
      lineResults: r.lineResults,
      feedback: r.feedback,
      reviewedBy: null,
      mentorComment: "",
    });
    S.savedId = rec.id;
    saveBtn.disabled = true;
    celebrate(`練習記録を保存しました(${r.score}点)`);
  });

  host.appendChild(el("div", { class: "rp-actions" },
    saveBtn,
    el("button", {
      class: "btn soft lg",
      onclick: () => {
        Object.assign(S, { phase: "practice", transcript: "", result: null, elapsed: 0, durationSec: 0, savedId: null });
        practiceView(host);
      },
    }, icon("refresh", 17), "もう一度練習する"),
    el("button", {
      class: "btn ghost lg",
      onclick: () => { location.hash = "#/roleplay/mine"; },
    }, "自分の記録を見る")));

  host.appendChild(liveNote("この採点はデモ用の擬似エンジンによるものです。実運用では音声認識(Whisper等)とLLM評価に接続されます。"));
}

/* ============================================================
   タブ2:自分の記録
   ============================================================ */

function mineView(host) {
  clear(host);
  const me = store.me();
  const mine = newestFirst(allSessions().filter((s) => s.staffId === me.id));

  if (!mine.length) {
    host.appendChild(el("div", { class: "card" }, emptyState({
      title: "まだ練習記録がありません",
      hint: "「練習する」タブからスクリプトを選び、録音して採点すると記録が残ります",
    })));
    host.appendChild(el("div", { class: "rp-actions" },
      el("button", { class: "btn primary lg", onclick: () => { location.hash = "#/roleplay"; } },
        icon("mic", 17), "練習をはじめる")));
    return;
  }

  const scores = mine.map((s) => s.score);
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const bestScore = Math.max(...scores);
  const latest = mine[0];
  const prev = mine[1];

  host.appendChild(el("div", { class: "kpi-row" },
    statTile({ label: "練習回数", value: `${mine.length}回`, icon: "mic", tone: "brand", sub: `直近 ${fmtDate(latest.date)}` }),
    statTile({ label: "平均スコア", value: `${avg}点`, icon: "target", tone: "accent", sub: `${mine.length}回の平均` }),
    statTile({
      label: "最高スコア", value: `${bestScore}点`, icon: "award", tone: "good",
      sub: scriptTitle(mine.find((s) => s.score === bestScore).scriptId),
    }),
    statTile({
      label: "直近スコア", value: `${latest.score}点`, icon: "trend", tone: "violet",
      delta: prev ? latest.score - prev.score : null, deltaLabel: "前回比",
      sub: prev ? null : "初回の記録",
    })));

  /* スクリプト別のスコア推移(2回以上あるもののみ) */
  const byScript = new Map();
  for (const s of [...mine].reverse()) {   // 古い順に積む
    if (!byScript.has(s.scriptId)) byScript.set(s.scriptId, []);
    byScript.get(s.scriptId).push(s);
  }
  const trends = [...byScript.entries()].filter(([, list]) => list.length >= 2);
  if (trends.length) {
    const charts = el("div", { class: "rp-trend-grid" });
    for (const [sid, list] of trends) {
      // 同日に複数回練習した場合は日付が並ぶので「n回目」表記に切り替える
      const uniqueDates = new Set(list.map((x) => x.date)).size === list.length;
      const labels = list.map((x, i) => (uniqueDates ? fmtDate(x.date, { withDow: false }) : `${i + 1}回目`));
      charts.appendChild(el("div", { class: "rp-trend" },
        el("div", { class: "rp-trend-title" },
          scriptTitle(sid),
          el("span", { class: "muted small" }, ` ${list.length}回 / 最高 ${Math.max(...list.map((x) => x.score))}点`)),
        lineChart({
          series: [{ name: "スコア", values: list.map((x) => x.score) }],
          labels,
          height: 190, showDots: true, fillFirst: true,
          yFmt: (v) => String(Math.round(v)),
        })));
    }
    host.appendChild(card({ title: "スコアの推移", sub: "同じスクリプトを2回以上練習したもの", body: charts }));
  }

  /* 記録リスト */
  const list = el("div", { class: "row-list" });
  for (const s of mine) {
    list.appendChild(el("div", {
      class: "row-item clickable rp-sessrow",
      onclick: () => sessionModal(s, { review: false }),
    },
      el("span", { class: "rp-sess-ic" }, icon("mic", 16)),
      el("div", { class: "row-main" },
        el("div", { class: "row-title" }, scriptTitle(s.scriptId)),
        el("div", { class: "row-sub" },
          `${fmtDate(s.date)} ・ ${fmtSec(s.durationSec)} ・ カバレッジ ${s.metrics?.coverage ?? "—"}%`)),
      el("span", { class: "rp-sess-right" },
        s.reviewedBy ? badge("レビュー済", "accent") : badge("未レビュー", ""),
        scoreBadge(s.score),
        icon("chevR", 15))));
  }
  host.appendChild(card({ title: "練習の記録", sub: `${mine.length}件`, body: list }));
  host.appendChild(liveNote());
}

/* ============================================================
   タブ3:みんなの記録(メンター・責任者向け)
   ============================================================ */

function teamView(host) {
  clear(host);
  const ids = new Set(visibleStaff().map((s) => s.id));
  const list = newestFirst(allSessions().filter((s) => ids.has(s.staffId)));

  host.appendChild(el("div", { class: "rp-scope" },
    icon("eye", 15),
    el("span", { class: "rp-scope-main" }, "閲覧範囲:", el("strong", {}, scopeLabel())),
    el("span", { class: "muted small" }, `対象 ${ids.size}名 / 記録 ${list.length}件`)));

  if (!list.length) {
    host.appendChild(el("div", { class: "card" }, emptyState({
      title: "閲覧できる練習記録がありません",
      hint: "担当メンバーがロープレ練習を記録すると、ここに表示されます",
    })));
    return;
  }

  /* スタッフ別平均 */
  const byStaff = new Map();
  for (const s of list) {
    if (!byStaff.has(s.staffId)) byStaff.set(s.staffId, []);
    byStaff.get(s.staffId).push(s.score);
  }
  const items = [...byStaff.entries()]
    .map(([sid, sc]) => {
      const st = store.byId("staff", sid);
      return {
        label: st?.name || "—",
        value: Math.round(sc.reduce((a, b) => a + b, 0) / sc.length),
        sub: `${sc.length}回`,
        color: st?.color,
      };
    })
    .sort((a, b) => b.value - a.value);
  host.appendChild(card({
    title: "スタッフ別の平均スコア", sub: "練習記録のある人のみ",
    body: hBars({ items, fmt: (v) => `${v}点` }),
  }));

  /* 一覧 */
  const unreviewed = list.filter((s) => !s.reviewedBy).length;
  host.appendChild(card({
    title: "練習記録の一覧",
    sub: unreviewed ? `未レビュー ${unreviewed}件` : "すべてレビュー済み",
    body: table({
      columns: [
        { key: "staff", label: "スタッフ", render: (r) => staffChip(r.staffId, { size: 28 }) },
        { key: "script", label: "スクリプト", render: (r) => el("span", { class: "rp-td-script" }, scriptTitle(r.scriptId)) },
        { key: "date", label: "日付", render: (r) => el("span", { class: "mono-num" }, fmtDate(r.date)) },
        { key: "score", label: "スコア", align: "center", render: (r) => scoreBadge(r.score) },
        {
          key: "rev", label: "レビュー", align: "center",
          render: (r) => (r.reviewedBy
            ? badge(`${store.staffName(r.reviewedBy)}`, "good")
            : badge("未レビュー", "warn", true)),
        },
      ],
      rows: list,
      onRowClick: (r) => sessionModal(r, { review: true }),
    }),
  }));
  host.appendChild(liveNote("行をクリックすると全文と指標を確認し、その場でフィードバックを送れます。"));
}

/* ============================================================
   セッション詳細モーダル
   ============================================================ */

function sessionModal(s, { review = false } = {}) {
  const sc = scriptById(s.scriptId);
  const me = store.me();
  const body = el("div", { class: "rp-modal" });
  const wrapper = el("div", { class: "page-roleplay" }, body);

  body.appendChild(el("div", { class: `rp-hero compact ${scoreTone(s.score)}` },
    scoreRing(s.score),
    el("div", { class: "rp-hero-body" },
      el("div", { class: "rp-hero-toprow" },
        el("span", { class: `rp-hero-word ${scoreTone(s.score)}` }, scoreWord(s.score))),
      el("div", { class: "rp-hero-title" }, scriptTitle(s.scriptId)),
      el("div", { class: "rp-hero-meta" },
        el("span", {}, icon("user", 13), store.staffName(s.staffId)),
        el("span", {}, icon("calendar", 13), fmtDate(s.date, { withYear: true })),
        el("span", {}, icon("clock", 13), fmtSec(s.durationSec)),
        sc ? el("span", {}, icon("book", 13), `${sc.category}・${sc.level}`) : null))));

  body.appendChild(el("h4", { class: "rp-h4" }, "4指標"));
  body.appendChild(metricsBlock(s.metrics));

  if (s.lineResults?.length) {
    body.appendChild(el("h4", { class: "rp-h4" }, "お手本との比較"));
    body.appendChild(comparisonNode(s.lineResults));
  }

  body.appendChild(el("h4", { class: "rp-h4" }, "書き起こし(全文)"));
  body.appendChild(el("div", { class: "rp-transcript-view" }, s.transcript || "(書き起こしなし)"));

  body.appendChild(el("h4", { class: "rp-h4" }, "AIフィードバック"));
  body.appendChild(feedbackNode(s.feedback));

  if (s.mentorComment && s.reviewedBy) {
    body.appendChild(el("h4", { class: "rp-h4" }, "メンターからのフィードバック"));
    body.appendChild(el("div", { class: "rp-mentor" },
      staffChip(s.reviewedBy, { size: 26 }),
      el("p", { class: "rp-mentor-text" }, s.mentorComment)));
  }

  let ta = null;
  if (review) {
    ta = el("textarea", {
      class: "textarea rp-review-ta", rows: "3",
      placeholder: "例:根拠の説明が丁寧になりました。次は「都度払いでも大丈夫」の一言を足しましょう。",
    });
    ta.value = s.mentorComment || "";
    body.appendChild(el("h4", { class: "rp-h4" }, "フィードバックを送る"));
    body.appendChild(el("div", { class: "stack", style: { gap: "8px" } },
      ta,
      el("span", { class: "hint" }, "保存すると本人の記録に「レビュー済」として表示されます")));
  }

  const closeBtn = el("button", { class: "btn ghost" }, "閉じる");
  const sendBtn = review ? el("button", { class: "btn primary" }, icon("send", 16), "フィードバックを送る") : null;

  const m = modal({
    title: "ロープレ記録の詳細",
    wide: true,
    body: wrapper,
    actions: sendBtn ? [closeBtn, sendBtn] : [closeBtn],
  });
  closeBtn.addEventListener("click", () => m.close());
  sendBtn?.addEventListener("click", () => {
    const text = ta.value.trim();
    if (!text) { toast("フィードバックを入力してください", "error"); return; }
    store.update("roleplaySessions", s.id, {
      reviewedBy: me.id, mentorComment: text, reviewedAt: todayStr(),
    });
    m.close();
    toast(`${store.staffName(s.staffId)}さんにフィードバックを送りました`);
    rerenderCurrent();
  });
}

/* ============================================================
   ページ本体
   ============================================================ */

function renderTab(host, tab) {
  if (tab === "mine") { mineView(host); return; }
  if (tab === "team") { teamView(host); return; }
  practiceView(host);
}

function renderPage(root, tab) {
  const me = store.me();
  const showTeam = can("roleplay.review");
  if (tab === "team" && !showTeam) tab = "practice";

  root.appendChild(sectionHeader(
    "ロープレ練習",
    "実際のトークスクリプトを見ながら録音し、AIがお手本と比較して採点・フィードバックします"));

  const mineCount = allSessions().filter((s) => s.staffId === me.id).length;
  const items = [
    { id: "practice", label: "練習する" },
    { id: "mine", label: "自分の記録", badge: mineCount || null },
  ];
  if (showTeam) {
    const ids = new Set(visibleStaff().map((s) => s.id));
    const n = allSessions().filter((s) => ids.has(s.staffId)).length;
    items.push({ id: "team", label: "みんなの記録", badge: n || null });
  }
  root.appendChild(tabs(items, tab, (id) => {
    location.hash = id === "practice" ? "#/roleplay" : `#/roleplay/${id}`;
  }));

  const host = el("div", { class: "rp-body" });
  root.appendChild(host);

  rerenderCurrent = () => renderTab(host, tab);
  renderTab(host, tab);
}

export default {
  id: "roleplay",
  title: "ロープレ練習",
  icon: "mic",

  // このページが必要とするデータ。ルーターがそろえてから render() を呼ぶ
  needs: ["roleplaySessions", "staff", "stores", "talkScripts"],
  render(root, params) {
    stopTimer();
    S.recording = false;
    const tab = ["practice", "mine", "team"].includes(params?.[0]) ? params[0] : "practice";
    renderPage(root, tab);
  },
};
