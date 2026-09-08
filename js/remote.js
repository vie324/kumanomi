/* ============================================================
   コレクション ⇄ Supabase テーブルの対応表

   アプリ側は「stores」「staff」のようなコレクション名でデータを扱い、
   Supabase 側は「stores」「members」という別の形を持っている。
   その差をここ 1 か所に閉じ込める。

   ・ローカルの id は 'st-narimasu' / 's01' のような安定コード
   ・Supabase の id は uuid
   → key 列(stores.code / members.employee_no)で突き合わせる。

   ここに載っていないコレクションは「まだサーバーに無い」という意味で、
   これまで通り端末内(localStorage)だけで動く。
   PHASE 2 でテーブルを足すたびに、この表へ 1 行足していく。
   ============================================================ */

const nn = (v) => (v == null || v === "" ? null : v);
/** Postgres の time("09:55:00")をアプリの "09:55" に落とす */
const hm = (v) => (v ? String(v).slice(0, 5) : null);

/**
 * 「ローカルの項目名 → サーバーの列名」の対応から書き出し関数を作る。
 *
 * 大事なのは **渡されなかった項目は出さない** こと。
 * 更新は「変えた項目だけ」を送りたいので、
 *   toRemote({ clockOut: "20:10" })  →  { clock_out: "20:10" }
 * のように、部分的なオブジェクトをそのまま部分的な列に写す。
 * (項目名が変わる列を落としてしまうと、変更が送られない)
 *
 * spec の値は "列名" か ["列名", 変換関数]。
 */
function writer(spec) {
  return (obj) => {
    const out = {};
    for (const [local, def] of Object.entries(spec)) {
      if (!(local in obj)) continue;
      const [column, fn] = Array.isArray(def) ? def : [def, null];
      out[column] = fn ? fn(obj[local]) : nn(obj[local]);
    }
    return out;
  };
}

/** 何もしない素通しマッパー(テーブルの列名がローカルと同じ場合用) */
const passthrough = {
  toLocal: (row) => ({ ...row }),
  toRemote: (obj) => ({ ...obj }),
};

export const REMOTE = {
  /* ---------------- 店舗 ---------------- */
  stores: {
    table: "stores",
    view: "v_app_stores", // uuid を出さない参照用ビュー(0006)
    key: "code", // ローカル id が入る列
    order: "sort_order,name",
    toLocal: (row) => ({
      id: row.code,
      name: row.name,
      short: row.short_name || row.name,
      category: row.category,
      phone: row.phone || "",
      address: row.address || "",
      lat: row.lat,
      lng: row.lng,
      openHour: (row.open_hour || "10:00").slice(0, 5),
      closeHour: (row.close_hour || "20:00").slice(0, 5),
      color: row.color || "#2a78d6",
      beds: row.beds ?? 3,
      deptCode: row.dept_code || "",
      isPilot: !!row.is_pilot,
    }),
    softDelete: "is_active", // 店舗は消さずに閉店扱いにする
    toRemote: writer({
      id: "code", name: "name", short: "short_name", category: "category",
      phone: "phone", address: "address", lat: "lat", lng: "lng",
      openHour: "open_hour", closeHour: "close_hour", beds: "beds",
      color: "color", deptCode: "dept_code",
    }),
  },

  /* ---------------- スタッフ(= members) ---------------- */
  staff: {
    table: "members",
    key: "employee_no", // ローカル id('s01')ではなく社員番号で突き合わせる
    order: "sort_order,full_name",
    /* 参照は名簿ビュー経由。RLS で「見てよい人」だけが返る */
    view: "v_member_directory",
    toLocal: (row) => ({
      id: row.employee_no || row.id,
      empCode: row.employee_no || "",
      name: row.full_name,
      kana: row.kana || "",
      role: row.role_title || "スタッフ",
      rank: row.rank || "staff",
      storeId: row.store_code || row.store_id || null,
      reportsTo: row.manager_employee_no || row.manager_id || null,
      color: row.color || "#2a78d6",
      joined: row.joined_on || "",
      licenses: row.license_label && row.license_label !== "未確認" ? [row.license_label] : [],
      isActive: row.is_active !== false,
    }),
    softDelete: "is_active", // 退職者は消さずに在籍フラグを落とす
    toRemote: writer({
      empCode: "employee_no", name: "full_name", kana: "kana",
      role: "role_title", rank: "rank", color: "color", joined: "joined_on",
    }),
  },

  /* ---------------- 勤怠 ----------------
     読み書きとも v_app_attendance(0007)を通す。
     ビュー側の INSTEAD OF トリガが 社員番号 → uuid を解決するので、
     アプリは uuid を一切知らなくてよい。 */
  attendance: {
    table: "v_app_attendance",
    key: "id",
    order: "date.desc",
    upsert: false, // ビューの ON CONFLICT は使えない。トリガ側で上書きする
    toLocal: (row) => ({
      id: row.id,
      staffId: row.staff_id,
      storeId: row.store_id,
      date: row.date,
      shiftType: row.shift_type,
      clockIn: hm(row.clock_in),
      clockOut: hm(row.clock_out),
      breakMin: row.break_min ?? 0,
      status: row.status || "normal",
      gpsOk: row.gps_ok !== false,
      approved: !!row.approved,
      approvedBy: row.approved_by || null,
      note: row.note || "",
    }),
    toRemote: writer({
      id: "id", staffId: "staff_id", storeId: "store_id", date: "date",
      shiftType: "shift_type", clockIn: "clock_in", clockOut: "clock_out",
      breakMin: ["break_min", (v) => v ?? 0],
      status: "status",
      gpsOk: ["gps_ok", (v) => v !== false],
      approved: ["approved", (v) => !!v],
      note: ["note", (v) => v ?? ""],
    }),
  },

  /* ---------------- シフト ---------------- */
  shifts: {
    table: "v_app_shifts",
    key: "id",
    order: "date",
    upsert: false,
    toLocal: (row) => ({
      id: row.id,
      staffId: row.staff_id,
      storeId: row.store_id,
      date: row.date,
      type: row.type || "full",
      note: row.note || "",
    }),
    toRemote: writer({
      id: "id", staffId: "staff_id", storeId: "store_id",
      date: "date", type: "type", note: ["note", (v) => v ?? ""],
    }),
  },

  /* ---------------- 希望休(理由は任意) ---------------- */
  shiftRequests: {
    table: "v_app_shift_requests",
    key: "id",
    order: "month.desc",
    upsert: false,
    toLocal: (row) => ({
      id: row.id,
      staffId: row.staff_id,
      month: row.month,
      wishes: row.wishes || {},
      reasons: row.reasons || {},
      note: row.note || "",
      submittedAt: (row.submitted_at || "").slice(0, 10),
    }),
    toRemote: writer({
      id: "id", staffId: "staff_id", month: "month",
      wishes: ["wishes", (v) => v || {}],
      reasons: ["reasons", (v) => v || {}],
      note: ["note", (v) => v ?? ""],
      submittedAt: "submitted_at",
    }),
  },

  /* ---------------- 日報 ---------------- */
  dailyReports: {
    table: "v_app_daily_reports",
    key: "id",
    order: "date.desc",
    upsert: false,
    toLocal: (row) => ({
      id: row.id,
      staffId: row.staff_id,
      storeId: row.store_id,
      date: row.date,
      revenue: row.revenue ?? 0,
      treatments: row.treatments ?? 0,
      newPatients: row.new_patients ?? 0,
      proposals: row.proposals ?? 0,
      contracts: row.contracts ?? 0,
      goods: row.goods ?? 0,
      comment: row.comment || "",
      aiSummary: row.ai_summary || null,
      status: row.status || "draft",
    }),
    toRemote: writer({
      id: "id", staffId: "staff_id", storeId: "store_id", date: "date",
      revenue: ["revenue", (v) => v ?? 0],
      treatments: ["treatments", (v) => v ?? 0],
      newPatients: ["new_patients", (v) => v ?? 0],
      proposals: ["proposals", (v) => v ?? 0],
      contracts: ["contracts", (v) => v ?? 0],
      goods: ["goods", (v) => v ?? 0],
      comment: ["comment", (v) => v ?? ""],
      aiSummary: "ai_summary",
      status: "status",
    }),
  },
};

/* ------------------------------------------------------------
   PHASE 2 で Supabase へ移すコレクション。
   ここは「残りの宿題」を明示するための一覧で、
   テーブルを作ったら上の REMOTE へ移動させる。
   ------------------------------------------------------------ */
export const PENDING_TABLES = [
  "patients", "karte", "reservations", "waitlist", "menus",
  "staffingRules", "posts", "channels", "chatRooms", "chatMessages",
  "tasks", "meetings", "notifications",
  "inventory", "orders", "expenses", "cashbook", "registerSales",
  "trainings", "tests", "evaluations", "interviews",
  "talkScripts", "roleplaySessions",
  "kpiMonthly", "sharoushiSubmissions", "payrollAdjustments",
  "orgChangeLog", "faq",
];

/** そのコレクションがサーバーにあるか */
export function isRemote(coll) {
  return Object.prototype.hasOwnProperty.call(REMOTE, coll);
}

/** マッピング定義を取り出す(無ければ null) */
export function remoteOf(coll) {
  return REMOTE[coll] || null;
}

/** サーバー化済みのコレクション一覧 */
export function remoteCollections() {
  return Object.keys(REMOTE);
}

/** 進捗(何コレクションがサーバー化できたか) */
export function migrationProgress() {
  const done = remoteCollections().length;
  return { done, total: done + PENDING_TABLES.length };
}

export { passthrough };
