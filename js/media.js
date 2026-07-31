/* ============================================================
   メディア(写真・動画)プレースホルダー生成
   外部依存ゼロのまま「写真・動画を投稿できる」体験を成立させるため、
   シードから決定的に美しいSVG画像を生成する。
   実運用ではここを実ファイルのURL/サムネイルに差し替えるだけ。
   ============================================================ */

/* ---- 決定的ハッシュ ---- */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

/** シーンごとの配色(暖色系=くまのみブランドに馴染む) */
const PALETTES = [
  ["#f8a423", "#e2621a"], // サンセット
  ["#0c7489", "#0a4a5c"], // オーシャン
  ["#e87ba4", "#b8577f"], // ローズ
  ["#1baf7a", "#0d7a53"], // グリーン
  ["#4a3aa7", "#2d2270"], // パープル
  ["#eda100", "#c47a00"], // ゴールド
  ["#2a78d6", "#1a4f92"], // ブルー
  ["#d95926", "#a63d13"], // テラコッタ
];

/** 現場らしいシーンの絵文字 */
const SCENES = ["🤝", "🎉", "💪", "🌸", "📣", "🧑‍⚕️", "🏥", "✨", "🍰", "📸", "🌅", "🏆", "🧹", "📚", "💬", "🫶"];

/**
 * 写真プレースホルダーを data URI で返す
 * @param {string|number} seed 決定的な見た目を決める種
 * @param {object} opts { w, h, label }
 */
export function photoDataUri(seed, { w = 800, h = 600, label = "" } = {}) {
  const n = hash(seed);
  const [c1, c2] = PALETTES[n % PALETTES.length];
  const scene = SCENES[(n >>> 3) % SCENES.length];
  const angle = (n >>> 5) % 90;
  // 背景の丸(ボケ)を3つ散らす
  const blobs = [0, 1, 2].map((i) => {
    const bx = ((n >>> (i * 4 + 2)) % 100);
    const by = ((n >>> (i * 4 + 6)) % 100);
    const br = 12 + ((n >>> (i * 3 + 4)) % 22);
    return `<circle cx="${bx}%" cy="${by}%" r="${br}%" fill="#ffffff" opacity="0.12"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" gradientTransform="rotate(${angle})">
<stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>${blobs}
<text x="50%" y="${label ? "44%" : "50%"}" font-size="${Math.round(h * 0.28)}" text-anchor="middle" dominant-baseline="central">${scene}</text>
${label ? `<text x="50%" y="72%" font-size="${Math.round(h * 0.058)}" fill="#ffffff" opacity="0.9" font-family="sans-serif" font-weight="700" text-anchor="middle">${escapeXml(label)}</text>` : ""}
</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/** 動画のポスター(写真+フィルムの質感) */
export function videoPosterDataUri(seed, opts = {}) {
  const base = photoDataUri(seed, opts);
  return base; // ポスターは写真と同じ生成器を使い、再生UIはCSS側で重ねる
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
}

/** m.kind に応じた表示用URLを返す */
export function mediaSrc(m, opts = {}) {
  if (!m) return "";
  if (m.url) return m.url; // 実運用の実ファイル
  return photoDataUri(m.seed ?? m.id ?? "x", { label: m.caption || "", ...opts });
}

/** 秒 → 0:45 表記 */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** デモ用:添付候補のサンプル(投稿フォームの「写真/動画を選ぶ」で使う) */
export const SAMPLE_MEDIA = [
  { kind: "photo", seed: "team-morning", caption: "朝礼のひとコマ" },
  { kind: "photo", seed: "clean-room", caption: "施術室の整備" },
  { kind: "photo", seed: "birthday", caption: "スタッフのお祝い" },
  { kind: "photo", seed: "study", caption: "勉強会の様子" },
  { kind: "photo", seed: "welcome", caption: "新人さん歓迎" },
  { kind: "photo", seed: "award", caption: "表彰の瞬間" },
  { kind: "video", seed: "technique-demo", caption: "手技のデモ", durationSec: 42 },
  { kind: "video", seed: "message", caption: "応援メッセージ", durationSec: 18 },
  { kind: "video", seed: "training", caption: "研修ダイジェスト", durationSec: 65 },
];
