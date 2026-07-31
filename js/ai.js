/* ============================================================
   KUMANOMI AI — デモ用 AI エンジン(擬似)
   実運用では LLM API(Claude 等)に置き換える想定の抽象化レイヤー。
   すべて async で、体感のため少し待ってから結果を返す。
   ============================================================ */

import { store, addDays, dow, SHIFT_TYPES } from "./store.js";

export const delay = (ms = 900) => new Promise((r) => setTimeout(r, ms));

/* ---------------- シフト自動作成 ---------------- */

/**
 * 希望・必要人数・研修予定から1週間分のシフト案を生成する。
 * @returns [{staffId, date, type}]
 */
export async function generateShift({ weekStart, storeId }) {
  await delay(1400);
  const staff = store.get("staff").filter((s) => s.storeId === storeId);
  const rules = store.get("staffingRules").find((r) => r.storeId === storeId);
  const requests = store.get("shiftRequests").filter((r) => r.weekOf === weekStart);
  const trainings = store.get("trainings");
  const out = [];
  for (let d = 0; d < 7; d++) {
    const date = addDays(weekStart, d);
    const wd = dow(date);
    if (wd === (rules?.closedDow ?? 3)) {
      staff.forEach((s) => out.push({ staffId: s.id, date, type: "off" }));
      continue;
    }
    const need = (wd === 0 || wd === 6) ? (rules?.weekend || { early: 3, late: 2 }) : (rules?.weekday || { early: 2, late: 2 });
    // 希望を優先しつつ、必要人数を埋める
    const wishes = {};
    for (const rq of requests) {
      if (rq.wishes[date] && staff.some((s) => s.id === rq.staffId)) wishes[rq.staffId] = rq.wishes[date];
    }
    const training = trainings.find((t) => t.date === date);
    const assigned = {};
    staff.forEach((s) => {
      if (training && training.attendees?.some((a) => a.staffId === s.id && a.status !== "欠席")) assigned[s.id] = "training";
      else if (wishes[s.id]) assigned[s.id] = wishes[s.id];
    });
    let earlyCount = Object.values(assigned).filter((t) => t === "early" || t === "full").length;
    let lateCount = Object.values(assigned).filter((t) => t === "late" || t === "full").length;
    // 未割当メンバーで充足
    const free = staff.filter((s) => !assigned[s.id]);
    // 公平性:直近の休み数が少ない人から休みを与える
    for (const s of free) {
      if (earlyCount < need.early) { assigned[s.id] = "early"; earlyCount++; }
      else if (lateCount < need.late) { assigned[s.id] = "late"; lateCount++; }
      else assigned[s.id] = "off";
    }
    staff.forEach((s) => out.push({ staffId: s.id, date, type: assigned[s.id] || "off" }));
  }
  return out;
}

/** シフト案の説明文 */
export function shiftRationale(storeId) {
  const st = store.storeName(storeId);
  return `【AI作成メモ】${st}の必要人数(平日:早番2・遅番2/土日:早番3・遅番2)と提出済みの希望、研修予定を制約条件として自動割当しました。水曜は定休です。希望はすべて反映済み。承認前にドラッグ感覚で個別調整できます。`;
}

/* ---------------- ボイス入力 → SOAP ---------------- */

const VOICE_SAMPLES = [
  "えー、岡田さん本日3回目の施術です。前回より腰の張りはだいぶ楽になったとのことですが、朝起きた時のこわばりがまだ残っていると。触診では右の腰方形筋にまだ圧痛があります。可動域は前屈が指先床から10センチまで改善。今日は骨盤の調整と腰部のリリースを中心に行いました。次回は1週間後、セルフストレッチは継続でお願いします。",
  "施術後メモです。首の可動域、左回旋がまだ70度くらい。僧帽筋上部の緊張が強いので、今日は頸部のモビライゼーションとストレッチを実施。デスクワーク中の休憩を1時間に1回入れるように指導しました。経過は良好です。次回2週間後に再評価します。",
];

export function sampleVoiceTranscript(i = 0) {
  return VOICE_SAMPLES[i % VOICE_SAMPLES.length];
}

/**
 * 音声書き起こしテキスト → SOAP 形式に整形
 */
export async function voiceToSoap(transcript) {
  await delay(1600);
  const t = transcript || VOICE_SAMPLES[0];
  const pickSent = (kw, fallback) => {
    const sent = t.split(/[。\n]/).find((s) => kw.some((k) => s.includes(k)));
    return sent ? sent.trim() + "。" : fallback;
  };
  return {
    subjective: pickSent(["とのこと", "訴え", "残っている", "楽に"], "自覚症状は改善傾向。"),
    objective: pickSent(["触診", "圧痛", "可動域", "度"], "他覚所見:筋緊張は軽減傾向。"),
    assessment: "経過は良好。残存する筋緊張と朝のこわばりに対し、継続的なアプローチが必要と判断。",
    plan: pickSent(["次回", "指導", "継続", "ストレッチ"], "現行プランを継続。") ,
  };
}

/* ---------------- カルテ → 患者様向けメッセージ(LINE) ---------------- */

export async function kartePatientMessage(patient, karte) {
  await delay(1300);
  const staffName = store.staffName(karte.staffId);
  const ticket = patient.tickets?.[0];
  const ticketLine = ticket ? `\n■ 回数券の残り:${ticket.total - ticket.used}回(${ticket.name})` : "";
  return `${patient.name}様\n\n本日もご来院ありがとうございました。${staffName}です😊\n\n■ 本日の施術\n${karte.assessment}\n\n■ おうちでのセルフケア\n${karte.plan}\n\n■ 姿勢分析の結果\n${karte.posture ? `姿勢スコア ${karte.posture.score}点。前回より肩の高さの左右差が改善しています。写真を添付しますのでご確認ください📷` : "次回、最新の姿勢写真を撮影させていただきます。"}${ticketLine}\n\n気になることがあれば、このLINEにいつでもご返信ください。\n次回のご来院をお待ちしております!`;
}

/* ---------------- 面談メモ → 要約 ---------------- */

export async function summarizeInterview(notes) {
  await delay(1500);
  const t = notes || "";
  const problems = [];
  const actions = [];
  if (t.includes("時間")) { problems.push("施術・業務の時間配分に課題"); actions.push("説明パートを施術前5分に分離するテンプレを試行"); }
  if (t.includes("勉強") || t.includes("テスト") || t.includes("学習")) { problems.push("学習方法が確立できていない"); actions.push("AIテストの週次5問モードで反復学習を習慣化"); }
  if (t.includes("シフト") || t.includes("参加できない") || t.includes("難しい")) { problems.push("研修・勉強会への参加制約"); actions.push("開催時間帯の見直しをシフト作成条件に反映"); }
  if (t.includes("目標") || t.includes("数値")) { problems.push("個人目標が曖昧で振り返りが浅い"); actions.push("月次15分の目標確認ミーティングを設定"); }
  if (!problems.length) { problems.push("大きな問題は検出されず(順調)"); actions.push("現在の取り組みを継続し、次回面談で経過確認"); }
  return {
    problems,
    causes: ["業務プロセスが個人のスキルに依存している", "フィードバックの頻度が不足している"].slice(0, problems.length),
    actions,
    mood: t.includes("落ち込") || t.includes("不安") ? "ややネガティブ。強みの言語化と小さな成功体験のフォローを推奨。" : "前向き。現状の方向性を維持。",
  };
}

/* ---------------- 会議メモ → 議事録 ---------------- */

export async function summarizeMeeting(minutes, meeting) {
  await delay(1700);
  const lines = (minutes || "").split(/\n/).map((s) => s.replace(/^[・\-\s]+/, "").trim()).filter(Boolean);
  const decisions = lines.filter((l) => /(実施|決定|導入|廃止|変更|統一|開始)/.test(l)).slice(0, 4);
  const carry = lines.filter((l) => /(確認|検討|持ち越し|調整)/.test(l)).slice(0, 3);
  const summary = lines.slice(0, 3).join("/") || "記録から要点を抽出できませんでした。メモを追記してください。";
  const actionItems = carry.map((c, i) => ({
    id: `ai-gen-${Date.now()}-${i}`,
    title: c.length > 40 ? c.slice(0, 40) + "…" : c,
    ownerId: meeting?.attendees?.[i % (meeting.attendees.length || 1)] || store.state.currentUserId,
    due: addDays(store.state.generatedAt, 7),
    status: "todo",
  }));
  return {
    summary: `【要点】${summary}`,
    decisions: decisions.length ? decisions : ["(決定事項は検出されませんでした)"],
    actionItems,
  };
}

/* ---------------- 日報コメント要約(管理者向け) ---------------- */

export async function summarizeReports(reports) {
  await delay(1400);
  const totalRev = reports.reduce((a, r) => a + r.revenue, 0);
  const contracts = reports.reduce((a, r) => a + r.contracts, 0);
  const proposals = reports.reduce((a, r) => a + r.proposals, 0);
  const rate = proposals ? Math.round((contracts / proposals) * 100) : 0;
  const comments = reports.map((r) => r.comment).filter(Boolean);
  const highlight = comments.find((c) => c.includes("即決") || c.includes("好調")) || comments[0] || "";
  const concern = comments.find((c) => c.includes("空き") || c.includes("課題") || c.includes("見直")) || "";
  return {
    summary: `対象${reports.length}件:売上合計 ¥${totalRev.toLocaleString("ja-JP")}、成約${contracts}件(提案${proposals}件・成約率${rate}%)。`,
    highlight: highlight ? `👍 好調要因:「${highlight}」` : "👍 好調要因:安定した施術数を維持。",
    concern: concern ? `⚠️ 気になる声:「${concern}」` : "⚠️ 気になる声:特筆事項なし。",
    advice: rate >= 70
      ? "成約率が高水準です。提案の型を朝礼で共有し、他店へ横展開しましょう。"
      : "提案後のクロージングでの離脱が見られます。「施術計画への納得→金額提示」の順序を徹底しましょう。",
  };
}

/* ---------------- テスト自動生成 ---------------- */

const QUESTION_BANK = {
  解剖学: [
    { q: "肩甲骨の内側縁に付着する筋はどれか?", choices: ["前鋸筋", "三角筋", "上腕二頭筋", "広背筋"], answer: 0, explanation: "前鋸筋は肋骨から起こり肩甲骨内側縁に停止。翼状肩甲に関与する。" },
    { q: "大腿四頭筋に含まれない筋はどれか?", choices: ["大腿直筋", "内側広筋", "縫工筋", "中間広筋"], answer: 2, explanation: "縫工筋は大腿四頭筋には含まれない独立した筋。" },
    { q: "脊柱起立筋の最も外側に位置する筋はどれか?", choices: ["棘筋", "最長筋", "腸肋筋", "多裂筋"], answer: 2, explanation: "外側から腸肋筋・最長筋・棘筋の順に並ぶ。" },
    { q: "足関節の内反に作用する筋はどれか?", choices: ["長腓骨筋", "前脛骨筋", "第三腓骨筋", "短腓骨筋"], answer: 1, explanation: "前脛骨筋は背屈+内反。腓骨筋群は外反に作用する。" },
    { q: "胸鎖乳突筋の作用として正しいのはどれか?", choices: ["両側収縮で頸部伸展のみ", "一側収縮で同側回旋", "一側収縮で反対側回旋", "作用しない"], answer: 2, explanation: "一側収縮では反対側への回旋+同側側屈。" },
  ],
  接遇: [
    { q: "電話予約で最初に伝えるべき情報はどれか?", choices: ["料金", "院名と自分の名前", "空き状況", "アクセス"], answer: 1, explanation: "名乗りが先。安心感と責任の所在を最初に示す。" },
    { q: "クレーム対応で最初にすべきことは?", choices: ["原因の説明", "謝罪と傾聴", "責任者への転送", "割引の提案"], answer: 1, explanation: "まず不快にさせたことへの謝罪と傾聴。事実確認はその後。" },
    { q: "施術終了後の適切な見送りはどれか?", choices: ["会計だけ済ませる", "次回予約の確認と体調の声かけ", "他メニューの営業", "アンケート依頼のみ"], answer: 1, explanation: "次回計画の確認+体調への気遣いで来院体験を締めくくる。" },
  ],
  骨盤矯正: [
    { q: "上前腸骨棘(ASIS)の触診で確認できるのはどれか?", choices: ["骨盤の前後傾", "膝関節の変形", "頸椎の弯曲", "肩甲骨の位置"], answer: 0, explanation: "左右のASISとPSISの位置関係から骨盤の傾きを評価する。" },
    { q: "骨盤前傾で短縮しやすい筋はどれか?", choices: ["腹直筋", "ハムストリングス", "腸腰筋", "大殿筋"], answer: 2, explanation: "前傾では腸腰筋・脊柱起立筋が短縮、腹筋群・大殿筋が伸長弱化(下位交差症候群)。" },
    { q: "産後の骨盤ケアで施術を避けるべき時期は?", choices: ["産後1ヶ月未満(健診前)", "産後3ヶ月", "産後6ヶ月", "産後1年"], answer: 0, explanation: "産後1ヶ月健診で問題がないことを確認してから開始するのが原則。" },
  ],
};

export async function makeTest(topic, count = 5) {
  await delay(1800);
  const bank = QUESTION_BANK[topic] || QUESTION_BANK["解剖学"];
  const questions = bank.slice(0, count);
  return {
    title: `${topic}チェックテスト(AI自動作成)`,
    topic,
    createdBy: "AI",
    questions,
  };
}

export function testTopics() { return Object.keys(QUESTION_BANK); }

/* ---------------- 姿勢分析(33ポイント自動検出) ---------------- */

/**
 * 33ランドマークの座標(0-100の相対座標)を擬似生成する。
 * 実運用では MediaPipe Pose 等の姿勢推定モデルを想定。
 */
export async function analyzePosture(seed = 1) {
  await delay(1900);
  const jitter = (n) => n + Math.sin(seed * 7.13 + n * 1.7) * 1.6;
  // 正面向き人体の33ポイント(頭部5・肩2・肘2・手首2・腰2・膝2・足首2 など簡略配置)
  const base = [
    ["鼻", 50, 8], ["左目", 47, 6.5], ["右目", 53, 6.5], ["左耳", 44.5, 8], ["右耳", 55.5, 8],
    ["口左", 48, 10.5], ["口右", 52, 10.5],
    ["左肩", 38, 20], ["右肩", 62, 21.2], ["左肘", 33, 33], ["右肘", 67, 34],
    ["左手首", 30, 45], ["右手首", 70, 46], ["左小指", 29, 49], ["右小指", 71, 50],
    ["左人差指", 28.5, 48.5], ["右人差指", 71.5, 49.5], ["左親指", 30.5, 48], ["右親指", 69.5, 49],
    ["左腰", 42, 48], ["右腰", 58, 48.8], ["左膝", 41, 66], ["右膝", 59, 66.5],
    ["左足首", 40.5, 84], ["右足首", 59.5, 84.3], ["左かかと", 40, 87.5], ["右かかと", 60, 87.8],
    ["左爪先", 39, 91], ["右爪先", 61, 91.2],
    ["左肩甲骨", 40, 24], ["右肩甲骨", 60, 25], ["胸骨", 50, 24], ["骨盤中心", 50, 48.4],
  ];
  const points = base.map(([label, x, y], i) => ({ id: i, label, x: jitter(x), y: y + Math.cos(seed * 3.1 + i) * 0.7 }));
  const L = (name) => points.find((p) => p.label === name);
  const shoulderDiff = +(L("右肩").y - L("左肩").y).toFixed(1);
  const pelvisTilt = +(L("右腰").y - L("左腰").y).toFixed(1);
  const headForward = +Math.abs(L("鼻").x - 50).toFixed(1);
  const score = Math.max(40, Math.min(96, Math.round(92 - Math.abs(shoulderDiff) * 8 - Math.abs(pelvisTilt) * 9 - headForward * 4)));
  return {
    points,
    detectedPoints: 33,
    score,
    shoulderDiff, pelvisTilt, headForward,
    comments: [
      Math.abs(shoulderDiff) > 0.8 ? `肩の高さに左右差があります(${shoulderDiff > 0 ? "右" : "左"}下がり ${Math.abs(shoulderDiff)}cm相当)` : "肩の高さはほぼ左右対称です",
      Math.abs(pelvisTilt) > 0.8 ? `骨盤に傾きが見られます(${pelvisTilt > 0 ? "右" : "左"}下がり)` : "骨盤の傾きは正常範囲内です",
      headForward > 1.2 ? "頭部の前方偏位傾向があります。ストレートネックに注意" : "頭部の位置は良好です",
    ],
  };
}

/* ---------------- AI チャット(使い方アシスタント) ---------------- */

export async function chatReply(text) {
  await delay(1100);
  const t = (text || "").toLowerCase();
  const faqs = store.get("faq");
  // キーワードマッチでスコアリング
  let best = null, bestScore = 0;
  for (const f of faqs) {
    const score = f.keywords.reduce((a, k) => a + (text.includes(k) ? 1 : 0), 0);
    if (score > bestScore) { best = f; bestScore = score; }
  }
  if (best) return { text: best.a, source: `FAQ: ${best.q}` };

  if (/(こんにち|こんばん|おはよう|はじめまして)/.test(text)) {
    return { text: "こんにちは!くまのみポータルのAIアシスタントです。\n\nシステムの使い方、シフトや日報のルール、患者様対応のフローなど、何でも日本語で質問してください。\n\n例:「シフト希望はどこから出す?」「回数券の残数を確認したい」「ボイス入力の使い方は?」" };
  }
  if (/(ありがとう|助かった)/.test(text)) {
    return { text: "どういたしまして!他にも気になることがあればいつでも聞いてください😊" };
  }
  return {
    text: "うまく該当するFAQが見つかりませんでした🙏\n\n以下のような聞き方だとお答えしやすいです:\n・「GPS打刻ができない」\n・「経費の申請方法は?」\n・「テストはどこから受けられる?」\n\nこのまま質問を管理者に転送することもできます(デモでは省略)。実運用ではここが Claude API に接続され、マニュアル全文を参照して回答します。",
  };
}

/* ---------------- ロールプレイ:スクリプト比較 + フィードバック ---------------- */

/** 練習用のサンプル書き起こし(録音のシミュレーション) */
export function sampleRoleplaySpeech(script, quality = "mid") {
  const lines = script?.lines || [];
  if (quality === "high") return lines.map((l) => l.text).join("");
  if (quality === "low") return lines.slice(0, Math.max(1, Math.floor(lines.length / 2))).map((l) => l.text.slice(0, 28) + "…").join("");
  // mid: 一部を要約・省略し、フィラーを混ぜる
  return lines.map((l, i) => {
    if (i === lines.length - 1) return "";
    const t = l.text.replace(/いただけますか|でしょうか/g, "ですか");
    return (i === 1 ? "えーっと、" : "") + t;
  }).join("");
}

/**
 * 発話をトークスクリプトと比較して採点する。
 * 実運用では音声認識 + LLM 評価に置き換わる部分。
 */
export async function evaluateRoleplay(script, transcript) {
  await delay(1900);
  const text = (transcript || "").replace(/\s+/g, "");
  const lines = script?.lines || [];

  // 1. カバレッジ:各行のキーワードがどれだけ含まれているか
  const lineResults = lines.map((l) => {
    const kws = l.keywords || [];
    const hit = kws.filter((k) => text.includes(k));
    const ratio = kws.length ? hit.length / kws.length : 1;
    return {
      text: l.text,
      keywords: kws,
      hitKeywords: hit,
      missKeywords: kws.filter((k) => !text.includes(k)),
      status: ratio >= 0.75 ? "ok" : ratio >= 0.34 ? "partial" : "missing",
      ratio,
    };
  });
  const coverage = Math.round((lineResults.reduce((a, r) => a + r.ratio, 0) / (lineResults.length || 1)) * 100);

  // 2. フィラー(えーっと・あの・まあ 等)
  const fillerWords = ["えーっと", "えっと", "あのー", "あの、", "まあ", "なんか", "ええと"];
  const filler = fillerWords.reduce((a, w) => a + (transcript.split(w).length - 1), 0);

  // 3. ペース:想定尺に対する文字数(日本語はおよそ 6文字/秒)
  const expectedChars = (script?.durationSec || 90) * 6;
  const paceRatio = text.length / expectedChars;
  const pace = Math.max(30, Math.round(100 - Math.abs(1 - paceRatio) * 90));

  // 4. 共感表現
  const empathyWords = ["ありがとう", "いかが", "お忙しい", "無理のない", "ご不明", "大丈夫", "お聞かせ", "つらい"];
  const empathyHit = empathyWords.filter((w) => text.includes(w)).length;
  const empathy = Math.min(100, Math.round((empathyHit / 4) * 100));

  const score = Math.max(0, Math.min(100, Math.round(
    coverage * 0.55 + pace * 0.15 + empathy * 0.2 + Math.max(0, 100 - filler * 15) * 0.1
  )));

  // フィードバック生成
  const good = [];
  const improve = [];
  if (coverage >= 80) good.push("スクリプトの要点をほぼ網羅できています");
  else if (coverage >= 55) good.push("話の骨格は押さえられています");
  if (filler === 0) good.push("フィラーがゼロで、落ち着いた話し方ができています");
  if (empathy >= 75) good.push("患者様を受け止める言葉が自然に入っています");
  if (pace >= 80) good.push("話す量と時間のバランスが適切です");
  if (!good.length) good.push("最後まで話し切れています。まずはここからです");

  const missed = lineResults.filter((r) => r.status !== "ok");
  for (const m of missed.slice(0, 3)) {
    improve.push(`「${m.text.slice(0, 26)}…」の要素が不足しています(不足キーワード:${m.missKeywords.join("・") || "表現全般"})`);
  }
  if (filler >= 3) improve.push(`「えーっと」などのフィラーが${filler}回。言葉に詰まったら黙って間を取る練習をしましょう`);
  if (paceRatio > 1.35) improve.push("説明が長くなりがちです。1文を短く区切ると伝わりやすくなります");
  if (paceRatio < 0.65) improve.push("説明が駆け足です。根拠や具体例を足して丁寧に伝えましょう");
  if (empathy < 50) improve.push("共感を示すフレーズ(「いかがでしょうか」「ありがとうございます」)を挟むと印象が大きく変わります");
  if (!improve.length) improve.push("大きな改善点はありません。この内容を安定して再現できるか、もう一度録音してみましょう");

  const nextAction = missed.length
    ? `不足していた「${missed[0].missKeywords[0] || missed[0].text.slice(0, 12)}」を意識して、もう一度録音してみましょう。`
    : "同じ内容を、患者様役に相槌を入れてもらいながら実演してみましょう。";

  return {
    score,
    metrics: { coverage, pace, filler, empathy },
    lineResults,
    feedback: { good, improve, nextAction },
  };
}

/** クイック質問チップ */
export function quickQuestions() {
  return [
    "シフト希望はどこから出せますか?",
    "GPS打刻ができません",
    "カルテのボイス入力の使い方は?",
    "回数券の残数はどこで確認できますか?",
    "経費の申請方法は?",
    "姿勢分析の使い方は?",
  ];
}
