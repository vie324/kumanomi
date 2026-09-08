/* ============================================================
   KUMANOMI Router — ハッシュベースの SPA ルーター
   ルート形式: #/pageId または #/pageId/param1/param2

   描画は非同期。各ページは自分に必要なコレクションを
   needs: ["attendance", "staff"] のように宣言でき、
   ルーターがそれをそろえてから render() を呼ぶ。

   案B(ローカルキャッシュ)では待ち時間が実質ゼロなので
   一瞬で描画されるが、案A(全面非同期)へ移しても
   ページ側は 1 行も変えずに済むよう、入口だけ先に非同期にしてある。
   ============================================================ */

const pages = new Map();
let outlet = null;
let onNavigate = null;
let hashBound = false;
let guard = null;
let beforeRender = null;
let loader = null;
let renderSeq = 0;

/* ---------------- スクロール位置の記憶 ----------------
   一覧から1件開いて戻ったとき、また先頭から探し直すのは面倒なので、
   ルートごとに位置を覚えておいて戻ったら復元する。
   別のページへ「進む」ときは先頭から見せる。 */
const scrollMemory = new Map();
let currentKey = null;
let scrollTicking = false;

if (typeof window !== "undefined") {
  window.addEventListener("scroll", () => {
    if (!currentKey || scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      scrollMemory.set(currentKey, window.scrollY);
      scrollTicking = false;
    });
  }, { passive: true });
}

/** 描画が終わってから位置を戻す(内容が入る前に動かしても意味がないため) */
function restoreScroll(key) {
  const saved = scrollMemory.get(key) || 0;
  const go = () => window.scrollTo({ top: saved, behavior: "auto" });
  go();
  // 画像やチャートで高さが伸びたあとにもう一度合わせる
  if (saved > 0) requestAnimationFrame(go);
}

/** 読み込みが長引いたときだけ出す骨組み表示 */
function loadingCard() {
  const wrap = document.createElement("div");
  wrap.className = "page-loading";
  wrap.setAttribute("aria-live", "polite");
  wrap.innerHTML = `
    <div class="skel skel-title"></div>
    <div class="skel skel-line"></div>
    <div class="skel skel-line short"></div>
    <span class="sr-only">読み込んでいます</span>`;
  return wrap;
}

function errorCard(message) {
  const wrap = document.createElement("div");
  wrap.className = "card";
  wrap.style.borderColor = "var(--critical)";
  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = "ページの表示中にエラーが発生しました";
  const p = document.createElement("p");
  p.className = "muted";
  p.style.fontSize = "var(--fs-sm)";
  p.textContent = message;
  wrap.append(title, p);
  return wrap;
}

export const router = {
  /** ページモジュール({id,title,icon,group,needs?,render})を登録 */
  register(page) { pages.set(page.id, page); },

  pages() { return [...pages.values()]; },
  get(id) { return pages.get(id); },

  /** アクセス可否のフック。(pageId) => boolean を設定する */
  setGuard(fn) { guard = fn; },

  /** 描画の直前に毎回走らせる処理(自動タスクの同期など) */
  setBeforeRender(fn) { beforeRender = fn; },

  /** needs をそろえる関数。(collections) => Promise を設定する */
  setLoader(fn) { loader = fn; },

  init(outletEl, navigateHook) {
    outlet = outletEl;
    onNavigate = navigateHook;
    if (!hashBound) {
      window.addEventListener("hashchange", () => router.render());
      hashBound = true;
    }
    return router.render();
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

  async render() {
    if (!outlet) return;
    const token = ++renderSeq;

    const { id, params } = router.current();
    const page = pages.get(id);
    if (!page) return;

    // 必要なデータをそろえる(案Bではキャッシュ済みなので即座に解決する)
    let pending = null;
    if (loader && page.needs?.length) {
      try { pending = loader(page.needs); } catch (err) { console.warn("[router] データ取得でエラー:", err); }
    }

    outlet.innerHTML = "";
    outlet.classList.remove("main");
    // reflow でページ遷移アニメーションを毎回発火させる
    void outlet.offsetWidth;
    outlet.classList.add("main");
    const root = document.createElement("div");
    root.className = `page page-${id}`;
    outlet.appendChild(root);

    // タイトル・ナビの選択状態は待たずに更新する
    onNavigate?.(page, params);
    outlet.scrollTop = 0;
    // 位置の復元は描画が終わってから。ここでは先頭に置いておく
    currentKey = location.hash || "#/";
    window.scrollTo({ top: 0 });

    if (pending?.then) {
      // 待ちが一瞬で終わるときにちらつかせない
      const skeletonTimer = setTimeout(() => { if (token === renderSeq) root.appendChild(loadingCard()); }, 160);
      try {
        await pending;
      } catch (err) {
        console.warn(`[router] ${id} のデータ取得に失敗しました(端末内のデータで表示します):`, err);
      } finally {
        clearTimeout(skeletonTimer);
      }
      if (token !== renderSeq) return; // 待っている間に別ページへ移った
      root.innerHTML = "";
    }

    // 自動タスクの積み直しなどはデータがそろってから
    try { beforeRender?.(); } catch (err) { console.warn("[router] 描画前フックでエラー:", err); }

    try {
      const out = page.render(root, params);
      if (out?.then) {
        await out;
        if (token !== renderSeq) return;
      }
    } catch (err) {
      console.error(`[router] ${id} の描画でエラー:`, err);
      root.innerHTML = "";
      root.appendChild(errorCard(String(err?.message || err)));
    }

    restoreScroll(currentKey);
  },

  /** そのルートの記憶している位置を捨てる(一覧を作り直したときなど) */
  forgetScroll(path) {
    if (path) scrollMemory.delete(`#/${String(path).replace(/^#?\/?/, "")}`);
    else scrollMemory.clear();
  },
};
