/* ============================================================
   KUMANOMI Router — ハッシュベースの SPA ルーター
   ルート形式: #/pageId または #/pageId/param1/param2
   ============================================================ */

const pages = new Map();
let outlet = null;
let onNavigate = null;
let hashBound = false;
let guard = null;
let beforeRender = null;

export const router = {
  /** ページモジュール({id,title,icon,group,render})を登録 */
  register(page) { pages.set(page.id, page); },

  pages() { return [...pages.values()]; },
  get(id) { return pages.get(id); },

  /** アクセス可否のフック。(pageId) => boolean を設定する */
  setGuard(fn) { guard = fn; },

  /** 描画の直前に毎回走らせる処理(自動タスクの同期など) */
  setBeforeRender(fn) { beforeRender = fn; },

  init(outletEl, navigateHook) {
    outlet = outletEl;
    onNavigate = navigateHook;
    if (!hashBound) {
      window.addEventListener("hashchange", () => router.render());
      hashBound = true;
    }
    router.render();
  },

  /** 現在のルートを解析 → {id, params}(権限がなければダッシュボードへ) */
  current() {
    const hash = location.hash.replace(/^#\/?/, "");
    const parts = hash.split("/").filter(Boolean);
    let id = parts[0] || "dashboard";
    if (!pages.has(id)) id = "dashboard";
    if (guard && !guard(id)) return { id: "dashboard", params: [], denied: id };
    return { id, params: parts.slice(1).map(decodeURIComponent) };
  },

  navigate(path) {
    const target = `#/${path.replace(/^#?\/?/, "")}`;
    if (location.hash === target) router.render();
    else location.hash = target;
  },

  render() {
    if (!outlet) return;
    try {
      beforeRender?.();
    } catch (err) {
      console.warn("[router] 描画前フックでエラー:", err);
    }
    const { id, params } = router.current();
    const page = pages.get(id);
    if (!page) return;
    outlet.innerHTML = "";
    outlet.classList.remove("main");
    // reflow でページ遷移アニメーションを毎回発火させる
    void outlet.offsetWidth;
    outlet.classList.add("main");
    const root = document.createElement("div");
    root.className = `page page-${id}`;
    outlet.appendChild(root);
    try {
      page.render(root, params);
    } catch (err) {
      console.error(`[router] ${id} の描画でエラー:`, err);
      root.innerHTML = `<div class="card" style="border-color:var(--critical)">
        <div class="card-title">ページの表示中にエラーが発生しました</div>
        <p class="muted" style="font-size:var(--fs-sm)">${String(err?.message || err)}</p>
      </div>`;
    }
    onNavigate?.(page, params);
    outlet.scrollTop = 0;
    window.scrollTo({ top: 0 });
  },
};
