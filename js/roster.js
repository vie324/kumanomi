/* ============================================================
   組織図シートの解釈エンジン(ブラウザ側)

   supabase/migrations/0003_roster_import.sql と同じ規則で動く。
   画面のプレビューと、実際にSQLを流した結果がずれないよう、
   列の判定・氏名の解釈・上司の決め方はすべて SQL 側と対応させている。

   ・parseClipboardTable() … スプレッドシートから貼り付けた HTML を
     結合セル(rowspan/colspan)まで展開したグリッドにする。
     セルの背景色・文字色も持って帰るので、色から資格・性別を判定できる。
   ・parseSheet()          … グリッド(またはTSV)を店舗1行の形へ正規化
   ・buildRoster()         … 店舗・メンバー・傘(上司)を組み立てる
   ・toSQL()               … そのまま実行できる取込SQLを書き出す
   ============================================================ */

/* ---------------- 列の役割 ---------------- */

const COLUMN_ROLE_RULES = [
  [/統括MG|統括ＭＧ|統括マネージャ|統括マネジャ|ゼネラルマネージャ|^GM$/, "gm"],
  [/統括院長|エリア院長|ブロック院長/, "chief"],
  [/^(MG|ＭＧ)$|マネージャ|マネジャ|エリア長|エリアMG/, "mg"],
  [/カテゴリ|区分|業態|種別/, "category"],
  [/店舗|院名|拠点|サロン名/, "store"],
  [/院長/, "director"],
  [/受付/, "reception"],
  [/店長/, "beauty_manager"],
  [/美容|エステ/, "beauty"],
  [/整体|整骨|施術|治療|鍼灸/, "seitai"],
];

export const ROLE_LABELS = {
  gm: "統括MG", mg: "MG", chief: "統括院長", store: "店舗", category: "区分",
  director: "院長", seitai: "整体部門", reception: "受付スタッフ",
  beauty_manager: "店長", beauty: "美容部門",
};

/** 見出し文字列 → 列の役割(該当なしは null) */
export function columnRole(label) {
  const l = String(label ?? "").replace(/[\s　]/g, "");
  if (!l) return null;
  for (const [re, role] of COLUMN_ROLE_RULES) if (re.test(l)) return role;
  return null;
}

/* ---------------- セルの判定 ---------------- */

const BLANK_WORDS = new Set(["なし", "無し", "空き", "欠員", "未定", "募集中", "該当なし"]);

/** 空欄・ハイフン・「なし」など、人がいないセルか */
export function isBlankCell(cell) {
  const v = String(cell ?? "").replace(/[\s　]/g, "");
  return v === "" || /^[-—―ー‐−・※]+$/.test(v) || BLANK_WORDS.has(v);
}

const LICENSE_TOKENS = {
  柔: "judo", 柔整: "judo", 柔整師: "judo", 柔道整復: "judo", 柔道整復師: "judo", JU: "judo",
  鍼: "acupuncture", 針: "acupuncture", 鍼灸: "acupuncture", 鍼灸師: "acupuncture",
  はり: "acupuncture", きゅう: "acupuncture", 針灸: "acupuncture", AC: "acupuncture",
  整体: "seitai", 整体師: "seitai", SE: "seitai",
  エステ: "esthetic", エステティシャン: "esthetic", 美容: "esthetic", ES: "esthetic",
  受付: "reception", RE: "reception",
  無資格: "none", 資格なし: "none", なし: "none",
};
const GENDER_TOKENS = { 男: "male", 男性: "male", M: "male", m: "male", 女: "female", 女性: "female", F: "female", f: "female" };

export const LICENSE_LABELS = {
  judo: "柔道整復師", acupuncture: "鍼灸師", seitai: "整体師",
  esthetic: "エステティシャン", reception: "受付", none: "資格なし", unknown: "未確認",
};
export const GENDER_LABELS = { male: "男性", female: "女性", other: "その他", unknown: "未確認" };

/**
 * 氏名セルを分解する。
 *   「福井 仁太(柔整/男)」 → 注記として資格・性別を取り出す
 *   「浅見(山村) 彩雅」     → 括弧の中がトークンでなければ旧姓として扱い、氏名はそのまま残す
 *   「佐藤 真夢@2」         → 同姓同名の区別。@以降は氏名に含めない
 */
export function parsePersonCell(cell) {
  const raw = String(cell ?? "").replace(/[\s　]+/g, " ").trim();
  if (isBlankCell(raw)) return null;

  let name = raw;
  let license = null;
  let gender = null;

  // 1) 末尾の括弧が資格/性別トークンだけなら注記として取り除く
  const tail = name.match(/[（(【[]([^）)】\]]*)[）)】\]]\s*$/);
  if (tail && tail[1].trim()) {
    const tokens = tail[1].trim().split(/[/／・,、|＋+\s　]+/).filter(Boolean);
    let allKnown = tokens.length > 0;
    let lic = null, gen = null;
    for (const t of tokens) {
      const l = LICENSE_TOKENS[t], g = GENDER_TOKENS[t];
      if (!l && !g) { allKnown = false; break; }
      if (l) lic = l;
      if (g) gen = g;
    }
    if (allKnown) {
      license = lic;
      gender = gen;
      name = name.replace(/[（(【[][^）)】\]]*[）)】\]]\s*$/, "").trim();
    }
  }

  // 2) 同姓同名の区別用サフィックス
  let dedupe = "";
  const dm = name.match(/@([0-9A-Za-z_-]+)\s*$/);
  if (dm) { dedupe = dm[1]; name = name.replace(/@[0-9A-Za-z_-]+\s*$/, "").trim(); }

  // 3) 残った括弧は旧姓
  const former = (name.match(/[（(]([^）)]+)[）)]/) || [])[1] || null;
  if (!name) return null;

  return {
    fullName: name,
    nameKey: nameKey(name) + (dedupe ? `@${dedupe}` : ""),
    formerName: former,
    license: license || "unknown",
    gender: gender || "unknown",
    raw,
  };
}

/** 取込キー:空白と括弧内(旧姓)を落とした氏名 */
export function nameKey(name) {
  return String(name ?? "").replace(/[（(][^）)]*[）)]/g, "").replace(/[\s　]/g, "");
}

/* ---------------- 貼り付けの取り込み ---------------- */

const HEX = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** "rgb(1,2,3)" / "#abc" / "#aabbcc" → "#aabbcc"(判定不能は null) */
export function normalizeColor(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (!v || v === "transparent" || v === "inherit" || v === "initial") return null;
  const rgb = v.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const parts = rgb[1].split(",").map((x) => parseFloat(x));
    if (parts.length >= 4 && parts[3] === 0) return null;   // 完全な透明は「色なし」
    return `#${HEX(parts[0])}${HEX(parts[1])}${HEX(parts[2])}`;
  }
  const hex = v.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1];
    return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
  }
  if (v === "white") return "#ffffff";
  if (v === "black") return "#000000";
  return null;
}

function rgbOf(hex) {
  if (!hex) return null;
  return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}

/** 背景色から資格を推測する(白=柔整 / 緑=鍼灸 / ピンク=整体)
 *  凡例に無い色(水色・薄紫など)は決めつけず「未確認」にして、画面で選んでもらう。 */
export function guessLicenseFromBg(hex) {
  const c = rgbOf(hex);
  if (!c) return "judo";                                    // 色なし = 白 = 柔整師
  const { r, g, b } = c;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 12) return r > 200 ? "judo" : "unknown";   // 無彩色。明るければ白扱い
  if (g === max && g - Math.max(r, b) >= 8) return "acupuncture";  // 緑が突出 = 鍼灸師
  if (r === max && r - Math.max(g, b) >= 8) return "seitai";       // 赤/ピンクが突出 = 整体師
  return "unknown";                                          // 水色・薄紫など凡例外
}

/** 文字色から性別を推測する(青字=男性 / 赤字=女性) */
export function guessGenderFromColor(hex) {
  const c = rgbOf(hex);
  if (!c) return "unknown";
  const { r, g, b } = c;
  if (Math.max(r, g, b) - Math.min(r, g, b) < 30) return "unknown";  // ほぼ黒/グレー
  if (b > r + 25) return "male";
  if (r > b + 25) return "female";
  return "unknown";
}

/**
 * スプレッドシートから貼り付けた HTML をグリッドへ展開する。
 * rowspan / colspan を実際のセルに割り付けるので、
 * 結合された「統括MG」「MG」「統括院長」も各行に正しく行き渡る。
 * @returns {{grid: Array<Array<{text:string,bg:?string,fg:?string,merged:boolean}>>, hasColor: boolean}|null}
 */
export function parseClipboardTable(html) {
  if (!html || !/<t[dhr]\b|<table\b/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;

  const grid = [];
  let hasColor = false;
  const put = (r, c, cell) => {
    while (grid.length <= r) grid.push([]);
    const row = grid[r];
    while (row.length <= c) row.push(null);
    row[c] = cell;
  };

  const trs = [...table.querySelectorAll("tr")];
  trs.forEach((tr, r) => {
    let c = 0;
    for (const td of tr.children) {
      if (!/^(td|th)$/i.test(td.tagName)) continue;
      while (grid[r] && grid[r][c]) c++;                    // 上の行から伸びてきた結合セルを避ける
      const style = td.getAttribute("style") || "";
      const bg = normalizeColor(
        (style.match(/background(?:-color)?:\s*([^;]+)/i) || [])[1] || td.getAttribute("bgcolor"));
      const fg = normalizeColor((style.match(/(?:^|;)\s*color:\s*([^;]+)/i) || [])[1]);
      if (bg || fg) hasColor = true;
      const text = (td.textContent || "").replace(/ /g, " ").replace(/[\s　]+/g, " ").trim();
      const rs = Math.max(1, parseInt(td.getAttribute("rowspan") || "1", 10) || 1);
      const cs = Math.max(1, parseInt(td.getAttribute("colspan") || "1", 10) || 1);
      for (let dr = 0; dr < rs; dr++) {
        for (let dc = 0; dc < cs; dc++) {
          put(r + dr, c + dc, { text, bg, fg, merged: dr > 0 || dc > 0 });
        }
      }
      c += cs;
    }
  });

  const width = grid.reduce((m, row) => Math.max(m, row.length), 0);
  const filled = grid.map((row) => {
    const out = [];
    for (let i = 0; i < width; i++) out.push(row[i] || { text: "", bg: null, fg: null, merged: false });
    return out;
  });
  return filled.length ? { grid: filled, hasColor } : null;
}

/** タブ区切りテキストを同じ形のグリッドにする(色情報なし) */
export function parseTsvGrid(tsv) {
  const lines = String(tsv ?? "").replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[0].replace(/\t/g, "").trim()) lines.shift();
  const grid = lines.map((line) => line.split("\t").map((text) => ({ text: text.trim(), bg: null, fg: null, merged: false })));
  const width = grid.reduce((m, row) => Math.max(m, row.length), 0);
  return grid.map((row) => {
    const out = row.slice();
    while (out.length < width) out.push({ text: "", bg: null, fg: null, merged: false });
    return out;
  }).filter((row) => row.length);
}

/* ---------------- グリッド → 店舗ごとの行 ---------------- */

/**
 * グリッドを「店舗1件=1行」に正規化する。
 * @returns {{columns: Array<?string>, headerRows: number, rows: Array<Object>, warnings: string[]}}
 */
export function parseSheet(grid) {
  if (!grid || !grid.length) throw new Error("取り込む内容がありません。シートを貼り付けてください。");

  const text = (cell) => (cell ? cell.text : "");
  const warnings = [];

  // ---- 見出し(1行 or 2行)----
  const h1 = [];
  let fill = "";
  for (const cell of grid[0]) {
    const t = text(cell).trim();
    if (t) fill = t;                       // 結合された部門見出しを右へ引き継ぐ
    h1.push(fill);
  }
  let headerRows = 1;
  let h2 = [];
  if (grid.length >= 2) {
    const hits = grid[1].reduce((n, c) => n + (columnRole(text(c)) ? 1 : 0), 0);
    if (hits >= 2) { h2 = grid[1].map(text); headerRows = 2; }
  }

  const width = Math.max(h1.length, h2.length);
  const columns = [];
  for (let i = 0; i < width; i++) columns.push(columnRole((h2[i] || "").trim() || h1[i] || ""));

  if (!columns.includes("store")) {
    throw new Error(
      "見出し行が見つかりません。1行目(または2行目)に「統括MG / MG / 統括院長 / 店舗 / 院長 / 整体部門 / 受付スタッフ / 店長 / 美容部門」を含めてください。");
  }

  // ---- データ行 ----
  const rows = [];
  const carry = { gm: null, mg: null, chief: null };
  let open = null;

  const cellsFor = (row, role) => {
    const out = [];
    for (let i = 0; i < Math.min(row.length, columns.length); i++) {
      if (columns[i] === role) out.push(row[i]);
    }
    return out;
  };

  for (let r = headerRows; r < grid.length; r++) {
    const row = grid[r];
    if (!row.some((c) => text(c).trim())) continue;

    // 縦の結合セル:空欄は「上と同じ」、ハイフンや「なし」は「この階層は不在」
    for (const role of ["gm", "mg", "chief"]) {
      for (const cell of cellsFor(row, role)) {
        const v = text(cell).trim();
        if (!v) continue;
        carry[role] = isBlankCell(v) ? null : cell;
        break;
      }
    }

    const storeCell = cellsFor(row, "store").find((c) => !isBlankCell(text(c)));
    if (storeCell) {
      if (open) rows.push(open);
      open = {
        rowNo: rows.length + 1,
        store: text(storeCell).trim(),
        category: null,
        gm: null, mg: null, chief: null,
        director: null, beautyManager: null,
        seitai: [], reception: [], beauty: [],
      };
    } else if (!open) {
      continue;                             // 店舗が出てくる前の行は無視
    }

    open.gm = carry.gm; open.mg = carry.mg; open.chief = carry.chief;

    for (let i = 0; i < Math.min(row.length, columns.length); i++) {
      const role = columns[i];
      const cell = row[i];
      if (!role || isBlankCell(text(cell))) continue;
      if (role === "category") open.category = text(cell).trim();
      else if (role === "director" && !open.director) open.director = cell;
      else if (role === "beauty_manager" && !open.beautyManager) open.beautyManager = cell;
      else if (role === "seitai") open.seitai.push(cell);
      else if (role === "reception") open.reception.push(cell);
      else if (role === "beauty") open.beauty.push(cell);
    }
  }
  if (open) rows.push(open);

  if (!rows.length) warnings.push("店舗の行が1件も見つかりませんでした。「店舗」列に院名が入っているか確認してください。");
  return { columns, headerRows, rows, warnings };
}

/* ---------------- 役割の定義(SQL側と同じ) ---------------- */

/** 背景色から資格を判定しない列(美容部門・受付は部門色であることが多い) */
export const DEFAULT_LEGEND_SKIP = ["beauty", "beauty_manager", "reception"];

const ROLE_PRIORITY = { gm: 60, mg: 50, chief: 40, director: 30, beauty_manager: 25, reception: 12, seitai: 10, beauty: 10 };
const ROLE_RANK = { gm: "exec", mg: "area", chief: "chief", director: "manager", beauty_manager: "manager" };

export function inferStoreCategory(name, fallback = "整骨院") {
  const n = String(name || "");
  if (/美容|エステ|ビューティ/.test(n)) return "美容・エステ";
  if (/鍼灸|針灸|はりきゅう/.test(n)) return "鍼灸院";
  if (/整体/.test(n)) return "整体院";
  return fallback;
}

export function directorTitleOf(category) { return category === "美容・エステ" ? "店長" : "院長"; }

function departmentOfRole(role, category) {
  if (["gm", "mg", "chief"].includes(role)) return "management";
  if (role === "reception") return "reception";
  if (role === "beauty" || role === "beauty_manager") return "beauty";
  if (role === "director" && category === "美容・エステ") return "beauty";
  return "seitai";
}

function roleTitleOf(role, category, license) {
  if (role === "gm") return "統括マネージャー";
  if (role === "mg") return "マネージャー";
  if (role === "chief") return "統括院長";
  if (role === "director") return directorTitleOf(category);
  if (role === "beauty_manager") return "店長";
  if (role === "reception") return "受付";
  const byLicense = { judo: "柔道整復師", acupuncture: "鍼灸師", seitai: "整体師", esthetic: "エステティシャン", reception: "受付" }[license];
  return byLicense || (role === "beauty" ? "エステティシャン" : "スタッフ");
}

/* ---------------- 店舗・メンバー・傘の組み立て ---------------- */

/**
 * @param {Array} rows        parseSheet() の rows
 * @param {Object} [opts]
 * @param {Object} [opts.legend]  {bgMap:{hex:license}, fgMap:{hex:gender}} 色 → 属性の対応表
 * @param {string} [opts.defaultCategory]
 * @param {Object} [opts.overrides] {nameKey: {license, gender}} 手入力の上書き
 */
export function buildRoster(rows, opts = {}) {
  const { legend = null, defaultCategory = "整骨院", overrides = {} } = opts;
  const warnings = [];

  const stores = rows.map((r, i) => ({
    name: r.store,
    category: r.category || inferStoreCategory(r.store, defaultCategory),
    sortOrder: (i + 1) * 10,
    rowNo: r.rowNo,
  }));
  const storeByName = new Map(stores.map((s) => [s.name, s]));

  // ---- 1) 全セルを 1人1行に展開 ----
  const appearances = [];
  let seq = 0;
  for (const r of rows) {
    const push = (cell, role) => {
      if (!cell) return;
      const parsed = parsePersonCell(cell.text);
      if (!parsed) return;
      // 注記がなければ色から資格・性別を補う
      let { license, gender } = parsed;
      if (legend) {
        // 背景色の凡例(白/緑/ピンク)は整体部門のためのもの。
        // 美容部門・受付は部門ごとの塗り分けであることが多いので既定では使わない。
        const skip = legend.skipRoles || DEFAULT_LEGEND_SKIP;
        if (license === "unknown" && legend.bgMap && !skip.includes(role)) {
          const hit = legend.bgMap[cell.bg || "__none__"];
          if (hit && hit !== "unknown") license = hit;
        }
        if (gender === "unknown" && legend.fgMap) {
          const hit = legend.fgMap[cell.fg || "__none__"];
          if (hit && hit !== "unknown") gender = hit;
        }
      }
      appearances.push({ ...parsed, license, gender, role, rowNo: r.rowNo, store: r.store, seq: seq++ });
    };
    push(r.gm, "gm");
    push(r.mg, "mg");
    push(r.chief, "chief");
    push(r.director, "director");
    push(r.beautyManager, "beauty_manager");
    r.seitai.forEach((c) => push(c, "seitai"));
    r.reception.forEach((c) => push(c, "reception"));
    r.beauty.forEach((c) => push(c, "beauty"));
  }

  // ---- 2) 同じ人をまとめ、いちばん強い役職を採用 ----
  const byKey = new Map();
  for (const a of appearances) {
    let m = byKey.get(a.nameKey);
    if (!m) {
      m = {
        nameKey: a.nameKey, fullName: a.fullName, formerName: a.formerName,
        license: "unknown", gender: "unknown",
        role: a.role, seq: a.seq, rowNo: a.rowNo,
        appearances: [],
      };
      byKey.set(a.nameKey, m);
    }
    m.appearances.push(a);
    if (a.formerName && !m.formerName) m.formerName = a.formerName;
    if (m.license === "unknown" && a.license !== "unknown") m.license = a.license;
    if (m.gender === "unknown" && a.gender !== "unknown") m.gender = a.gender;
    if (ROLE_PRIORITY[a.role] > ROLE_PRIORITY[m.role]) { m.role = a.role; m.seq = a.seq; m.rowNo = a.rowNo; }
  }

  const members = [...byKey.values()].map((m) => {
    const ov = overrides[m.nameKey] || {};
    const onSite = m.appearances.find((a) => ["director", "beauty_manager", "seitai", "reception", "beauty"].includes(a.role));
    const homeName = (onSite || m.appearances[0]).store;
    const store = storeByName.get(homeName) || null;
    const category = store?.category || defaultCategory;
    const license = ov.license || m.license;
    const gender = ov.gender || m.gender;
    return {
      nameKey: m.nameKey,
      fullName: m.fullName,
      formerName: m.formerName,
      license, gender,
      rank: ROLE_RANK[m.role] || "staff",
      role: m.role,
      rowNo: m.rowNo,
      roleTitle: roleTitleOf(m.role, category, license),
      department: departmentOfRole(m.role, category),
      storeName: store?.name || null,
      sortOrder: m.seq,
      appearances: m.appearances,
    };
  }).sort((a, b) => a.sortOrder - b.sortOrder);

  const memberByKey = new Map(members.map((m) => [m.nameKey, m]));

  // ---- 3) 上司(傘)を決める ----
  const rowByNo = new Map(rows.map((r) => [r.rowNo, r]));
  const keyOf = (cell) => {
    if (!cell || isBlankCell(cell.text)) return null;
    const p = parsePersonCell(cell.text);
    return p ? p.nameKey : null;
  };

  for (const m of members) {
    const r = rowByNo.get(m.rowNo);
    const gm = keyOf(r?.gm), mg = keyOf(r?.mg), chief = keyOf(r?.chief);
    const dir = keyOf(r?.director), bm = keyOf(r?.beautyManager);
    const candidates = {
      gm: [],
      mg: [gm],
      chief: [mg, gm],
      director: [chief, mg, gm],
      beauty_manager: [dir, chief, mg, gm],
      beauty: [bm, dir, chief, mg, gm],
    }[m.role] || [dir, chief, mg, gm];
    m.managerKey = candidates.find((k) => k && k !== m.nameKey) || null;
  }

  // 循環していないか(組織図の付け替えミスや同姓同名で起きうる)
  for (const m of members) {
    const seen = new Set([m.nameKey]);
    let cur = m.managerKey;
    while (cur) {
      if (seen.has(cur)) {
        warnings.push(`「${m.fullName}」の上司をたどると輪になっています。上位の役職名を確認してください。`);
        m.managerKey = null;
        break;
      }
      seen.add(cur);
      cur = memberByKey.get(cur)?.managerKey || null;
    }
  }

  // ---- 4) 店舗の責任者 ----
  for (const r of rows) {
    const s = storeByName.get(r.store);
    if (!s) continue;
    s.generalManagerKey = keyOf(r.gm);
    s.areaManagerKey = keyOf(r.mg);
    s.chiefDirectorKey = keyOf(r.chief);
    s.directorKey = keyOf(r.director);
    s.beautyManagerKey = keyOf(r.beautyManager);
  }

  // ---- 5) 点検 ----
  const roots = members.filter((m) => !m.managerKey);
  if (roots.length > 1) {
    warnings.push(`組織のトップが ${roots.length} 人います(${roots.map((r) => r.fullName).join("・")})。統括MG列が空の行がないか確認してください。`);
  }
  if (!roots.length && members.length) warnings.push("組織のトップが特定できませんでした。統括MG列を確認してください。");
  for (const s of stores) {
    if (!s.directorKey) warnings.push(`「${s.name}」に${directorTitleOf(s.category)}が設定されていません。`);
  }
  const dupNames = new Map();
  for (const m of members) {
    const list = dupNames.get(m.fullName) || [];
    list.push(m.nameKey);
    dupNames.set(m.fullName, list);
  }
  for (const [name, keys] of dupNames) {
    if (keys.length > 1) warnings.push(`「${name}」が別人として ${keys.length} 件あります。同姓同名なら氏名のうしろに @2 を付けて区別してください。`);
  }

  return {
    stores,
    members,
    roots,
    warnings,
    unknownLicense: members.filter((m) => m.license === "unknown"),
    unknownGender: members.filter((m) => m.gender === "unknown"),
  };
}

/** members から親子の木を作る(プレビュー描画用) */
export function toTree(members) {
  const byKey = new Map(members.map((m) => [m.nameKey, { ...m, children: [] }]));
  const roots = [];
  for (const node of byKey.values()) {
    const parent = node.managerKey ? byKey.get(node.managerKey) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/* ---------------- SQL の書き出し ---------------- */

/** SQL のドルクォート内に安全に埋め込めるタグを選ぶ */
function dollarTag(body, base = "sheet") {
  let tag = base;
  let i = 1;
  while (body.includes(`$${tag}$`)) tag = `${base}${i++}`;
  return tag;
}

/**
 * 取込SQLを書き出す。members の資格・性別は注記として氏名に付け直すので、
 * 画面で色から判定した結果・手で直した結果がそのまま SQL に載る。
 */
export function toSQL(rows, roster, opts = {}) {
  const {
    deactivateMissing = false,
    defaultCategory = "整骨院",
    preserveManualEdits = true,
    sourceLabel = "組織図スプレッドシート",
  } = opts;

  const attrOf = new Map(roster.members.map((m) => [m.nameKey, m]));
  const annotate = (cell) => {
    if (!cell || isBlankCell(cell.text)) return "";
    const parsed = parsePersonCell(cell.text);
    if (!parsed) return "";
    const m = attrOf.get(parsed.nameKey);
    const tokens = [];
    if (m && m.license !== "unknown") tokens.push({ judo: "柔整", acupuncture: "鍼灸", seitai: "整体", esthetic: "エステ", reception: "受付", none: "無資格" }[m.license]);
    if (m && m.gender !== "unknown") tokens.push(m.gender === "male" ? "男" : "女");
    const suffix = tokens.length ? `(${tokens.join("/")})` : "";
    const dedupe = parsed.nameKey.includes("@") ? `@${parsed.nameKey.split("@")[1]}` : "";
    return `${parsed.fullName}${dedupe}${suffix}`;
  };

  const widths = rows.reduce((w, r) => ({
    seitai: Math.max(w.seitai, r.seitai.length),
    reception: Math.max(w.reception, r.reception.length),
    beauty: Math.max(w.beauty, r.beauty.length),
  }), { seitai: 1, reception: 1, beauty: 1 });

  const pad = (arr, n) => { const a = arr.map(annotate).slice(0, n); while (a.length < n) a.push(""); return a; };

  const h1 = ["", "", "", "", "", "整体部門", ...Array(widths.seitai - 1).fill(""),
    "受付スタッフ", ...Array(widths.reception - 1).fill(""), "美容部門", ...Array(widths.beauty).fill("")];
  const h2 = ["統括MG", "MG", "統括院長", "店舗", "院長", ...Array(widths.seitai).fill(""),
    ...Array(widths.reception).fill(""), "店長", ...Array(widths.beauty).fill("")];

  const lines = [h1.join("\t"), h2.join("\t")];
  for (const r of rows) {
    const cells = [
      annotate(r.gm), annotate(r.mg), r.chief ? annotate(r.chief) : "-",
      r.store, annotate(r.director),
      ...pad(r.seitai, widths.seitai),
      ...pad(r.reception, widths.reception),
      annotate(r.beautyManager),
      ...pad(r.beauty, widths.beauty),
    ];
    lines.push(cells.join("\t").replace(/\t+$/, ""));
  }
  const sheet = lines.join("\n");
  const tag = dollarTag(sheet);
  const stamp = new Date().toISOString().slice(0, 10);

  return `-- ============================================================
-- くまのみ 統合ポータル — メンバー・組織図の一括登録
-- 生成日: ${stamp}
-- 店舗 ${roster.stores.length} 件 / メンバー ${roster.members.length} 名
--
-- 前提: supabase/migrations/0001〜0004 を適用済みであること
-- 実行: psql "$DATABASE_URL" -f このファイル
--       もしくは Supabase SQL Editor に貼り付けて実行
--
-- 氏名のうしろの (柔整/男) は資格と性別の注記。
-- 元シートのセル色から自動判定したものを書き出している。
-- ============================================================

select public.import_roster_sheet(
  $${tag}$
${sheet}
$${tag}$,
  jsonb_build_object(
    'deactivate_missing',    ${deactivateMissing},
    'default_category',      '${defaultCategory}',
    'preserve_manual_edits', ${preserveManualEdits}
  ),
  '${String(sourceLabel).replace(/'/g, "''")}'
);

-- 取り込み結果の確認
--   select repeat('  ', depth) || full_name || ' 【' || role_title || '】'
--     from public.v_org_tree order by sort_path, name_path;
--   select * from public.v_store_roster order by name;
`;
}

/** 貼り付け内容(HTML優先・なければTSV)をグリッドにする */
export function gridFromPaste({ html, text }) {
  const fromHtml = html ? parseClipboardTable(html) : null;
  if (fromHtml && fromHtml.grid.length) return fromHtml;
  return { grid: parseTsvGrid(text || ""), hasColor: false };
}

/** グリッド内に出てくる色を集計する(凡例エディタ用) */
export function collectColors(grid, columns, headerRows) {
  const bg = new Map();
  const fg = new Map();
  const bump = (map, key, sample) => {
    const e = map.get(key) || { key, count: 0, samples: [] };
    e.count++;
    if (sample && e.samples.length < 4 && !e.samples.includes(sample)) e.samples.push(sample);
    map.set(key, e);
  };
  for (let r = headerRows; r < grid.length; r++) {
    for (let c = 0; c < Math.min(grid[r].length, columns.length); c++) {
      const role = columns[c];
      if (!role || ["store", "category"].includes(role)) continue;
      const cell = grid[r][c];
      if (!cell || isBlankCell(cell.text)) continue;
      bump(bg, cell.bg || "__none__", cell.text);
      bump(fg, cell.fg || "__none__", cell.text);
    }
  }
  const sort = (m) => [...m.values()].sort((a, b) => b.count - a.count);
  return { bg: sort(bg), fg: sort(fg) };
}
