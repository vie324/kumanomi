/* ============================================================
   KUMANOMI Seed Data
   実行日を基準に、デモ用のリアルなダミーデータ一式を生成する。
   すべての ID は文字列。日付は 'YYYY-MM-DD'、時刻は 'HH:MM'。
   ============================================================ */

// ---- 決定的な擬似乱数(リロードしても同じデモデータになる) ----
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260730);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const ri = (min, max) => Math.floor(rnd() * (max - min + 1)) + min;

// ---- 日付ヘルパー ----
const pad = (n) => String(n).padStart(2, "0");
export function dstr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function addDays(dateStr, n) {
  const [y, m, dd] = dateStr.split("-").map(Number);
  const d = new Date(y, m - 1, dd + n);
  return dstr(d);
}
export function todayStr() { return dstr(new Date()); }
export function monthOf(dateStr) { return dateStr.slice(0, 7); }
export function dow(dateStr) {
  const [y, m, dd] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, dd).getDay(); // 0=日
}
/** その週の月曜日を返す */
export function mondayOf(dateStr) {
  const w = dow(dateStr);
  return addDays(dateStr, w === 0 ? -6 : 1 - w);
}

const TODAY = todayStr();
const iso = (dateStr, hm) => `${dateStr}T${hm}:00`;

// ============================================================
// マスターデータ
// ============================================================

const stores = [
  { id: "st-narimasu", name: "成増店", short: "成増", isPilot: true, phone: "03-5967-xxxx", address: "東京都板橋区成増2-XX-X", lat: 35.7772, lng: 139.632, openHour: "10:00", closeHour: "20:00", color: "#2a78d6" },
  { id: "st-omiya", name: "大宮店", short: "大宮", isPilot: false, phone: "048-641-xxxx", address: "埼玉県さいたま市大宮区桜木町1-XX", lat: 35.9063, lng: 139.6242, openHour: "10:00", closeHour: "20:00", color: "#eb6834" },
  { id: "st-kawagoe", name: "川越店", short: "川越", isPilot: false, phone: "049-224-xxxx", address: "埼玉県川越市脇田町X-X", lat: 35.9086, lng: 139.4823, openHour: "10:00", closeHour: "20:00", color: "#1baf7a" },
  { id: "st-urawa", name: "浦和店", short: "浦和", isPilot: false, phone: "048-813-xxxx", address: "埼玉県さいたま市浦和区高砂1-XX", lat: 35.8598, lng: 139.6574, openHour: "10:00", closeHour: "20:00", color: "#eda100" },
];

const staff = [
  { id: "s01", name: "佐藤 健太", kana: "さとう けんた", role: "院長", storeId: "st-narimasu", color: "#0c7489", points: 320, joined: "2019-04-01", licenses: ["柔道整復師"], skills: { 技術: 4.6, 接客: 4.2, 数値: 4.0, 理念: 4.8, 協調: 4.4 }, rank: "manager" },
  { id: "s02", name: "鈴木 美咲", kana: "すずき みさき", role: "柔道整復師", storeId: "st-narimasu", color: "#c2547e", points: 415, joined: "2022-04-01", licenses: ["柔道整復師"], skills: { 技術: 3.8, 接客: 4.7, 数値: 3.5, 理念: 4.2, 協調: 4.6 }, rank: "mentor", mentorId: "s01", menteeIds: ["s11", "s06"] },
  { id: "s03", name: "田中 大輔", kana: "たなか だいすけ", role: "鍼灸師", storeId: "st-narimasu", color: "#4a3aa7", points: 268, joined: "2021-10-01", licenses: ["はり師", "きゅう師"], skills: { 技術: 4.3, 接客: 3.6, 数値: 3.9, 理念: 3.8, 協調: 4.0 }, rank: "staff", mentorId: "s01" },
  { id: "s04", name: "高橋 由美", kana: "たかはし ゆみ", role: "受付", storeId: "st-narimasu", color: "#b0771a", points: 388, joined: "2020-07-01", licenses: [], skills: { 技術: 3.0, 接客: 4.9, 数値: 3.4, 理念: 4.5, 協調: 4.8 }, rank: "staff", mentorId: "s01" },
  { id: "s05", name: "伊藤 翔太", kana: "いとう しょうた", role: "院長", storeId: "st-omiya", color: "#1f7a4d", points: 295, joined: "2018-04-01", licenses: ["柔道整復師"], skills: { 技術: 4.7, 接客: 4.0, 数値: 4.4, 理念: 4.3, 協調: 4.1 }, rank: "manager" },
  { id: "s06", name: "渡辺 花子", kana: "わたなべ はなこ", role: "柔道整復師", storeId: "st-omiya", color: "#d95926", points: 342, joined: "2023-04-01", licenses: ["柔道整復師"], skills: { 技術: 3.4, 接客: 4.4, 数値: 3.2, 理念: 4.0, 協調: 4.5 }, rank: "staff", mentorId: "s02" },
  { id: "s07", name: "山本 拓海", kana: "やまもと たくみ", role: "院長", storeId: "st-kawagoe", color: "#2a78d6", points: 251, joined: "2019-10-01", licenses: ["柔道整復師", "はり師"], skills: { 技術: 4.5, 接客: 3.9, 数値: 4.2, 理念: 4.1, 協調: 3.9 }, rank: "manager" },
  { id: "s08", name: "中村 さくら", kana: "なかむら さくら", role: "鍼灸師", storeId: "st-kawagoe", color: "#a83a52", points: 377, joined: "2022-10-01", licenses: ["はり師", "きゅう師"], skills: { 技術: 4.0, 接客: 4.6, 数値: 3.6, 理念: 4.4, 協調: 4.7 }, rank: "mentor", mentorId: "s07", menteeIds: ["s03"] },
  { id: "s09", name: "小林 誠", kana: "こばやし まこと", role: "統括マネージャー", storeId: "st-narimasu", color: "#3d4f6b", points: 198, joined: "2017-04-01", licenses: ["柔道整復師"], skills: { 技術: 4.2, 接客: 4.1, 数値: 4.8, 理念: 4.6, 協調: 4.3 }, rank: "exec" },
  { id: "s10", name: "加藤 恵", kana: "かとう めぐみ", role: "マネージャー", storeId: "st-omiya", color: "#7b5cc4", points: 289, joined: "2019-04-01", licenses: ["柔道整復師"], skills: { 技術: 4.1, 接客: 4.5, 数値: 4.5, 理念: 4.2, 協調: 4.6 }, rank: "area", areaStoreIds: ["st-omiya", "st-urawa"] },
  { id: "s11", name: "吉田 陽菜", kana: "よしだ ひな", role: "柔道整復師", storeId: "st-urawa", color: "#0f8f7a", points: 305, joined: "2024-04-01", licenses: ["柔道整復師"], skills: { 技術: 3.2, 接客: 4.3, 数値: 3.0, 理念: 3.9, 協調: 4.4 }, rank: "staff", mentorId: "s02" },
  { id: "s12", name: "山口 蓮", kana: "やまぐち れん", role: "院長", storeId: "st-urawa", color: "#c46a1f", points: 233, joined: "2020-04-01", licenses: ["柔道整復師"], skills: { 技術: 4.4, 接客: 3.8, 数値: 4.1, 理念: 4.0, 協調: 3.8 }, rank: "manager" },
  { id: "s13", name: "森 あかり", kana: "もり あかり", role: "本部人事", storeId: "st-narimasu", color: "#5b6f8a", points: 120, joined: "2021-04-01", licenses: [], skills: { 技術: 2.0, 接客: 4.4, 数値: 4.7, 理念: 4.5, 協調: 4.6 }, rank: "hr" },
];

/** 施術者(受付・本部職を除く) */
const practitioners = staff.filter((s) => ["院長", "柔道整復師", "鍼灸師"].includes(s.role));

const menus = [
  { id: "m1", name: "整体スタンダード(60分)", minutes: 60, price: 6600 },
  { id: "m2", name: "骨盤矯正(45分)", minutes: 45, price: 5500 },
  { id: "m3", name: "鍼灸施術(60分)", minutes: 60, price: 7700 },
  { id: "m4", name: "全身整体プレミアム(90分)", minutes: 90, price: 9350 },
  { id: "m5", name: "初回検査・カウンセリング(75分)", minutes: 75, price: 3300 },
  { id: "m6", name: "産後骨盤ケア(60分)", minutes: 60, price: 6600 },
];

const philosophy = {
  mission: "身体の悩みに寄り添い、地域の一人ひとりが自分らしく動ける毎日をつくる。",
  values: [
    "患者様の「痛みの先の人生」を見る",
    "仲間への感謝を言葉にする",
    "数字は誠実さのものさし",
    "学び続ける者だけが手技を語れる",
    "地域に必要とされる院であれ",
  ],
};

// ============================================================
// 患者
// ============================================================

const patientDefs = [
  ["p01", "岡田 真由美", "おかだ まゆみ", 58, "F", "st-narimasu", ["慢性腰痛", "回数券"], true, "low"],
  ["p02", "藤井 康弘", "ふじい やすひろ", 45, "M", "st-narimasu", ["肩こり", "デスクワーク"], true, "low"],
  ["p03", "村上 彩", "むらかみ あや", 33, "F", "st-narimasu", ["産後骨盤", "回数券"], true, "low"],
  ["p04", "石川 隆", "いしかわ たかし", 67, "M", "st-narimasu", ["膝痛", "変形性膝関節症"], false, "mid"],
  ["p05", "松本 里奈", "まつもと りな", 27, "F", "st-narimasu", ["姿勢改善", "ストレートネック"], true, "low"],
  ["p06", "井上 和夫", "いのうえ かずお", 72, "M", "st-narimasu", ["坐骨神経痛", "回数券"], false, "high"],
  ["p07", "木村 千夏", "きむら ちなつ", 41, "F", "st-narimasu", ["頭痛", "眼精疲労"], true, "mid"],
  ["p08", "斎藤 悠人", "さいとう ゆうと", 19, "M", "st-narimasu", ["スポーツ障害", "野球肘"], true, "low"],
  ["p09", "清水 敏江", "しみず としえ", 63, "F", "st-omiya", ["五十肩", "回数券"], false, "mid"],
  ["p10", "阿部 直樹", "あべ なおき", 38, "M", "st-omiya", ["ぎっくり腰", "交通事故"], true, "low"],
  ["p11", "森田 響子", "もりた きょうこ", 52, "F", "st-kawagoe", ["自律神経", "鍼灸"], true, "low"],
  ["p12", "原口 大地", "はらぐち だいち", 29, "M", "st-kawagoe", ["腰椎ヘルニア", "回数券"], true, "high"],
  ["p13", "横山 郁美", "よこやま いくみ", 47, "F", "st-urawa", ["肩こり", "巻き肩"], false, "low"],
  ["p14", "西野 剛", "にしの つよし", 55, "M", "st-urawa", ["腰痛", "ゴルフ"], true, "mid"],
];

const chiefComplaints = {
  p01: "長時間の立ち仕事後に腰が重だるくなる",
  p02: "夕方になると首から肩にかけて張りが強い",
  p03: "産後から骨盤まわりの不安定感と恥骨痛",
  p04: "階段の下りで右膝内側に痛み",
  p05: "スマホ使用時の首の前傾と猫背が気になる",
  p06: "左臀部から太もも裏へのしびれ",
  p07: "こめかみを締め付けられるような頭痛が週2回",
  p08: "投球時に肘の内側が痛む",
  p09: "右肩が挙上90度で引っかかる",
  p10: "重い物を持ち上げた際に腰に激痛",
  p11: "寝つきが悪く、常に肩に力が入っている",
  p12: "前屈で左腰から下肢に放散痛",
  p13: "デスクワーク後の肩甲骨内側の痛み",
  p14: "ゴルフのスイング後に腰が抜ける感じ",
};

function makePatients() {
  return patientDefs.map(([id, name, kana, age, gender, storeId, tags, lineLinked, churnRisk], idx) => {
    const first = addDays(TODAY, -ri(90, 560));
    const hasTicket = tags.includes("回数券");
    const total = pick([8, 10, 12]);
    const used = churnRisk === "high" ? ri(2, 4) : ri(4, total - 1);
    return {
      id, name, kana, age, gender, storeId, tags, lineLinked, churnRisk,
      phone: `090-${1000 + idx * 137}-${2000 + idx * 251}`,
      firstVisit: first,
      lastVisit: addDays(TODAY, churnRisk === "high" ? -ri(35, 60) : -ri(1, 12)),
      visitCount: ri(6, 42),
      tickets: hasTicket
        ? [{ id: `tk-${id}`, name: `回数券${total}回コース`, total, used, price: total * 5800, purchased: addDays(TODAY, -ri(30, 120)), expires: addDays(TODAY, ri(60, 210)) }]
        : [],
      memo: "",
    };
  });
}

// ============================================================
// カルテ(施術録)
// ============================================================

const subjectiveBank = [
  "前回施術後、2〜3日は楽だったが週末にかけて張りが戻ってきたとのこと。",
  "痛みは10段階で6→4に軽減。朝のこわばりはまだ残る。",
  "仕事が繁忙期でセルフストレッチができていなかったと申告あり。",
  "睡眠時間が確保でき、全体的に調子が良いとのこと。",
  "長時間の運転後に症状が強く出る傾向を自覚している。",
];
const objectiveBank = [
  "右僧帽筋上部に強い圧痛。C5-6レベルで可動域制限あり。",
  "腰椎前弯減少。SLRテスト左60度で陽性。",
  "骨盤右回旋変位。右腸骨稜が約1cm挙上。",
  "肩甲骨内側縁に筋緊張。胸椎伸展制限あり。",
  "股関節内旋可動域 左右差15度。臀筋群の筋力低下を認める。",
];
const assessmentBank = [
  "デスクワークによる不良姿勢が主因。頸部深層屈筋の弱化を伴う。",
  "骨盤帯の安定性低下により腰部への負担が増大していると判断。",
  "回復傾向。セルフケアの定着で再発予防フェーズへ移行可能。",
  "筋緊張は軽減傾向だが、可動域改善が次の課題。",
  "負荷動作時の代償パターンが残存。体幹安定化が必要。",
];
const planBank = [
  "週1回の施術を4週継続。自宅でのチンタック運動を指導。",
  "骨盤矯正を中心に施術。次回、姿勢分析の再評価を実施。",
  "施術間隔を2週に延長。EMSによる体幹強化を提案。",
  "鍼施術を併用し深層筋にアプローチ。温熱指導あり。",
  "ストレッチ指導(大腿後面・臀部)。1日2回実施を依頼。",
];

function postureFor(seedIdx) {
  // 姿勢分析サマリー(33ポイント自動検出の解析結果)
  const lr = () => (ri(0, 22) - 11) / 10; // -1.1〜+1.1cm
  return {
    score: ri(58, 92),
    shoulderDiff: lr(),      // 肩の高さ左右差 cm(+は右が高い)
    pelvisTilt: lr(),        // 骨盤傾き cm
    headForward: ri(8, 42) / 10, // 頭部前方偏位 cm
    kneeDiff: lr(),
    detectedPoints: 33,
  };
}

function makeKarte(patients) {
  const karte = [];
  let k = 1;
  for (const p of patients) {
    const n = ri(2, 4);
    for (let i = 0; i < n; i++) {
      const date = i === 0 ? p.lastVisit : addDays(p.lastVisit, -ri(7, 18) * (i));
      const staffId = pick(practitioners.filter((s) => s.storeId === p.storeId).map((s) => s.id)) || "s01";
      karte.push({
        id: `k${String(k++).padStart(3, "0")}`,
        patientId: p.id,
        staffId,
        date,
        menuId: pick(menus.slice(0, 4)).id,
        chief: chiefComplaints[p.id],
        subjective: pick(subjectiveBank),
        objective: pick(objectiveBank),
        assessment: pick(assessmentBank),
        plan: pick(planBank),
        photos: i === 0 ? [
          { id: `ph-${p.id}-f`, label: "正面", angle: "front" },
          { id: `ph-${p.id}-s`, label: "側面", angle: "side" },
        ] : [],
        posture: i === 0 ? postureFor(k) : null,
        voiceTranscript: null,
        aiPatientMessage: null,
        sentToLine: i === 0 && p.lineLinked && rnd() > 0.5,
        ticketUsed: p.tickets.length > 0,
      });
    }
  }
  return karte;
}

// ============================================================
// 予約(前後2週間)
// ============================================================

const slotTimes = ["10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00"];

function makeReservations(patients) {
  const res = [];
  let r = 1;
  for (let dOff = -14; dOff <= 14; dOff++) {
    const date = addDays(TODAY, dOff);
    if (dow(date) === 3) continue; // 水曜定休
    for (const st of stores) {
      const staffHere = practitioners.filter((s) => s.storeId === st.id);
      const count = st.id === "st-narimasu" ? ri(5, 8) : ri(3, 6);
      const used = new Set();
      for (let i = 0; i < count; i++) {
        const start = pick(slotTimes);
        const sf = pick(staffHere);
        const key = `${sf.id}-${start}`;
        if (used.has(key)) continue;
        used.add(key);
        const menu = pick(menus);
        const pt = rnd() > 0.16 ? pick(patients.filter((p) => p.storeId === st.id)) : null;
        const endH = Number(start.slice(0, 2)) + Math.ceil(menu.minutes / 60);
        let status = "confirmed";
        if (dOff < 0) status = rnd() > 0.08 ? "done" : (rnd() > 0.5 ? "cancelled" : "noshow");
        res.push({
          id: `r${String(r++).padStart(3, "0")}`,
          patientId: pt ? pt.id : null,
          guestName: pt ? null : pick(["新規:川口様", "新規:白石様", "新規:三浦様", "新規:内藤様"]),
          storeId: st.id,
          staffId: sf.id,
          date, start,
          end: `${pad(Math.min(endH, 20))}:${start.slice(3)}`,
          menuId: menu.id,
          status,
          source: pick(["LINE", "LINE", "電話", "店頭", "Web"]),
          note: "",
        });
      }
    }
  }
  return res;
}

// ============================================================
// シフト・勤怠
// ============================================================

const SHIFT_TYPES = {
  early: { label: "早番", start: "09:30", end: "19:00" },
  late: { label: "遅番", start: "11:00", end: "20:30" },
  full: { label: "通し", start: "09:30", end: "20:30" },
  training: { label: "研修", start: "10:00", end: "17:00" },
  off: { label: "休み", start: null, end: null },
};

function makeShifts() {
  const shifts = [];
  let n = 1;
  const start = addDays(mondayOf(TODAY), -21); // 3週間前の月曜〜
  for (let i = 0; i < 35; i++) { // 5週分
    const date = addDays(start, i);
    for (const sf of staff) {
      let type;
      const wd = dow(date);
      if (wd === 3) type = "off"; // 水曜定休
      else if (rnd() < 0.18) type = "off";
      else if (rnd() < 0.06) type = "training";
      else type = pick(["early", "early", "late", "full"]);
      shifts.push({ id: `sh${String(n++).padStart(4, "0")}`, staffId: sf.id, date, type });
    }
  }
  return shifts;
}

function makeAttendance(shifts) {
  const att = [];
  let n = 1;
  for (const sh of shifts) {
    if (sh.date >= TODAY || sh.type === "off") continue;
    const t = SHIFT_TYPES[sh.type];
    const late = rnd() < 0.05;
    const missing = rnd() < 0.04;
    const inH = Number(t.start.slice(0, 2));
    const inM = Number(t.start.slice(3)) + (late ? ri(3, 18) : -ri(2, 14));
    const inTime = `${pad(inH + Math.floor(Math.max(inM, 0) / 60))}:${pad(((inM % 60) + 60) % 60)}`;
    const outM = Number(t.end.slice(3)) + ri(0, 25);
    const outTime = `${pad(Number(t.end.slice(0, 2)) + Math.floor(outM / 60))}:${pad(outM % 60)}`;
    att.push({
      id: `at${String(n++).padStart(4, "0")}`,
      staffId: sh.staffId,
      date: sh.date,
      shiftType: sh.type,
      clockIn: missing ? null : inTime,
      clockOut: missing && rnd() > 0.5 ? null : outTime,
      breakMin: 60,
      status: missing ? "missing" : late ? "late" : "normal",
      gpsOk: !missing,
      approved: sh.date < addDays(TODAY, -7),
      note: missing ? "打刻漏れ" : late ? "電車遅延" : "",
    });
  }
  return att;
}

function makeShiftRequests() {
  const nextMon = addDays(mondayOf(TODAY), 7);
  return staff.slice(0, 8).map((sf, i) => ({
    id: `sr${i + 1}`,
    staffId: sf.id,
    weekOf: nextMon,
    wishes: {
      [addDays(nextMon, ri(0, 6))]: "off",
      [addDays(nextMon, ri(0, 6))]: "late",
    },
    note: pick(["", "", "土曜は早番希望です", "研修参加のため17時退勤希望", ""]),
    submittedAt: addDays(TODAY, -ri(0, 3)),
  }));
}

// ============================================================
// 日報・KPI
// ============================================================

function makeDailyReports() {
  const reports = [];
  let n = 1;
  for (let dOff = -30; dOff <= 0; dOff++) {
    const date = addDays(TODAY, dOff);
    if (dow(date) === 3) continue;
    for (const sf of practitioners) {
      if (rnd() < 0.12) continue; // 休みの日
      const treatments = ri(4, 9);
      const newPatients = rnd() < 0.55 ? ri(0, 2) : 0;
      const proposals = Math.max(newPatients + (rnd() < 0.3 ? 1 : 0), 0); // 回数券提案数
      const contracts = proposals > 0 ? ri(0, proposals) : 0;
      const revenue = treatments * ri(5200, 7800) + contracts * 58000;
      const isToday = dOff === 0;
      reports.push({
        id: `dr${String(n++).padStart(4, "0")}`,
        staffId: sf.id,
        storeId: sf.storeId,
        date,
        revenue,
        treatments,
        newPatients,
        proposals,
        contracts,
        goods: rnd() < 0.3 ? ri(1, 3) * 2800 : 0,
        comment: pick([
          "新規の方が回数券を即決してくださった。ヒアリングの型が効いている。",
          "リピーター様の状態が安定。次回から間隔を空ける提案をした。",
          "夕方の枠が空きがち。LINE配信のタイミングを見直したい。",
          "問診で聞き切れなかった部分があり、次回深掘りする。",
          "物販(骨盤ベルト)の説明で興味を持っていただけた。",
          "",
        ]),
        aiSummary: null,
        status: isToday && rnd() < 0.5 ? "draft" : "submitted",
      });
    }
  }
  return reports;
}

function makeKpiMonthly() {
  const arr = [];
  const [ty, tm] = TODAY.split("-").map(Number);
  for (let back = 7; back >= 0; back--) {
    const d = new Date(ty, tm - 1 - back, 1);
    const month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    for (const st of stores) {
      const base = st.id === "st-narimasu" ? 6200000 : st.id === "st-omiya" ? 5400000 : 4600000;
      const season = 1 + 0.08 * Math.sin((d.getMonth() + 1) / 12 * Math.PI * 2);
      const growth = 1 + (7 - back) * 0.012;
      const revenue = Math.round(base * season * growth * (0.92 + rnd() * 0.16));
      arr.push({
        id: `kpi-${st.id}-${month}`,
        storeId: st.id,
        month,
        revenue,
        target: Math.round(base * growth * 1.02),
        patients: ri(340, 520),
        newPatients: ri(22, 48),
        contracts: ri(12, 30),
        contractRate: ri(58, 86),
        digestion: ri(68, 92),   // 回数券消化率%
        repeatRate: ri(72, 91),
        avgSpend: ri(6200, 8400),
      });
    }
  }
  return arr;
}

// ============================================================
// 社内SNS
// ============================================================

const channels = [
  { id: "ch-all", name: "全体連絡", icon: "📣", desc: "全店舗向けの公式アナウンス" },
  { id: "ch-recruit", name: "採用委員会", icon: "🤝", desc: "採用活動・面接調整・母集団づくり" },
  { id: "ch-marketing", name: "マーケ委員会", icon: "📈", desc: "集客・LINE配信・キャンペーン企画" },
  { id: "ch-philosophy", name: "理念浸透委員会", icon: "🧭", desc: "理念の言語化と浸透施策" },
  { id: "ch-env", name: "環境委員会", icon: "🌿", desc: "院内環境・衛生・備品" },
  { id: "ch-tech", name: "技術委員会", icon: "✋", desc: "手技研鑽・症例共有・技術研修運営" },
  { id: "ch-traffic", name: "交通事故委員会", icon: "🚗", desc: "交通事故対応・保険手続きの知見共有" },
];

function makePosts() {
  const posts = [];
  let n = 1;
  const P = (obj) => posts.push({ id: `po${String(n++).padStart(3, "0")}`, likes: [], comments: [], pinned: false, ...obj });

  P({ type: "notice", channelId: "ch-all", authorId: "s09", date: iso(TODAY, "08:45"), pinned: true,
    title: "【重要】成増店ダッシュボード先行導入について",
    body: "本日より成増店で新ポータル「くまのみポータル」のテスト運用を開始します。日報・勤怠・カルテはすべて本システムに一本化します。操作で迷ったら右下のAIアシスタントに日本語で質問してください。" });
  P({ type: "chourei", channelId: "ch-all", authorId: "s01", date: iso(TODAY, "09:32"),
    title: `朝礼メモ(成増店)`,
    body: "本日の予約18件。14時に新規の方(紹介)がご来院予定です。今週の理念テーマは「仲間への感謝を言葉にする」。退勤前にサンクスカードを1枚以上送りましょう。", likes: ["s02", "s03", "s04"] });
  P({ type: "thanks", authorId: "s02", toId: "s04", points: 30, date: iso(addDays(TODAY, -1), "19:42"),
    body: "予約が重なってバタバタしていた時、受付とお会計を完璧に回してくれてありがとうございました!安心して施術に集中できました🙏", likes: ["s01", "s03", "s09"] });
  P({ type: "thanks", authorId: "s04", toId: "s02", points: 20, date: iso(addDays(TODAY, -1), "20:05"),
    body: "患者様への説明がとても丁寧で、待合で「あの先生に会うと元気になる」と仰っていました。私も見習います!", likes: ["s01", "s05"] });
  P({ type: "thanks", authorId: "s05", toId: "s06", points: 30, date: iso(addDays(TODAY, -2), "18:30"),
    body: "急な欠員の穴を埋めてくれて本当に助かりました。おかげでキャンセルゼロで回せました。", likes: ["s10", "s09"] });
  P({ type: "philosophy", channelId: "ch-philosophy", authorId: "s09", date: iso(addDays(TODAY, -2), "08:50"),
    title: "今週の理念テーマ",
    body: "「数字は誠実さのものさし」。数字を追うのは売上のためではなく、患者様への提案が届いたかを確かめるためです。今週のマネージャー会議で各店の好事例を共有します。", likes: ["s01", "s05", "s07", "s12"] });
  P({ type: "committee", channelId: "ch-tech", authorId: "s07", date: iso(addDays(TODAY, -3), "21:10"),
    title: "8月 技術研修のテーマ決め",
    body: "次回の技術研修は「胸椎モビライゼーション」を予定しています。参加必須回です。事前に骨盤矯正実技チェック(テスト機能)を受けておいてください。", likes: ["s01", "s03"] });
  P({ type: "committee", channelId: "ch-marketing", authorId: "s10", date: iso(addDays(TODAY, -4), "12:20"),
    title: "LINE配信の反応レポート",
    body: "先週の「夏の疲れリセットキャンペーン」配信、開封率41%・予約転換9件でした。次回は離反リスク患者様向けのリマインド配信をテストします(顧客管理のAIリスト連携)。", likes: ["s09", "s05", "s04"] });
  P({ type: "committee", channelId: "ch-recruit", authorId: "s09", date: iso(addDays(TODAY, -5), "17:45"),
    title: "新卒採用 面接日程",
    body: "8月の一次面接は大宮店で実施します。面接官担当できる院長は今週中にコメントで教えてください。", likes: [],
    comments: [
      { id: "c1", authorId: "s05", body: "8/6と8/8なら対応できます。", date: iso(addDays(TODAY, -5), "18:20") },
      { id: "c2", authorId: "s12", body: "8/8参加します。", date: iso(addDays(TODAY, -4), "09:12") },
    ] });
  P({ type: "notice", channelId: "ch-env", authorId: "s04", date: iso(addDays(TODAY, -6), "16:00"),
    title: "フェイスタオルの在庫について",
    body: "成増店のフェイスタオル在庫が発注点を下回りました。在庫管理画面から発注済みです。到着まで大宮店から20枚借用します。", likes: ["s09"] });
  P({ type: "thanks", authorId: "s08", toId: "s07", points: 20, date: iso(addDays(TODAY, -6), "19:55"),
    body: "難しい症例の相談に乗っていただき、施術方針がクリアになりました。患者様の経過も良好です!", likes: ["s11"] });
  P({ type: "committee", channelId: "ch-traffic", authorId: "s05", date: iso(addDays(TODAY, -8), "20:15"),
    title: "交通事故対応フロー更新",
    body: "保険会社への施術情報提供書のテンプレートを更新しました。カルテ画面のAI要約をそのまま添付できるようになっています。", likes: ["s01", "s07", "s12"] });
  P({ type: "chourei", channelId: "ch-all", authorId: "s05", date: iso(addDays(TODAY, -1), "09:31"),
    title: "朝礼メモ(大宮店)",
    body: "本日予約14件。回数券の消化期限が近い患者様が3名います。来院時に次回コースのご案内を。", likes: ["s10"] });
  P({ type: "notice", channelId: "ch-all", authorId: "s09", date: iso(addDays(TODAY, -9), "10:00"),
    title: "8月の研修日程",
    body: "技術研修 8/5(火)・鍼研修 8/19(火)・接遇座学 8/26(火)。技術研修と鍼研修は該当職種は必須参加です。シフトは研修枠で自動確保されます。", likes: ["s02", "s06", "s08", "s11"] });
  return posts;
}

// ============================================================
// 会議・議事録
// ============================================================

function makeMeetings() {
  const lastMon = mondayOf(TODAY);
  const meetings = [];

  meetings.push({
    id: "mt01", type: "manager", title: "マネージャー会議",
    date: addDays(lastMon, 1), start: "13:00", durationMin: 90,
    attendees: ["s01", "s05", "s07", "s12", "s09", "s10"],
    agenda: ["タスクチェック(前回アクション)", "各店売上・数値報告", "アクションプランのすり合わせ", "連絡・共有事項"],
    minutes: "・全店で前月比+4.2%。成増店は回数券成約が好調(契約率82%)。\n・川越店の夕方枠稼働が低下。LINEリマインド配信をマーケ委員会と連携して8月第1週に実施する。\n・打刻漏れが先月11件。新ポータルのGPS打刻移行で削減見込み。\n・次回までに各店「離反リスク患者リスト」への声かけ結果を報告。",
    aiSummary: null,
    decisions: ["川越店の夕方枠対策としてLINEリマインド配信を8月第1週に実施", "GPS打刻を成増店から先行導入"],
    actionItems: [
      { id: "ai01", title: "離反リスク患者リストへの声かけ結果を集計", ownerId: "s01", due: addDays(lastMon, 8), status: "doing" },
      { id: "ai02", title: "LINEリマインド配信文面のドラフト作成", ownerId: "s10", due: addDays(lastMon, 5), status: "done" },
      { id: "ai03", title: "夕方枠の空き状況を週次レポート化", ownerId: "s07", due: addDays(lastMon, 8), status: "todo" },
    ],
  });

  meetings.push({
    id: "mt02", type: "manager", title: "マネージャー会議",
    date: addDays(lastMon, 8), start: "13:00", durationMin: 90,
    attendees: ["s01", "s05", "s07", "s12", "s09", "s10"],
    agenda: ["タスクチェック(前回アクション)", "各店売上・数値報告", "アクションプランのすり合わせ", "連絡・共有事項"],
    minutes: "", aiSummary: null, decisions: [],
    actionItems: [],
  });

  meetings.push({
    id: "mt03", type: "executive", title: "幹部会議(8月度)",
    date: addDays(lastMon, 10), start: "10:00", durationMin: 120,
    attendees: ["s09", "s01", "s05", "s07", "s12", "s10"],
    agenda: ["社長講話(30分)", "統括連絡事項(90分)", "来月方針・ナレッジ共有", "委員会報告(採用/マーケ/理念浸透/環境/技術/交通事故)"],
    minutes: "", aiSummary: null, decisions: [],
    actionItems: [],
  });

  meetings.push({
    id: "mt04", type: "executive", title: "幹部会議(7月度)",
    date: addDays(lastMon, -18), start: "10:00", durationMin: 120,
    attendees: ["s09", "s01", "s05", "s07", "s12", "s10"],
    agenda: ["社長講話", "統括連絡事項", "来月方針", "委員会報告"],
    minutes: "・社長講話:下期は「デジタル移行と患者体験」を最重要テーマとする。\n・診察券/回数券の完全デジタル化を成増店で8月から検証。\n・採用委員会:新卒エントリー42名(前年比+10)。\n・技術委員会:技術研修の実技チェックをテスト機能で事前実施する運用に変更。\n・環境委員会:全店でペーパーシーツを新規格に統一。",
    aiSummary: "【要点】下期テーマは「デジタル移行と患者体験」。診察券・回数券のデジタル化を成増店で検証開始。採用は好調(エントリー前年比+10名)。研修は事前テスト運用に移行。\n【決定事項】8月から成増店で診察券レス運用/実技チェックのテスト事前実施\n【持ち越し】レジ(mPOP)連携の仕様確認",
    decisions: ["8月から成増店で診察券レス運用を検証", "実技チェックはテスト機能で事前実施"],
    actionItems: [
      { id: "ai04", title: "mPOPレジ連携の仕様を業者に確認", ownerId: "s09", due: addDays(TODAY, 4), status: "doing" },
      { id: "ai05", title: "ペーパーシーツ新規格の発注切替", ownerId: "s04", due: addDays(TODAY, -2), status: "done" },
    ],
  });

  meetings.push({
    id: "mt05", type: "adhoc", title: "成増店 導入キックオフ",
    date: addDays(TODAY, -7), start: "18:30", durationMin: 45,
    attendees: ["s01", "s02", "s03", "s04", "s09"],
    agenda: ["新ポータルの操作説明", "移行スケジュール確認", "質疑応答"],
    minutes: "・8月第1週:日報/勤怠をポータルへ完全移行。\n・8月第2週:カルテのボイス入力運用開始。\n・紙の来患ノートは8月末で廃止。\n・質問はAIアシスタントへ。回答できなかった質問は毎週FAQに追加する。",
    aiSummary: null,
    decisions: ["紙の来患ノートは8月末で廃止"],
    actionItems: [
      { id: "ai06", title: "受付メンバーへのボイス入力レクチャー", ownerId: "s01", due: addDays(TODAY, 3), status: "todo" },
    ],
  });

  return meetings;
}

// ============================================================
// 研修・テスト・評価・面談
// ============================================================

function makeTrainings() {
  const base = mondayOf(TODAY);
  return [
    { id: "tr01", title: "技術研修:胸椎モビライゼーション", type: "技術研修", date: addDays(base, 8), start: "10:00", durationMin: 180, required: true, place: "大宮店 研修室", attendees: practitioners.map((s) => ({ staffId: s.id, status: s.id === "s11" ? "未回答" : "参加" })) },
    { id: "tr02", title: "鍼研修:トリガーポイントへの刺鍼", type: "鍼研修", date: addDays(base, 22), start: "10:00", durationMin: 180, required: true, place: "成増店", attendees: staff.filter((s) => s.role === "鍼灸師").map((s) => ({ staffId: s.id, status: "参加" })) },
    { id: "tr03", title: "接遇座学:初診カウンセリングの型", type: "座学", date: addDays(base, 29), start: "14:00", durationMin: 120, required: false, place: "オンライン", attendees: staff.slice(0, 8).map((s) => ({ staffId: s.id, status: "未回答" })) },
    { id: "tr04", title: "技術研修:骨盤帯の評価と矯正", type: "技術研修", date: addDays(base, -13), start: "10:00", durationMin: 180, required: true, place: "大宮店 研修室", attendees: practitioners.map((s) => ({ staffId: s.id, status: rnd() > 0.15 ? "出席" : "欠席" })) },
    { id: "tr05", title: "鍼研修:自律神経系へのアプローチ", type: "鍼研修", date: addDays(base, -27), start: "10:00", durationMin: 180, required: true, place: "川越店", attendees: staff.filter((s) => s.role === "鍼灸師").map((s) => ({ staffId: s.id, status: "出席" })) },
  ];
}

function makeTests() {
  return [
    {
      id: "ts01", title: "解剖学基礎(脊柱・骨盤帯)", topic: "解剖学", createdBy: "AI", createdAt: addDays(TODAY, -12),
      assignedTo: practitioners.map((s) => s.id),
      questions: [
        { q: "腰椎は通常何個あるか?", choices: ["4個", "5個", "6個", "7個"], answer: 1, explanation: "腰椎はL1〜L5の5個。仙骨・尾骨と連結し骨盤帯を構成する。" },
        { q: "仙腸関節を構成する骨の組み合わせはどれか?", choices: ["仙骨と腸骨", "仙骨と坐骨", "腸骨と恥骨", "仙骨と大腿骨"], answer: 0, explanation: "仙腸関節は仙骨と腸骨の間の平面関節で、可動性はわずか。" },
        { q: "梨状筋の下を通過する神経はどれか?", choices: ["大腿神経", "閉鎖神経", "坐骨神経", "陰部神経"], answer: 2, explanation: "坐骨神経は梨状筋下孔を通る。梨状筋症候群の圧迫部位。" },
        { q: "頸椎の生理的弯曲はどれか?", choices: ["後弯", "前弯", "側弯", "直線"], answer: 1, explanation: "頸椎・腰椎は前弯、胸椎・仙椎は後弯を示す。" },
        { q: "腸腰筋を構成する筋はどれか?", choices: ["大腰筋と腸骨筋", "大腰筋と大殿筋", "腸骨筋と中殿筋", "大腰筋と梨状筋"], answer: 0, explanation: "腸腰筋=大腰筋(+小腰筋)と腸骨筋。股関節屈曲の主動作筋。" },
      ],
      results: [
        { staffId: "s02", score: 80, date: addDays(TODAY, -9) },
        { staffId: "s03", score: 100, date: addDays(TODAY, -8) },
        { staffId: "s06", score: 60, date: addDays(TODAY, -7) },
        { staffId: "s08", score: 100, date: addDays(TODAY, -6) },
        { staffId: "s11", score: 40, date: addDays(TODAY, -5) },
      ],
    },
    {
      id: "ts02", title: "接遇・初診対応マナー", topic: "接遇", createdBy: "AI", createdAt: addDays(TODAY, -20),
      assignedTo: staff.map((s) => s.id),
      questions: [
        { q: "初診の患者様をお迎えする際、最初にすべきことは?", choices: ["問診票の記入依頼", "目を見て挨拶し名前を確認", "保険証の確認", "施術室への案内"], answer: 1, explanation: "まず挨拶と名前の確認。事務手続きより先に安心感をつくる。" },
        { q: "施術中の会話で避けるべき話題はどれか?", choices: ["症状の経過", "セルフケア", "他院の批判", "生活習慣"], answer: 2, explanation: "他院批判は信頼を損なう。事実確認に留める。" },
        { q: "会計時に回数券を提案する適切なタイミングは?", choices: ["初回来院の会計時", "症状説明と施術計画に納得いただけた後", "痛みが完全に消えた後", "提案しない"], answer: 1, explanation: "計画への納得が先。金額の話はその後。" },
      ],
      results: [
        { staffId: "s02", score: 100, date: addDays(TODAY, -15) },
        { staffId: "s04", score: 100, date: addDays(TODAY, -14) },
        { staffId: "s06", score: 67, date: addDays(TODAY, -13) },
        { staffId: "s11", score: 67, date: addDays(TODAY, -11) },
      ],
    },
  ];
}

function makeEvaluations() {
  return practitioners.map((s, i) => ({
    id: `ev${String(i + 1).padStart(2, "0")}`,
    staffId: s.id,
    period: "2026-上期",
    scores: s.skills,
    grade: (s.skills.技術 + s.skills.数値) / 2 >= 4.3 ? "A" : (s.skills.技術 + s.skills.数値) / 2 >= 3.7 ? "B" : "C",
    comment: "",
    autoNote: "数値評価は日報・契約率・テスト結果から自動集計されています。",
  }));
}

function makeInterviews() {
  return [
    {
      id: "iv01", staffId: "s02", interviewerId: "s01", date: addDays(TODAY, -6),
      notes: "最近、新規の方への回数券提案がうまくいっている。一方で、施術が長引いて次の予約に食い込むことが週に2回ほどある。時間配分に課題意識。夜の勉強会には積極的に参加したいが、家庭の事情で20時以降は難しい。",
      aiSummary: {
        problems: ["施術の時間超過が週2回発生し、後続予約に影響", "20時以降の勉強会に参加できない"],
        causes: ["施術前の説明と施術を同時に行い時間が読めない", "勉強会が夜間固定で開催されている"],
        actions: ["説明は施術前の5分に分離するテンプレを次回面談まで試行", "技術委員会に昼開催枠の増設を提案"],
        mood: "前向き。提案スキルへの自信が付いてきている。",
      },
    },
    {
      id: "iv02", staffId: "s03", interviewerId: "s01", date: addDays(TODAY, -13),
      notes: "鍼の指名が増えて手応えを感じている。数値目標の立て方が分からず、日報のコメントに何を書くべきか迷うことがある。テスト作成機能で解剖学の復習ができるのは良い。",
      aiSummary: {
        problems: ["個人の数値目標が未設定で日報の振り返りが浅い"],
        causes: ["目標設定の面談が半期に1回しかない"],
        actions: ["月次で15分の目標確認をカレンダーに固定", "日報コメントのテンプレ(良かった点/課題/明日の一手)を導入"],
        mood: "安定。指名増が自信につながっている。",
      },
    },
    {
      id: "iv03", staffId: "s11", interviewerId: "s12", date: addDays(TODAY, -4),
      notes: "入社2年目。テストの点数が伸びず落ち込んでいる様子。患者様との会話は評判が良い。本人は「勉強の仕方が分からない」と話す。先輩の施術見学の時間を取りたいが、シフトが合わない。",
      aiSummary: {
        problems: ["解剖学テストの得点が伸び悩み(直近40点)", "先輩の施術見学の機会がない"],
        causes: ["体系的な学習習慣が未確立", "シフト作成時に見学枠が考慮されていない"],
        actions: ["AIテストの毎週5問モードで反復学習", "AIシフト作成の条件に「週1回の見学枠」を追加"],
        mood: "やや不安定。接客の強みを言語化して伝えるフォローが必要。",
      },
    },
  ];
}

// ============================================================
// 在庫・小口・経費・レジ
// ============================================================

function makeInventory() {
  return [
    { id: "in01", name: "フェイスタオル", category: "備品", stock: 18, unit: "枚", min: 30, price: 380, supplier: "白洋リネン", lastOrder: addDays(TODAY, -2) },
    { id: "in02", name: "ペーパーシーツ(新規格)", category: "消耗品", stock: 42, unit: "本", min: 20, price: 990, supplier: "メディカル商事", lastOrder: addDays(TODAY, -12) },
    { id: "in03", name: "鍼(セイリン J15 1寸)", category: "施術材料", stock: 8, unit: "箱", min: 10, price: 1870, supplier: "メディカル商事", lastOrder: addDays(TODAY, -20) },
    { id: "in04", name: "台座灸", category: "施術材料", stock: 24, unit: "箱", min: 8, price: 1540, supplier: "メディカル商事", lastOrder: addDays(TODAY, -30) },
    { id: "in05", name: "アルコール綿", category: "衛生", stock: 15, unit: "箱", min: 6, price: 660, supplier: "メディカル商事", lastOrder: addDays(TODAY, -18) },
    { id: "in06", name: "使い捨てフェイスカバー", category: "消耗品", stock: 6, unit: "袋", min: 10, price: 1210, supplier: "白洋リネン", lastOrder: addDays(TODAY, -25) },
    { id: "in07", name: "キネシオテープ 50mm", category: "施術材料", stock: 31, unit: "巻", min: 12, price: 480, supplier: "スポーツメディクス", lastOrder: addDays(TODAY, -9) },
    { id: "in08", name: "マッサージオイル", category: "施術材料", stock: 9, unit: "本", min: 4, price: 2680, supplier: "スポーツメディクス", lastOrder: addDays(TODAY, -40) },
    { id: "in09", name: "骨盤ベルト(物販)", category: "物販", stock: 12, unit: "個", min: 5, price: 4980, supplier: "スポーツメディクス", lastOrder: addDays(TODAY, -15) },
    { id: "in10", name: "プロテイン(物販)", category: "物販", stock: 3, unit: "袋", min: 6, price: 3980, supplier: "ヘルスサプライ", lastOrder: addDays(TODAY, -22) },
    { id: "in11", name: "洗濯洗剤", category: "衛生", stock: 5, unit: "本", min: 3, price: 520, supplier: "白洋リネン", lastOrder: addDays(TODAY, -35) },
    { id: "in12", name: "受付ロールペーパー", category: "事務", stock: 14, unit: "巻", min: 6, price: 180, supplier: "オフィスワン", lastOrder: addDays(TODAY, -11) },
  ];
}

function makeCashbook() {
  const cats = ["消耗品購入", "郵送費", "交通費", "清掃用品", "雑費", "飲料(来客用)"];
  const arr = [];
  let bal = 50000;
  for (let i = 20; i >= 1; i--) {
    const date = addDays(TODAY, -ri(0, 28));
    const isIn = rnd() < 0.15;
    const amount = isIn ? 30000 : ri(4, 48) * 100;
    arr.push({
      id: `cb${String(21 - i).padStart(2, "0")}`,
      date, storeId: "st-narimasu",
      type: isIn ? "in" : "out",
      amount,
      category: isIn ? "小口補充" : pick(cats),
      memo: isIn ? "本部より補充" : pick(["ドラッグストアで購入", "レシートあり", "", "急ぎ対応", ""]),
      by: pick(["s01", "s02", "s04"]),
    });
  }
  arr.sort((a, b) => a.date < b.date ? -1 : 1);
  for (const e of arr) { bal += e.type === "in" ? e.amount : -e.amount; e.balance = bal; }
  return arr;
}

function makeExpenses() {
  return [
    { id: "ex01", staffId: "s02", date: addDays(TODAY, -1), amount: 1280, category: "交通費", memo: "研修会場(大宮)までの往復", status: "pending" },
    { id: "ex02", staffId: "s03", date: addDays(TODAY, -2), amount: 5980, category: "書籍・学習", memo: "トリガーポイント解剖書", status: "pending" },
    { id: "ex03", staffId: "s07", date: addDays(TODAY, -4), amount: 3200, category: "会議費", memo: "委員会打合せ カフェ代(4名)", status: "approved", approvedBy: "s09" },
    { id: "ex04", staffId: "s04", date: addDays(TODAY, -6), amount: 2420, category: "消耗品", memo: "受付用文具一式", status: "approved", approvedBy: "s01" },
    { id: "ex05", staffId: "s06", date: addDays(TODAY, -8), amount: 12800, category: "備品", memo: "施術用スツール", status: "rejected", rejectReason: "本部一括購入の対象のため" },
    { id: "ex06", staffId: "s10", date: addDays(TODAY, -3), amount: 890, category: "郵送費", memo: "保険会社への書類送付", status: "approved", approvedBy: "s09" },
  ];
}

function makeRegisterSales() {
  const arr = [];
  let n = 1;
  for (let dOff = -14; dOff <= 0; dOff++) {
    const date = addDays(TODAY, dOff);
    if (dow(date) === 3) continue;
    for (const st of stores) {
      const base = st.id === "st-narimasu" ? 210000 : 165000;
      const total = Math.round(base * (0.75 + rnd() * 0.5));
      const card = Math.round(total * (0.35 + rnd() * 0.2));
      const qr = Math.round(total * (0.1 + rnd() * 0.12));
      arr.push({
        id: `rg${String(n++).padStart(3, "0")}`,
        storeId: st.id, date,
        cash: total - card - qr, card, qr, total,
        txCount: ri(14, 32),
        synced: true,
        syncedAt: iso(date, "21:05"),
        source: "mPOP",
      });
    }
  }
  return arr;
}

// ============================================================
// 通知・FAQ
// ============================================================

function makeNotifications() {
  return [
    { id: "nt01", type: "alert", title: "打刻漏れがあります", body: "昨日の退勤打刻が未入力のスタッフが1名います。勤怠管理から修正申請を承認してください。", date: iso(TODAY, "08:30"), read: false, link: "#/kintai" },
    { id: "nt02", type: "info", title: "本日のシフト", body: "成増店:早番3名・遅番2名。研修参加者はいません。", date: iso(TODAY, "07:00"), read: false, link: "#/shift" },
    { id: "nt03", type: "thanks", title: "サンクスカードが届きました", body: "鈴木 美咲さんから30ptのサンクスカードが届いています。", date: iso(addDays(TODAY, -1), "19:42"), read: false, link: "#/sns" },
    { id: "nt04", type: "alert", title: "在庫アラート", body: "フェイスタオルなど3品目が発注点を下回っています。", date: iso(addDays(TODAY, -1), "18:00"), read: true, link: "#/backoffice" },
    { id: "nt05", type: "info", title: "回数券の期限が近い患者様", body: "回数券の有効期限が30日以内の患者様が2名います。LINEでのご案内を検討してください。", date: iso(addDays(TODAY, -1), "10:00"), read: true, link: "#/patients" },
    { id: "nt06", type: "info", title: "明日のマネージャー会議", body: "アジェンダ:タスクチェック→数値報告→アクションプラン。資料はダッシュボードから自動生成されます。", date: iso(addDays(TODAY, -1), "09:00"), read: true, link: "#/meetings" },
    { id: "nt07", type: "test", title: "未受験のテストがあります", body: "「解剖学基礎(脊柱・骨盤帯)」の受験期限は今週金曜です。", date: iso(addDays(TODAY, -2), "12:00"), read: true, link: "#/staff" },
  ];
}

const faq = [
  { id: "f01", q: "シフト希望はどこから出せますか?", keywords: ["シフト", "希望", "提出"], a: "「シフト管理」ページの「希望を提出」ボタンから提出できます。締切は毎週金曜21時で、翌週分はAIが希望と必要人数をもとに自動作成し、院長承認後に確定します。" },
  { id: "f02", q: "GPS打刻ができません", keywords: ["GPS", "打刻", "出勤", "位置"], a: "出勤打刻は店舗から200m以内でのみ有効です。位置情報の許可がオフになっていないかブラウザ設定を確認してください。電波状況で取得できない場合は「位置が取得できない場合」から責任者承認付きの手動打刻を申請できます。" },
  { id: "f03", q: "回数券の残数はどこで確認できますか?", keywords: ["回数券", "残数", "消化"], a: "「顧客管理」で患者様を開くと回数券の残数と消化率が表示されます。残数は施術録の保存時に自動で消化され、患者様のLINEにも自動通知されます。" },
  { id: "f04", q: "カルテのボイス入力の使い方は?", keywords: ["ボイス", "音声", "カルテ", "入力"], a: "施術後、カルテ画面の「ボイス入力」を押して施術内容を話すと、AIがSOAP形式(主観・客観・評価・計画)に自動整理します。内容を確認して保存するだけです。" },
  { id: "f05", q: "サンクスカードの送り方は?", keywords: ["サンクス", "カード", "ポイント", "感謝"], a: "「社内SNS」の「サンクスを送る」から、相手とメッセージ、ポイント(10/20/30pt)を選んで送信します。月の持ちポイントは200ptです。" },
  { id: "f06", q: "日報はいつまでに提出しますか?", keywords: ["日報", "提出", "締切"], a: "退勤打刻の前に「日報」ページから提出してください。数字(売上・施術数・新規・成約)を入れると契約率は自動計算されます。ボイス入力からのAI下書きも使えます。" },
  { id: "f07", q: "経費の申請方法は?", keywords: ["経費", "申請", "精算"], a: "「在庫・経費」ページの「経費を申請」から金額・カテゴリ・メモを入力して提出します。承認状況は同じ画面で確認でき、承認されると給与と合わせて精算されます。" },
  { id: "f08", q: "在庫の発注はどうすればいいですか?", keywords: ["在庫", "発注", "備品"], a: "在庫が発注点を下回ると自動でアラートが出ます。「在庫・経費」ページの該当品目から「発注」を押すと発注記録が残り、入荷時に「入荷」で在庫数が更新されます。" },
  { id: "f09", q: "患者様へのLINE送信はどうやりますか?", keywords: ["LINE", "送信", "連携", "患者"], a: "カルテ保存後に「AIで患者様向けメッセージを作成」を押すと、施術内容と写真をまとめた文面が生成されます。内容を確認して「LINEで送信」を押すと、連携済みの患者様に送信されます(デモでは送信をシミュレートします)。" },
  { id: "f10", q: "予約の変更・キャンセルは?", keywords: ["予約", "変更", "キャンセル"], a: "「予約管理」でその予約をクリックし、時間・担当・ステータスを変更できます。キャンセル時は理由を残すと分析に反映されます。" },
  { id: "f11", q: "テストはどこから受けられますか?", keywords: ["テスト", "受験", "問題"], a: "「スタッフ管理」の「テスト」タブに自分に割り当てられたテストが表示されます。AIが研修テーマから自動作成した問題で、受験後すぐに採点と解説が表示されます。" },
  { id: "f12", q: "姿勢分析の使い方は?", keywords: ["姿勢", "分析", "写真", "ポイント"], a: "カルテで患者様の姿勢写真を登録すると、AIが33箇所のランドマーク(肩峰・耳孔・上前腸骨棘など)を自動検出し、肩の高さ差・骨盤の傾き・頭部前方偏位を数値化します。グリッド線合わせは不要です。" },
  { id: "f13", q: "会議の議事録はどう作りますか?", keywords: ["会議", "議事録", "アクション"], a: "「会議・議事録」で会議を開き、メモ欄に走り書きで記録して「AIで議事録に整形」を押すと、要点・決定事項・アクションアイテム(担当者・期限つき)に自動整理されます。" },
  { id: "f14", q: "デモデータを最初の状態に戻したい", keywords: ["リセット", "初期化", "デモ", "データ"], a: "トップバーの設定(歯車)から「デモデータをリセット」を選ぶと、初期状態に戻ります。" },
];

// ============================================================
// 必要人数(シフト自動作成の制約)
// ============================================================

const staffingRules = stores.map((st) => ({
  storeId: st.id,
  weekday: { early: 2, late: 2 },
  weekend: { early: 3, late: 2 },
  closedDow: 3, // 水曜定休
}));

// ============================================================
// チャット(グループ・DM・メンション)
// ============================================================

/** チャットルーム。kind: group(グループ) / dm(個別) / store(店舗) */
const chatRooms = [
  { id: "cr-all", kind: "group", name: "全社アナウンス", icon: "📢", desc: "全社員向けの連絡", memberIds: staff.map((s) => s.id), announceOnly: false, pinnedMessageId: null },
  { id: "cr-narimasu", kind: "store", name: "成増店", icon: "🏠", desc: "成増店のスタッフルーム", memberIds: staff.filter((s) => s.storeId === "st-narimasu").map((s) => s.id), pinnedMessageId: null },
  { id: "cr-omiya", kind: "store", name: "大宮店", icon: "🏠", desc: "大宮店のスタッフルーム", memberIds: staff.filter((s) => s.storeId === "st-omiya").map((s) => s.id), pinnedMessageId: null },
  { id: "cr-kawagoe", kind: "store", name: "川越店", icon: "🏠", desc: "川越店のスタッフルーム", memberIds: staff.filter((s) => s.storeId === "st-kawagoe").map((s) => s.id), pinnedMessageId: null },
  { id: "cr-urawa", kind: "store", name: "浦和店", icon: "🏠", desc: "浦和店のスタッフルーム", memberIds: staff.filter((s) => s.storeId === "st-urawa").map((s) => s.id), pinnedMessageId: null },
  { id: "cr-managers", kind: "group", name: "院長・マネージャー", icon: "🧭", desc: "責任者間の連携", memberIds: ["s01", "s05", "s07", "s12", "s09", "s10"], pinnedMessageId: null },
  { id: "cr-tech", kind: "group", name: "技術委員会", icon: "✋", desc: "手技・症例の相談", memberIds: ["s01", "s03", "s05", "s07", "s08", "s02"], pinnedMessageId: null },
  { id: "cr-mentor-s02", kind: "group", name: "メンター:鈴木班", icon: "🌱", desc: "鈴木メンターとメンティー", memberIds: ["s02", "s11", "s06"], pinnedMessageId: null },
  { id: "cr-dm-s01-s02", kind: "dm", name: null, memberIds: ["s01", "s02"], pinnedMessageId: null },
  { id: "cr-dm-s01-s09", kind: "dm", name: null, memberIds: ["s01", "s09"], pinnedMessageId: null },
  { id: "cr-dm-s01-s13", kind: "dm", name: null, memberIds: ["s01", "s13"], pinnedMessageId: null },
];

function makeChatMessages() {
  const msgs = [];
  let n = 1;
  const M = (roomId, authorId, dayOff, hm, text, opts = {}) => {
    msgs.push({
      id: `cm${String(n++).padStart(3, "0")}`,
      roomId, authorId,
      date: iso(addDays(TODAY, dayOff), hm),
      text,
      mentions: opts.mentions || [],
      reactions: opts.reactions || {},   // { "👍": ["s01","s02"] }
      readBy: opts.readBy || [],
      replyToId: opts.replyToId || null,
      attachment: opts.attachment || null, // { kind:"image"|"file", name }
      edited: false,
    });
    return msgs[msgs.length - 1].id;
  };

  // --- 全社アナウンス ---
  M("cr-all", "s09", -3, "09:00", "おはようございます。今月の全社目標を共有します。各店の院長は朝礼で必ず展開をお願いします。", { reactions: { "👍": ["s01", "s05", "s07", "s12"] }, readBy: ["s01", "s02", "s05", "s07"] });
  M("cr-all", "s13", -1, "10:30", "【人事より】8月分の勤怠締めは9/3(水)です。打刻漏れの修正申請は9/1までにお願いします。", { reactions: { "🙏": ["s01", "s05", "s07"] }, readBy: ["s01", "s05"] });
  M("cr-all", "s09", 0, "08:40", "本日より成増店で新ポータルのテスト運用を開始します。使い方で迷ったらAIアシスタントに聞いてください🐠", { reactions: { "🎉": ["s01", "s02", "s03", "s04"], "👍": ["s05"] }, readBy: ["s01", "s02"] });

  // --- 成増店 ---
  const nb1 = M("cr-narimasu", "s01", 0, "09:15", "おはようございます!本日の予約18件、14時に新規の方(紹介)がご来院予定です。", { reactions: { "👍": ["s02", "s03", "s04"] }, readBy: ["s02", "s03", "s04"] });
  M("cr-narimasu", "s04", 0, "09:22", "承知しました!問診票と初回セットを準備しておきます。", { replyToId: nb1, readBy: ["s01", "s02"] });
  M("cr-narimasu", "s02", 0, "09:28", "@佐藤 健太 14時の新規の方、姿勢分析もやっておきますか?", { mentions: ["s01"], readBy: ["s01"] });
  M("cr-narimasu", "s01", 0, "09:31", "@鈴木 美咲 お願いします!初回カウンセリングの流れでいきましょう。", { mentions: ["s02"], reactions: { "👍": ["s02"] }, readBy: ["s02", "s04"] });
  M("cr-narimasu", "s03", 0, "09:45", "鍼の在庫が残り8箱になりました。発注しておきます。", { attachment: { kind: "image", name: "在庫棚.jpg" }, readBy: ["s01"] });
  M("cr-narimasu", "s04", -1, "19:50", "本日もお疲れさまでした!明日は9時30分朝礼です🌅", { reactions: { "🙌": ["s01", "s02", "s03"] }, readBy: ["s01", "s02", "s03"] });

  // --- 院長・マネージャー ---
  M("cr-managers", "s09", -2, "13:05", "@全員 今週のマネージャー会議、アクションプランの進捗を各自まとめておいてください。", { mentions: ["s01", "s05", "s07", "s12", "s10"], reactions: { "👍": ["s01", "s05", "s07"] }, readBy: ["s01", "s05", "s10"] });
  M("cr-managers", "s07", -2, "18:20", "川越店、夕方枠の稼働が下がっています。LINE配信のタイミングを相談させてください。", { readBy: ["s09", "s10"] });
  M("cr-managers", "s10", -2, "18:35", "@山本 拓海 マーケ委員会で文面のドラフトを用意しました。明日共有しますね。", { mentions: ["s07"], reactions: { "🙏": ["s07"] }, readBy: ["s07", "s09"] });
  M("cr-managers", "s01", 0, "08:10", "成増店のポータル移行、初日は受付フローを重点的に見ます。気づきがあれば随時共有します。", { readBy: ["s09"] });

  // --- 技術委員会 ---
  M("cr-tech", "s07", -4, "21:10", "次回の技術研修は「胸椎モビライゼーション」で確定しました。事前に実技チェックを受けておいてください。", { reactions: { "👍": ["s01", "s03", "s08"] }, readBy: ["s01", "s03"] });
  M("cr-tech", "s03", -3, "12:40", "坐骨神経痛の症例で相談です。梨状筋のリリース後に一時的に症状が強くなるケース、みなさんどう対応されていますか?", { readBy: ["s07", "s08", "s01"] });
  M("cr-tech", "s08", -3, "13:15", "@田中 大輔 初回は刺激量を落として様子見が安全だと思います。翌日の反応を必ず確認するようにしています。", { mentions: ["s03"], reactions: { "👍": ["s03", "s07"], "💡": ["s01"] }, readBy: ["s03", "s07"] });

  // --- メンター班 ---
  M("cr-mentor-s02", "s02", -1, "20:10", "今週もお疲れさまでした!日報を読ませてもらいました。二人とも提案の型が定着してきていますね👏", { reactions: { "🙌": ["s11", "s06"] }, readBy: ["s11", "s06"] });
  M("cr-mentor-s02", "s11", -1, "20:32", "ありがとうございます!テストの点数がまだ伸びないので、来週は解剖学を重点的にやります。", { readBy: ["s02"] });
  M("cr-mentor-s02", "s02", -1, "20:40", "@吉田 陽菜 AIテストの週5問モードがおすすめです。分からなかった問題だけ一緒に見ましょう。", { mentions: ["s11"], reactions: { "🙏": ["s11"] }, readBy: ["s11"] });

  // --- DM ---
  M("cr-dm-s01-s02", "s02", 0, "07:55", "おはようございます。本日、家庭の事情で18時に上がらせていただきたいのですが大丈夫でしょうか?", { readBy: ["s01"] });
  M("cr-dm-s01-s02", "s01", 0, "08:02", "了解です!18時以降は私が引き継ぎます。無理せずどうぞ。", { reactions: { "🙏": ["s02"] }, readBy: ["s02"] });
  M("cr-dm-s01-s09", "s09", -1, "17:20", "成増店の移行、初週の所感を金曜までにもらえますか?幹部会議で共有したいです。", { readBy: ["s01"] });
  M("cr-dm-s01-s09", "s01", -1, "17:44", "承知しました。現場の声もまとめて出します。", { readBy: ["s09"] });
  M("cr-dm-s01-s13", "s13", 0, "11:05", "先月の残業時間が36時間を超えているスタッフが1名います。シフトの組み方をご相談させてください。", { readBy: [] });

  return msgs;
}

// ============================================================
// ロールプレイ(トークスクリプト練習)
// ============================================================

const talkScripts = [
  {
    id: "sc01", title: "初回カウンセリング(問診の導入)", category: "初回対応", level: "基礎",
    goal: "患者様の不安をほぐし、施術計画に納得いただく土台をつくる",
    durationSec: 90,
    lines: [
      { role: "スタッフ", text: "本日はご来院ありがとうございます。担当させていただく〇〇です。よろしくお願いいたします。", keywords: ["ありがとう", "担当", "よろしく"] },
      { role: "スタッフ", text: "まずはお身体の状態を詳しくお聞かせください。今、一番お困りの症状はどちらでしょうか。", keywords: ["お聞かせ", "お困り", "症状"] },
      { role: "スタッフ", text: "その痛みはいつ頃から出ていますか。きっかけになった出来事はありましたか。", keywords: ["いつ頃", "きっかけ"] },
      { role: "スタッフ", text: "日常生活で一番つらいのはどんな場面でしょうか。お仕事や睡眠には影響が出ていますか。", keywords: ["日常生活", "仕事", "睡眠"] },
      { role: "スタッフ", text: "ありがとうございます。ここまでのお話をもとに検査をさせていただき、原因と改善の道筋をご説明しますね。", keywords: ["検査", "原因", "ご説明"] },
    ],
  },
  {
    id: "sc02", title: "回数券のご提案", category: "提案", level: "実践",
    goal: "施術計画への納得を得たうえで、金額ではなく通院設計として提案する",
    durationSec: 120,
    lines: [
      { role: "スタッフ", text: "検査の結果、〇〇様の腰の痛みは骨盤まわりの筋力低下が主な原因と考えられます。", keywords: ["検査の結果", "原因"] },
      { role: "スタッフ", text: "改善までの目安として、まず週1回を4週間、その後は間隔を空けながら計8回ほどの施術をおすすめしています。", keywords: ["週1回", "目安", "8回"] },
      { role: "スタッフ", text: "というのも、筋肉の状態が定着するまでにはおよそ3ヶ月かかると言われているためです。", keywords: ["3ヶ月", "定着"] },
      { role: "スタッフ", text: "この通院計画に沿ってご来院いただける場合、8回分の回数券をご用意しています。1回あたり約800円おトクになります。", keywords: ["回数券", "おトク"] },
      { role: "スタッフ", text: "もちろん都度払いでも大丈夫です。まずは計画に納得いただけたかが一番大事なので、ご不明な点はありますか。", keywords: ["都度払い", "納得", "ご不明"] },
    ],
  },
  {
    id: "sc03", title: "電話でのご予約対応", category: "受付", level: "基礎",
    goal: "名乗り・症状確認・枠案内・持ち物案内を漏れなく行う",
    durationSec: 75,
    lines: [
      { role: "スタッフ", text: "お電話ありがとうございます。くまのみ整骨院 成増店、〇〇でございます。", keywords: ["ありがとうございます", "くまのみ"] },
      { role: "スタッフ", text: "ご予約ですね、ありがとうございます。差し支えなければ、今どのような症状でお困りかお聞かせいただけますか。", keywords: ["ご予約", "症状"] },
      { role: "スタッフ", text: "承知しました。直近ですと明日の14時、または明後日の10時にご案内できますが、いかがでしょうか。", keywords: ["ご案内", "いかが"] },
      { role: "スタッフ", text: "ありがとうございます。当日は保険証と、動きやすい服装でお越しください。初回は検査を含めて約75分いただきます。", keywords: ["保険証", "服装", "75分"] },
    ],
  },
  {
    id: "sc04", title: "離脱しそうな患者様へのフォロー", category: "リテンション", level: "応用",
    goal: "責めずに状況を聞き、通院を再開しやすい選択肢を示す",
    durationSec: 90,
    lines: [
      { role: "スタッフ", text: "〇〇様、その後お身体の調子はいかがでしょうか。前回のご来院から少し空きましたので、気になってご連絡しました。", keywords: ["いかが", "気になって"] },
      { role: "スタッフ", text: "お忙しい時期が続いていらっしゃるのですね。無理のない範囲で大丈夫ですよ。", keywords: ["お忙しい", "無理のない"] },
      { role: "スタッフ", text: "回数券の残りが3回分ございまして、有効期限が来月末までとなっています。", keywords: ["回数券", "有効期限"] },
      { role: "スタッフ", text: "土曜の朝や平日の夜の枠もございますので、ご都合のよいお時間があればお取りしておきます。", keywords: ["土曜", "夜", "ご都合"] },
    ],
  },
];

function makeRoleplaySessions() {
  return [
    {
      id: "rp01", staffId: "s11", scriptId: "sc02", date: addDays(TODAY, -5), durationSec: 108,
      transcript: "検査の結果、腰の痛みは骨盤まわりの筋力低下が原因と考えられます。えーっと、週1回を4週間くらい通っていただくのがおすすめです。回数券もありまして、8回分で1回あたり安くなります。どうされますか。",
      score: 62,
      metrics: { coverage: 58, pace: 72, filler: 4, empathy: 55 },
      feedback: {
        good: ["原因の説明を最初に持ってこられていて、順序は正しいです", "回数券の金額メリットに触れられています"],
        improve: ["「3ヶ月かかる」という根拠の説明が抜けています。ここがあると提案の納得感が大きく変わります", "「都度払いでも大丈夫」の一言がないため、選択を迫られている印象になります", "「えーっと」などのフィラーが4回。間を取る意識をしましょう"],
        nextAction: "根拠(3ヶ月)と選択肢(都度払い)の2点を足して、もう一度録音してみましょう。",
      },
      reviewedBy: "s02",
    },
    {
      id: "rp02", staffId: "s06", scriptId: "sc01", date: addDays(TODAY, -3), durationSec: 84,
      transcript: "本日はご来院ありがとうございます。担当させていただく渡辺です。よろしくお願いいたします。まずはお身体の状態を詳しくお聞かせください。今、一番お困りの症状はどちらでしょうか。その痛みはいつ頃から出ていますか。日常生活で一番つらいのはどんな場面でしょうか。ありがとうございます。検査をさせていただいて、原因をご説明しますね。",
      score: 88,
      metrics: { coverage: 92, pace: 86, filler: 0, empathy: 84 },
      feedback: {
        good: ["名乗りから症状確認までの流れが完璧です", "フィラーがゼロで、落ち着いた話し方ができています", "「ありがとうございます」で受け止めてから次に進めています"],
        improve: ["「きっかけになった出来事」の確認が抜けています。原因特定に効く質問なので加えましょう"],
        nextAction: "きっかけの確認を1問足すだけで満点レベルです。次回の初回対応で意識してみてください。",
      },
      reviewedBy: "s05",
    },
    {
      id: "rp03", staffId: "s03", scriptId: "sc04", date: addDays(TODAY, -1), durationSec: 71,
      transcript: "その後お身体の調子はいかがでしょうか。前回から空きましたので連絡しました。回数券の残りが3回ありまして、有効期限が来月末です。ご都合のよい時間があればお取りしておきます。",
      score: 74,
      metrics: { coverage: 76, pace: 80, filler: 1, empathy: 62 },
      feedback: {
        good: ["残数と期限を具体的に伝えられています", "枠のご提案まで踏み込めています"],
        improve: ["相手の状況を受け止める一言(「お忙しい時期が続いていらっしゃるのですね」)が抜けています", "「無理のない範囲で」の配慮表現があると、催促の印象が和らぎます"],
        nextAction: "共感フレーズを1つ入れてから本題に移る練習をしましょう。",
      },
      reviewedBy: null,
    },
  ];
}

// ============================================================
// エクスポート
// ============================================================

export const SCHEMA_VERSION = 4;

export function createSeed() {
  const patients = makePatients();
  const shifts = makeShifts();
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: TODAY,
    currentUserId: "s01",
    settings: { theme: "light", gpsSimulated: true, storeFilter: "all" },
    stores, staff, menus, philosophy, channels, staffingRules,
    patients,
    karte: makeKarte(patients),
    reservations: makeReservations(patients),
    shifts,
    attendance: makeAttendance(shifts),
    shiftRequests: makeShiftRequests(),
    dailyReports: makeDailyReports(),
    kpiMonthly: makeKpiMonthly(),
    posts: makePosts(),
    meetings: makeMeetings(),
    trainings: makeTrainings(),
    tests: makeTests(),
    evaluations: makeEvaluations(),
    interviews: makeInterviews(),
    inventory: makeInventory(),
    cashbook: makeCashbook(),
    expenses: makeExpenses(),
    registerSales: makeRegisterSales(),
    notifications: makeNotifications(),
    faq,
    chatRooms,
    chatMessages: makeChatMessages(),
    talkScripts,
    roleplaySessions: makeRoleplaySessions(),
  };
}

export { SHIFT_TYPES };
