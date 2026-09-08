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

/** 何もしない素通しマッパー(テーブルの列名がローカルと同じ場合用) */
const passthrough = {
  toLocal: (row) => ({ ...row }),
  toRemote: (obj) => ({ ...obj }),
};

export const REMOTE = {
  /* ---------------- 店舗 ---------------- */
  stores: {
    table: "stores",
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
      openHour: (row.open_at || "10:00").slice(0, 5),
      closeHour: (row.close_at || "20:00").slice(0, 5),
      color: row.color || "#2a78d6",
      beds: row.beds ?? 3,
      deptCode: row.dept_code || "",
      isPilot: !!row.is_pilot,
    }),
    toRemote: (obj) => ({
      code: obj.id,
      name: obj.name,
      short_name: nn(obj.short),
      category: obj.category,
      phone: nn(obj.phone),
      address: nn(obj.address),
      lat: obj.lat ?? null,
      lng: obj.lng ?? null,
      color: nn(obj.color),
      dept_code: nn(obj.deptCode),
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
    toRemote: (obj) => ({
      employee_no: obj.empCode || obj.id,
      full_name: obj.name,
      kana: nn(obj.kana),
      role_title: nn(obj.role),
      rank: obj.rank || "staff",
      color: nn(obj.color),
      joined_on: nn(obj.joined),
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
  "shifts", "shiftRequests", "staffingRules", "attendance",
  "dailyReports", "posts", "channels", "chatRooms", "chatMessages",
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
