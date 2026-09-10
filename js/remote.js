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

  /* ---------------- スタッフ(= members) ----------------
     読むのは名簿ビュー(RLS で「見てよい人」だけが返る)。
     書くのは v_app_members(0010)。社員番号・店舗コード・上司の社員番号のまま送ると、
     ビュー側のトリガが uuid に読み替える。異動・退職・委員会の任命もここを通る。 */
  staff: {
    table: "v_app_members",
    key: "employee_no", // ローカル id('s01')ではなく社員番号で突き合わせる
    order: "sort_order,full_name",
    view: "v_member_directory",
    upsert: false, // ビュー越し。同じ社員番号はトリガ側で上書きする
    toLocal: (row) => ({
      id: row.employee_no || row.id,
      empCode: row.employee_no || "",
      name: row.full_name,
      kana: row.kana || "",
      role: row.role_title || "スタッフ",
      rank: row.rank || "staff",
      storeId: row.store_code || row.store_id || null,
      storeIds: row.store_codes || [],          // 追加所属(兼務)
      committeeIds: row.committee_codes || [],  // 委員会
      reportsTo: row.manager_employee_no || row.manager_id || null,
      color: row.color || "#2a78d6",
      joined: row.joined_on || "",
      email: row.email || "",
      licenses: row.license_label && row.license_label !== "未確認" ? [row.license_label] : [],
      isActive: row.is_active !== false,
      photoUrl: row.photo_url || null,
      sortOrder: row.sort_order ?? 0,
    }),
    softDelete: "is_active", // 退職者は消さずに在籍フラグを落とす
    toRemote: writer({
      empCode: "employee_no", name: "full_name", kana: "kana",
      role: "role_title", rank: "rank",
      storeId: "primary_store_code", reportsTo: "manager_employee_no",
      storeIds: ["store_codes", (v) => v || []],
      committeeIds: ["committee_codes", (v) => v || []],
      color: "color", joined: "joined_on", email: "email",
      isActive: ["is_active", (v) => v !== false],
      photoUrl: "photo_url", sortOrder: "sort_order",
    }),
  },

  /* ---------------- 委員会マスタ ---------------- */
  committees: {
    table: "committees",
    key: "code",
    order: "sort_order,name",
    toLocal: (row) => ({
      id: row.code,
      name: row.name,
      icon: row.icon || "🗂",
      desc: row.description || "",
      isActive: row.is_active !== false,
    }),
    softDelete: "is_active",
    toRemote: writer({
      id: "code", name: "name", icon: "icon", desc: "description",
      isActive: ["is_active", (v) => v !== false],
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

  /* ============================================================
     ここから下は 0009(みんなで使う部分)。
     投稿・タスク・チャットは「他の人の操作が自分の画面に届く」
     コレクションなので、サーバーに置いて初めて連動する。
     ============================================================ */

  /* ---------------- 投稿(連絡事項 / タイムライン / サンクスギフト / 売上報告) ---------------- */
  posts: {
    table: "v_app_posts",
    key: "id",
    order: "date.desc",
    limit: 600, // 画像を含むので取りすぎない(新しい順)。過去分はあとから別途
    upsert: false,
    toLocal: (row) => ({
      id: row.id,
      type: row.type,
      channelId: row.channel_id || null,
      authorId: row.author_id,
      storeId: row.store_id || null,
      toId: row.to_id || null,
      title: row.title || "",
      body: row.body || "",
      points: row.points ?? 0,
      pinned: !!row.pinned,
      likes: row.likes || [],
      comments: row.comments || [],
      uriage: row.uriage || null,
      images: row.images || [],
      date: localIso(row.date),
    }),
    toRemote: writer({
      id: "id", type: "type", channelId: "channel_id", authorId: "author_id",
      storeId: "store_id", toId: "to_id", title: "title",
      body: ["body", (v) => v ?? ""],
      points: ["points", (v) => v ?? 0],
      pinned: ["pinned", (v) => !!v],
      likes: ["likes", (v) => v || []],
      comments: ["comments", (v) => v || []],
      uriage: "uriage",
      images: ["images", (v) => v || []],
      date: ["date", utcIso],
    }),
  },

  /* ---------------- タスク ---------------- */
  tasks: {
    table: "v_app_tasks",
    key: "id",
    order: "due.asc.nullslast,created_at.desc",
    upsert: false,
    toLocal: (row) => ({
      id: row.id,
      title: row.title,
      note: row.note || "",
      ownerId: row.owner_id,
      createdBy: row.created_by || null,
      due: row.due || null,
      status: row.status || "todo",
      progress: row.progress ?? 0,
      source: row.source || {},
      auto: !!row.auto,
      autoKey: row.auto_key || null,
      autoResolve: row.auto_resolve || null,
      reassigned: !!row.reassigned,
      assignLog: row.assign_log || [],
      alertedAt: row.alerted_at || null,
      completedAt: row.completed_at || null,
      createdAt: row.created_at,
    }),
    toRemote: writer({
      id: "id", title: "title", note: ["note", (v) => v ?? ""],
      ownerId: "owner_id", createdBy: "created_by", due: "due",
      status: "status", progress: ["progress", (v) => v ?? 0],
      source: ["source", (v) => v || {}],
      auto: ["auto", (v) => !!v], autoKey: "auto_key", autoResolve: "auto_resolve",
      reassigned: ["reassigned", (v) => !!v],
      assignLog: ["assign_log", (v) => v || []],
      alertedAt: "alerted_at",
      createdAt: "created_at",
    }),
  },

  /* ---------------- チャット ---------------- */
  chatRooms: {
    table: "v_app_chat_rooms",
    key: "id",
    order: "name",
    upsert: false,
    toLocal: (row) => ({
      id: row.id,
      kind: row.kind || "group",
      name: row.name,
      icon: row.icon || "💬",
      desc: row.desc || "",
      storeId: row.store_id || null,
      memberIds: row.member_ids || [],
      announceOnly: !!row.announce_only,
      pinnedMessageId: row.pinned_message_id || null,
      createdBy: row.created_by || null,
      autoKey: row.auto_key || null, // 所属から自動で作られるルーム(参加者は手で変えない)
    }),
    toRemote: writer({
      id: "id", kind: "kind", name: "name", icon: "icon", desc: "desc",
      storeId: "store_id", memberIds: ["member_ids", (v) => v || []],
      announceOnly: ["announce_only", (v) => !!v],
      pinnedMessageId: "pinned_message_id", createdBy: "created_by",
    }),
  },

  chatMessages: {
    table: "v_app_chat_messages",
    key: "id",
    order: "date.desc",
    limit: 1500, // 新しい順に上限まで。画面側で古い順に並べ直す
    upsert: false,
    toLocal: (row) => ({
      id: row.id,
      roomId: row.room_id,
      authorId: row.author_id,
      date: localIso(row.date),
      text: row.text || "",
      mentions: row.mentions || [],
      reactions: row.reactions || {},
      readBy: row.read_by || [],
      replyToId: row.reply_to_id || null,
      attachment: row.attachment || null,
      taskId: row.task_id || null,
      edited: !!row.edited,
      deleted: !!row.deleted,
    }),
    toRemote: writer({
      id: "id", roomId: "room_id", authorId: "author_id",
      date: ["date", utcIso],
      text: ["text", (v) => v ?? ""],
      mentions: ["mentions", (v) => v || []],
      reactions: ["reactions", (v) => v || {}],
      readBy: ["read_by", (v) => v || []],
      replyToId: "reply_to_id", attachment: "attachment", taskId: "task_id",
      edited: ["edited", (v) => !!v], deleted: ["deleted", (v) => !!v],
    }),
  },

  /* ---------------- 研修とレポート ---------------- */
  trainings: {
    table: "v_app_trainings",
    key: "id",
    order: "date.desc",
    upsert: false,
    toLocal: (row) => ({
      id: row.id,
      title: row.title,
      type: row.type || "技術研修",
      date: row.date,
      start: hm(row.start) || "10:00",
      durationMin: row.duration_min ?? 120,
      required: !!row.required,
      place: row.place || "",
      attendees: row.attendees || [],
    }),
    toRemote: writer({
      id: "id", title: "title", type: "type", date: "date", start: "start",
      durationMin: "duration_min", required: ["required", (v) => !!v],
      place: "place", attendees: ["attendees", (v) => v || []],
    }),
  },

  trainingReports: {
    table: "v_app_training_reports",
    key: "id",
    order: "submitted_at.desc.nullslast",
    upsert: false,
    toLocal: (row) => ({
      id: row.id,
      trainingId: row.training_id,
      authorId: row.author_id,
      body: row.body || "",
      learned: row.learned || "",
      applyPlan: row.apply_plan || "",
      status: row.status || "draft",
      submittedAt: row.submitted_at ? localIso(row.submitted_at) : null,
    }),
    toRemote: writer({
      id: "id", trainingId: "training_id", authorId: "author_id",
      body: ["body", (v) => v ?? ""], learned: "learned", applyPlan: "apply_plan",
      status: "status", submittedAt: ["submitted_at", (v) => (v ? utcIso(v) : null)],
    }),
  },

  /* ---------------- 始末書・業務改善書 ---------------- */
  incidentReports: {
    table: "v_app_incident_reports",
    key: "id",
    order: "occurred_on.desc",
    upsert: false,
    toLocal: (row) => ({
      id: row.id,
      authorId: row.author_id,
      kind: row.kind || "kaizen",
      occurredOn: row.occurred_on,
      conclusion: row.conclusion || "",
      cause: row.cause || "",
      processDetail: row.process_detail || "",
      worstCase: row.worst_case || "",
      prevention: row.prevention || "",
      status: row.status || "draft",
      submittedAt: row.submitted_at ? localIso(row.submitted_at) : null,
      acknowledgedBy: row.acknowledged_by || null,
      acknowledgedAt: row.acknowledged_at ? localIso(row.acknowledged_at) : null,
      ackComment: row.ack_comment || "",
    }),
    toRemote: writer({
      id: "id", authorId: "author_id", kind: "kind", occurredOn: "occurred_on",
      conclusion: ["conclusion", (v) => v ?? ""], cause: ["cause", (v) => v ?? ""],
      processDetail: ["process_detail", (v) => v ?? ""], worstCase: ["worst_case", (v) => v ?? ""],
      prevention: ["prevention", (v) => v ?? ""], status: "status",
      ackComment: "ack_comment",
    }),
  },

  /* ---------------- 予算(店舗 × 月) ---------------- */
  budgets: {
    table: "v_app_budgets",
    key: "id",
    order: "month.desc",
    upsert: false,
    toLocal: (row) => ({
      id: row.id,
      storeId: row.store_id,
      month: row.month,
      amount: row.amount ?? 0,
      note: row.note || "",
    }),
    toRemote: writer({
      id: "id", storeId: "store_id", month: "month",
      amount: ["amount", (v) => v ?? 0], note: "note",
    }),
  },
};

/* ------------------------------------------------------------
   日時の受け渡し。
   アプリは "2026-09-09T08:45:00" のような端末ローカルの素の文字列で持ち、
   サーバーは timestamptz(UTC)で持つ。ここで往復させる。
   ------------------------------------------------------------ */
const two = (n) => String(n).padStart(2, "0");

/** サーバーの timestamptz → 端末ローカルの "YYYY-MM-DDTHH:mm:ss" */
function localIso(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** 端末ローカルの素の文字列 → UTC の ISO(サーバーへ送る形) */
function utcIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* ------------------------------------------------------------
   PHASE 2 で Supabase へ移すコレクション。
   ここは「残りの宿題」を明示するための一覧で、
   テーブルを作ったら上の REMOTE へ移動させる。
   ------------------------------------------------------------ */
export const PENDING_TABLES = [
  "patients", "karte", "reservations", "waitlist", "menus",
  "staffingRules", "channels", "meetings", "notifications",
  "inventory", "orders", "expenses", "cashbook", "registerSales",
  "tests", "evaluations", "interviews",
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
