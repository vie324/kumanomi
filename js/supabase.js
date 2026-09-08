/* ============================================================
   Supabase 接続レイヤー(依存ゼロ)

   このアプリはビルドツールも CDN も使わない方針のため、
   supabase-js を読み込まず、PostgREST と GoTrue の REST API を
   fetch で直接叩く最小クライアントを持つ。

   設定の読み込み順:
     1. window.KUMANOMI_CONFIG        … config.js(Git管理外)で埋め込む
     2. localStorage "kumanomi.supabase" … 画面から設定した値
   どちらも無ければ「デモモード」で、これまで通り localStorage だけで動く。

   anon キーは公開前提のキーで、実際のアクセス制御は
   supabase/migrations/0004_rls.sql の RLS が行う。
   service_role キーはブラウザに置かないこと。
   ============================================================ */

const CONFIG_KEY = "kumanomi.supabase";
const SESSION_KEY = "kumanomi.supabase.session";

let config = null;
let session = null;
const listeners = new Set();

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function writeJSON(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* プライベートモード */ }
}

function loadConfig() {
  const injected = typeof window !== "undefined" ? window.KUMANOMI_CONFIG : null;
  const stored = readJSON(CONFIG_KEY);
  const merged = { ...(injected || {}), ...(stored || {}) };
  if (!merged.url || !merged.anonKey) return null;
  return { url: String(merged.url).replace(/\/+$/, ""), anonKey: String(merged.anonKey) };
}

config = loadConfig();
session = readJSON(SESSION_KEY);

function notify() { listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

/* ---------------- セッションの寿命 ---------------- */

const EXPIRY_MARGIN_S = 60; // これだけ手前で先に取り直す

function setSession(next) {
  if (next && next.expires_in && !next.expires_at) {
    next.expires_at = Math.floor(Date.now() / 1000) + Number(next.expires_in);
  }
  session = next;
  writeJSON(SESSION_KEY, session);
  notify();
  return session;
}

function isExpiring(s) {
  if (!s?.expires_at) return false;
  return Number(s.expires_at) - EXPIRY_MARGIN_S <= Math.floor(Date.now() / 1000);
}

let refreshing = null;

/** 同時に何本走っても、実際の更新は1回にまとめる */
function refreshSession() {
  if (!session?.refresh_token) return Promise.resolve(null);
  if (refreshing) return refreshing;
  refreshing = request("/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    body: JSON.stringify({ refresh_token: session.refresh_token }),
    auth: false,
  })
    .then((res) => setSession(res))
    .catch((err) => {
      // 更新できない = ログインし直してもらうしかない
      console.warn("[supabase] セッションを更新できませんでした:", err);
      setSession(null);
      return null;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

/* ---------------- 設定 ---------------- */

export const supabase = {
  /** 接続先が設定されているか(未設定ならデモモード) */
  isConfigured() { return !!config; },

  /** 現在の接続設定(anonKey は末尾のみ返す) */
  info() {
    if (!config) return null;
    const key = config.anonKey;
    return { url: config.url, keyHint: key.length > 12 ? `…${key.slice(-6)}` : "設定済み" };
  },

  /** 接続先を保存する。空にすると解除(デモモードへ戻る) */
  configure({ url, anonKey }) {
    if (!url || !anonKey) throw new Error("プロジェクトURLと anon キーの両方を入力してください。");
    if (!/^https?:\/\//.test(url)) throw new Error("プロジェクトURLは https:// から始まる形で入力してください。");
    if (/^ey[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(anonKey)) {
      // JWT の payload をのぞいて service_role キーの誤設定を防ぐ
      try {
        const payload = JSON.parse(atob(anonKey.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        if (payload.role === "service_role") {
          throw new Error("service_role キーはブラウザに保存できません。anon(public)キーを使ってください。");
        }
      } catch (e) { if (e instanceof Error && e.message.includes("service_role")) throw e; }
    }
    writeJSON(CONFIG_KEY, { url: url.replace(/\/+$/, ""), anonKey });
    config = loadConfig();
    notify();
    return config;
  },

  clearConfig() {
    writeJSON(CONFIG_KEY, null);
    writeJSON(SESSION_KEY, null);
    config = loadConfig();
    session = null;
    notify();
  },

  /** 設定・ログイン状態が変わったときに呼ばれる */
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  /* ---------------- 認証 ---------------- */

  session() { return session; },
  user() { return session?.user || null; },

  async signIn(email, password) {
    const res = await request("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email, password }),
      auth: false,
    });
    setSession(res);
    return session;
  },

  async signOut() {
    if (session?.access_token) {
      try { await request("/auth/v1/logout", { method: "POST" }); } catch { /* 期限切れは無視 */ }
    }
    setSession(null);
  },

  /**
   * アクセストークンを取り直す。
   * GoTrue のトークンは 1 時間ほどで切れるので、
   * 期限が近ければ自動で更新し、勝手にログアウトされないようにする。
   */
  async refreshSession() { return refreshSession(); },

  /** 期限切れが近ければ更新する。切れていて更新もできなければログアウト扱い */
  async ensureSession() {
    if (!session?.refresh_token) return session;
    if (!isExpiring(session)) return session;
    return refreshSession();
  },

  /* ---------------- データアクセス ---------------- */

  /**
   * テーブル/ビューを読む。
   *   select("v_member_directory", { eq: { store_id: id }, order: "full_name", limit: 50 })
   */
  async select(table, { columns = "*", eq = {}, order = null, limit = null } = {}) {
    const params = new URLSearchParams();
    params.set("select", columns);
    for (const [k, v] of Object.entries(eq)) params.set(k, `eq.${v}`);
    if (order) params.set("order", order);
    if (limit) params.set("limit", String(limit));
    return request(`/rest/v1/${table}?${params}`);
  },

  async insert(table, rows, { upsert = false, onConflict = null } = {}) {
    const params = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
    return request(`/rest/v1/${table}${params}`, {
      method: "POST",
      body: JSON.stringify(rows),
      headers: {
        Prefer: `return=representation${upsert ? ",resolution=merge-duplicates" : ""}`,
      },
    });
  },

  async update(table, patch, eq = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(eq)) params.set(k, `eq.${v}`);
    return request(`/rest/v1/${table}?${params}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
      headers: { Prefer: "return=representation" },
    });
  },

  async remove(table, eq = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(eq)) params.set(k, `eq.${v}`);
    return request(`/rest/v1/${table}?${params}`, { method: "DELETE" });
  },

  /** ストアド関数(RPC)を呼ぶ */
  async rpc(fn, args = {}) {
    return request(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  },

  /** 接続確認。成功すると店舗数とメンバー数を返す */
  async ping() {
    const stores = await request("/rest/v1/stores?select=id&limit=1", { head: true });
    const members = await request("/rest/v1/members?select=id&limit=1", { head: true });
    return { stores: stores.count, members: members.count };
  },
};

/* ---------------- 内部:fetch ラッパー ---------------- */

async function request(path, { method = "GET", body = null, headers = {}, auth = true, head = false, retried = false } = {}) {
  if (!config) throw new Error("Supabase の接続先が設定されていません。");
  // 期限が近いトークンで投げると 401 になるので、先に取り直しておく
  if (auth && session?.refresh_token && isExpiring(session)) await refreshSession();
  const h = {
    apikey: config.anonKey,
    "Content-Type": "application/json",
    ...headers,
  };
  if (auth) h.Authorization = `Bearer ${session?.access_token || config.anonKey}`;
  if (head) h.Prefer = "count=exact";

  let res;
  try {
    res = await fetch(`${config.url}${path}`, {
      method: head ? "HEAD" : method,
      headers: h,
      body: method === "GET" || head ? undefined : body,
    });
  } catch (e) {
    throw new Error(`Supabase に接続できませんでした(${config.url})。URL とネットワークを確認してください。`);
  }

  if (head) {
    const range = res.headers.get("content-range") || "";
    return { count: Number(range.split("/")[1]) || 0 };
  }

  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }

  if (!res.ok) {
    const msg = data?.message || data?.error_description || data?.error || data?.hint || res.statusText;
    // 期限切れの取りこぼしは1度だけ更新して投げ直す
    if (res.status === 401 && auth && !retried && session?.refresh_token) {
      const next = await refreshSession();
      if (next) return request(path, { method, body, headers, auth, head, retried: true });
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`権限がありません:${msg}(ログイン状態と RLS の設定を確認してください)`);
    }
    throw new Error(`Supabase エラー ${res.status}:${msg}`);
  }
  return data;
}
