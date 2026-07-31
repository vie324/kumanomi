/* ============================================================
   ごほうび交換 ページ
   サンクスで貯めたポイントの「出口」。
   タブ: ごほうび交換(カタログ) / 称号コレクション / 感謝の分析
   ============================================================ */
import { store, todayStr, monthOf } from "../store.js";
import {
  el, clear, icon, card, sectionHeader, statTile, badge, chip, avatar,
  staffChip, table, tabs, segmented, emptyState, modal, toast, celebrate,
  fmtNum, fmtDate,
} from "../ui.js";
import { hBars, donut, barChart } from "../charts.js";
import { rankLevel } from "../auth.js";
import {
  balance, earnedPoints, spentPoints, badgeProgress, redeemGift, myRedemptions,
  ranking, giverRanking, valueBreakdown, storeMatrix, notYetThanked,
  allCards, pointsPerRecipient,
} from "../thanks.js";

/* ---------------- 定数 ---------------- */

const CATEGORIES = ["すべて", "ちょっとした贅沢", "食事", "学び", "仕事道具", "時間", "体験"];

const TIER = {
  bronze: "ブロンズ",
  silver: "シルバー",
  gold: "ゴールド",
};

/** バッジの判定指標 → 日本語の条件文 */
const METRIC = {
  sent: { label: "送ったサンクスカード", unit: "枚" },
  received: { label: "受け取ったサンクスカード", unit: "枚" },
  withMedia: { label: "写真・動画つきで送ったカード", unit: "枚" },
  valuesCovered: { label: "カードを送ったバリューの種類", unit: "種類" },
  storesReached: { label: "カードを送った先の店舗", unit: "店舗" },
  weekStreak: { label: "連続してカードを送った週", unit: "週" },
  reactionsGiven: { label: "仲間のカードへのリアクション", unit: "回" },
};

/* ---------------- 小さなヘルパー ---------------- */

const pts = (n) => `${fmtNum(n)}pt`;

/** モーダル/オーバーレイの中身も .page-rewards でラップする(CSSスコープのため) */
const mwrap = (...kids) => el("div", { class: "page-rewards" }, ...kids);

/** 'YYYY-MM' を n ヶ月ずらす */
function shiftMonth(m, n) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y, mo - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(m) { return `${Number(m.slice(5))}月`; }

/** 交換ステータス → バッジ */
function redemptionStatus(status) {
  if (status === "delivered") return badge("お渡し済み", "good", true);
  if (status === "cancelled") return badge("キャンセル", "");
  return badge("処理中", "warn", true);
}

function giftOf(giftId) { return store.byId("giftCatalog", giftId); }

/** 引換コードの表示(コピーできる風) */
function codeChip(code) {
  return el("span", { class: "rw-code-inline" }, code);
}

/** 紙吹雪(お祝い演出)。1.5〜2.6秒でふわっと落ちて消える。 */
function confetti() {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const layer = el("div", { class: "page-rewards rw-confetti", "aria-hidden": "true" });
  const tones = ["a", "b", "c", "d", "e"];
  for (let i = 0; i < 54; i++) {
    layer.appendChild(el("i", {
      class: `cf ${tones[i % tones.length]} d${i % 6}${i % 3 === 0 ? " round" : ""}`,
      style: {
        left: (Math.random() * 100).toFixed(2) + "%",
        width: (5 + Math.random() * 5).toFixed(1) + "px",
        height: (7 + Math.random() * 8).toFixed(1) + "px",
        animationDelay: (Math.random() * 0.45).toFixed(2) + "s",
        animationDuration: (1.5 + Math.random() * 1.1).toFixed(2) + "s",
      },
    }));
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 3200);
}

/* ============================================================
   ページ本体
   ============================================================ */

export default {
  id: "rewards",
  title: "ごほうび交換",
  icon: "medal",

  render(root, params) {
    const me = store.me();
    const isAdmin = rankLevel(me) >= 3;
    const curMonth = monthOf(todayStr());

    const TABS = [
      { id: "gifts", label: "ごほうび交換" },
      { id: "badges", label: "称号コレクション" },
      { id: "insight", label: "感謝の分析" },
    ];
    const state = {
      tab: TABS.some((t) => t.id === params?.[0]) ? params[0] : "gifts",
      cat: "すべて",
      monthBack: 0,
    };

    /* ============================================================
       1. ごほうび交換(カタログ)
       ============================================================ */

    /** 交換確認 → 実行 */
    function openRedeemModal(gift) {
      const bal = balance(me.id);
      const okBtn = el("button", { class: "btn primary" }, icon("gift", 15), "交換する");
      const cancelBtn = el("button", { class: "btn ghost" }, "やめておく");
      const m = modal({
        title: "ごほうびと交換します",
        body: mwrap(
          el("div", { class: "rw-cf" },
            el("span", { class: "rw-cf-emoji" }, gift.emoji),
            el("div", { class: "rw-cf-main" },
              el("div", { class: "rw-cf-name" }, gift.name),
              el("div", { class: "rw-cf-desc" }, gift.desc))),
          el("div", { class: "rw-cf-kv" },
            el("div", { class: "rw-cf-row" },
              el("span", {}, "必要ポイント"),
              el("b", { class: "rw-cf-cost" }, `−${pts(gift.cost)}`)),
            el("div", { class: "rw-cf-row" },
              el("span", {}, "現在の残高"),
              el("b", {}, pts(bal))),
            el("div", { class: "rw-cf-row total" },
              el("span", {}, "交換後の残高"),
              el("b", {}, pts(bal - gift.cost)))),
          el("p", { class: "rw-cf-note" },
            icon("info", 14),
            el("span", {}, "交換すると引換コードが発行されます。コードを店舗責任者に見せると、お渡し処理が行われます。")),
        ),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      okBtn.addEventListener("click", () => {
        const res = redeemGift(gift.id);
        if (res.error) { toast(res.error, "error"); return; }
        m.close();
        confetti();
        openCodeModal(res.gift, res.redemption);
        celebrate(`「${gift.name}」と交換しました!`);
        renderAll();
      });
    }

    /** 引換コードの発行モーダル */
    function openCodeModal(gift, rec) {
      const codeEl = el("div", { class: "rw-code-val" }, rec.code);
      const copyBtn = el("button", { class: "btn soft sm rw-copy" }, icon("clipboard", 14), "コードをコピー");
      copyBtn.addEventListener("click", async () => {
        try { await navigator.clipboard?.writeText(rec.code); } catch (e) { /* 権限が無くても表示は進める */ }
        clear(copyBtn).append(icon("check", 14), "コピーしました");
        toast("引換コードをコピーしました", "info");
        setTimeout(() => { clear(copyBtn).append(icon("clipboard", 14), "コードをコピー"); }, 2200);
      });
      const closeBtn = el("button", { class: "btn primary" }, "閉じる");
      const m = modal({
        title: "引換コードが発行されました",
        body: mwrap(
          el("div", { class: "rw-code-hero" },
            el("span", { class: "rw-code-emoji" }, gift.emoji),
            el("div", { class: "rw-code-name" }, gift.name),
            el("div", { class: "rw-code-sub" }, `${pts(gift.cost)} を使いました・残高 ${pts(balance(me.id))}`)),
          el("div", { class: "rw-code-box" },
            el("div", { class: "rw-code-label" }, "引換コード"),
            codeEl,
            copyBtn),
          el("p", { class: "rw-cf-note" },
            icon("info", 14),
            el("span", {}, "このコードを店舗責任者にお見せください。お渡しが完了すると、履歴のステータスが「お渡し済み」に変わります。")),
        ),
        actions: [closeBtn],
      });
      closeBtn.addEventListener("click", m.close);
    }

    /** 景品カード */
    function giftCard(g, bal) {
      const out = g.stock <= 0;
      const can = !out && g.cost <= bal;
      const short = Math.max(0, g.cost - bal);
      const btn = el("button", {
        class: `btn ${can ? "primary" : "ghost"} sm rw-g-btn`,
        disabled: !can,
        onclick: can ? () => openRedeemModal(g) : null,
      }, can ? [icon("gift", 14), "交換する"] : out ? "在庫切れ" : `あと ${pts(short)}`);

      return el("div", { class: `rw-gift ${can ? "can" : "locked"} ${out ? "out" : ""}` },
        el("div", { class: "rw-g-top" },
          el("span", { class: "rw-g-emoji" }, g.emoji),
          g.popular ? el("span", { class: "rw-g-pop" }, icon("star", 11), "人気") : null),
        el("div", { class: "rw-g-name" }, g.name),
        el("div", { class: "rw-g-desc" }, g.desc),
        el("div", { class: "rw-g-foot" },
          el("span", { class: "rw-g-cost" }, fmtNum(g.cost), el("i", {}, "pt")),
          el("span", { class: "rw-g-meta" },
            el("span", { class: `rw-g-stock ${out ? "none" : ""}` },
              out ? "在庫切れ" : g.stock >= 100 ? "在庫あり" : `残り ${fmtNum(g.stock)}`),
            el("span", { class: "rw-g-cat" }, g.category))),
        btn);
    }

    /** 残高ヒーロー */
    function balanceHero(bal, earned, spent, catalog) {
      const affordable = catalog.filter((g) => g.cost <= bal && g.stock > 0);
      const next = catalog
        .filter((g) => g.cost > bal && g.stock > 0)
        .sort((a, b) => a.cost - b.cost)[0] || null;

      const left = el("div", { class: "rw-hero-main" },
        el("div", { class: "rw-hero-label" }, icon("gift", 15), "交換に使えるポイント"),
        el("div", { class: "rw-hero-num" },
          el("b", {}, fmtNum(bal)),
          el("span", {}, "pt")),
        el("div", { class: "rw-hero-break" },
          el("span", {}, "累計獲得 ", el("b", {}, pts(earned))),
          el("i", { class: "rw-dot" }),
          el("span", {}, "交換済み ", el("b", {}, pts(spent)))),
        el("p", { class: "rw-hero-note" },
          affordable.length
            ? `いま ${affordable.length}件のごほうびと交換できます。`
            : "仲間から届いた「ありがとう」が、そのままポイントになります。"));

      const right = next
        ? el("div", { class: "rw-next" },
            el("div", { class: "rw-next-head" }, icon("target", 14), "次に手が届くごほうび"),
            el("div", { class: "rw-next-body" },
              el("span", { class: "rw-next-emoji" }, next.emoji),
              el("div", { class: "rw-next-meta" },
                el("div", { class: "rw-next-name" }, next.name),
                el("div", { class: "rw-next-sub" }, `${pts(next.cost)}・${next.category}`))),
            el("div", { class: "rw-next-track" },
              el("div", {
                class: "rw-next-fill",
                style: { width: Math.min(100, Math.round((bal / next.cost) * 100)) + "%" },
              })),
            el("div", { class: "rw-next-foot" },
              el("span", {}, "あと "),
              el("b", {}, pts(next.cost - bal)),
              el("span", { class: "rw-next-pct" }, `達成 ${Math.min(100, Math.round((bal / next.cost) * 100))}%`)))
        : el("div", { class: "rw-next" },
            el("div", { class: "rw-next-head" }, icon("sparkle", 14), "コンプリート間近"),
            el("p", { class: "rw-next-sub", style: { marginTop: "8px" } },
              "いまの残高で、在庫のあるすべてのごほうびに手が届いています。"));

      return el("div", { class: "rw-hero" }, left, right);
    }

    function renderGifts(body) {
      const bal = balance(me.id);
      const earned = earnedPoints(me.id);
      const spent = spentPoints(me.id);
      const catalog = store.get("giftCatalog");

      body.appendChild(balanceHero(bal, earned, spent, catalog));

      /* --- カタログ --- */
      const rows = catalog.filter((g) => state.cat === "すべて" || g.category === state.cat);
      const sorted = [...rows].sort((a, b) => {
        const ca = a.cost <= bal && a.stock > 0 ? 0 : 1;
        const cb = b.cost <= bal && b.stock > 0 ? 0 : 1;
        return ca - cb || a.cost - b.cost;
      });
      const chipsRow = el("div", { class: "flex wrap rw-chips" },
        CATEGORIES.map((c) => chip(c, {
          on: state.cat === c,
          onClick: () => { state.cat = c; renderAll(); },
        })));

      body.appendChild(card({
        title: "ごほうびカタログ",
        sub: `${state.cat === "すべて" ? "全カテゴリ" : state.cat}・${sorted.length}件`,
        body: el("div", {}, chipsRow,
          sorted.length
            ? el("div", { class: "rw-gifts" }, sorted.map((g) => giftCard(g, bal)))
            : emptyState({ icon: "🎁", title: "このカテゴリのごほうびはありません" })),
      }));

      /* --- 自分の交換履歴 --- */
      const mine = myRedemptions(me.id);
      const historyCols = [
        { key: "date", label: "交換日", render: (r) => fmtDate(r.date) },
        {
          key: "gift", label: "ごほうび",
          render: (r) => {
            const g = giftOf(r.giftId);
            return el("span", { class: "rw-h-gift" },
              el("span", { class: "rw-h-emoji" }, g?.emoji || "🎁"),
              el("span", {}, g?.name || "—"));
          },
        },
        { key: "cost", label: "使用ポイント", align: "right", render: (r) => el("span", { class: "mono-num rw-h-cost" }, `−${pts(r.cost)}`) },
        { key: "status", label: "ステータス", align: "center", render: (r) => redemptionStatus(r.status) },
        { key: "code", label: "引換コード", render: (r) => codeChip(r.code) },
      ];
      body.appendChild(card({
        title: "わたしの交換履歴",
        sub: mine.length ? `${mine.length}件・新しい順` : "まだ交換はありません",
        body: mine.length
          ? table({ columns: historyCols, rows: mine })
          : emptyState({
              icon: "🎫",
              title: "まだごほうびと交換していません",
              hint: "仲間からのサンクスでポイントを貯めて、最初の1つと交換しましょう",
            }),
      }));

      /* --- 管理者向け:みんなの交換状況 --- */
      if (isAdmin) {
        const all = [...(store.get("giftRedemptions") || [])].sort((a, b) => (a.date < b.date ? 1 : -1));
        const counts = new Map();
        for (const r of all) {
          if (r.status === "cancelled") continue;
          counts.set(r.giftId, (counts.get(r.giftId) || 0) + 1);
        }
        const popular = [...counts.entries()]
          .map(([gid, v]) => ({ label: `${giftOf(gid)?.emoji || "🎁"} ${giftOf(gid)?.name || gid}`, value: v }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 6);
        const totalPt = all.filter((r) => r.status !== "cancelled").reduce((a, r) => a + (r.cost || 0), 0);

        const rankCard = card({
          title: "人気のごほうび",
          sub: "交換された回数",
          body: popular.length
            ? hBars({ items: popular, fmt: (v) => `${fmtNum(v)}件` })
            : emptyState({ icon: "🎁", title: "交換の実績がまだありません" }),
        });

        const listCols = [
          { key: "staff", label: "スタッフ", render: (r) => staffChip(r.staffId) },
          {
            key: "gift", label: "ごほうび",
            render: (r) => el("span", { class: "rw-h-gift" },
              el("span", { class: "rw-h-emoji" }, giftOf(r.giftId)?.emoji || "🎁"),
              el("span", {}, giftOf(r.giftId)?.name || "—")),
          },
          { key: "date", label: "交換日", render: (r) => fmtDate(r.date) },
          { key: "cost", label: "ポイント", align: "right", render: (r) => el("span", { class: "mono-num" }, pts(r.cost)) },
          { key: "status", label: "ステータス", align: "center", render: (r) => redemptionStatus(r.status) },
        ];
        const listCard = card({
          title: "みんなの交換状況",
          sub: `全 ${all.length}件・使用ポイント合計 ${pts(totalPt)}`,
          actions: badge("院長・管理者のみ表示", "accent"),
          body: table({ columns: listCols, rows: all.slice(0, 12), empty: "交換の記録はまだありません" }),
        });

        body.appendChild(el("div", { class: "grid cols-2 rw-admin" }, listCard, rankCard));
      }
    }

    /* ============================================================
       2. 称号コレクション
       ============================================================ */

    /** 全スタッフのバッジ進捗(1回だけ計算して使い回す) */
    function progressMap() {
      return new Map(store.get("staff").map((s) => [s.id, badgeProgress(s.id)]));
    }

    function remainText(b) {
      const unit = METRIC[b.metric]?.unit || "";
      return `あと ${fmtNum(Math.max(0, b.threshold - b.current))}${unit}`;
    }

    function openBadgeModal(b, pmap) {
      const holders = store.get("staff").filter((s) =>
        (pmap.get(s.id) || []).find((x) => x.id === b.id)?.earned);
      const met = METRIC[b.metric] || { label: b.metric, unit: "" };

      modal({
        title: "称号の詳細",
        body: mwrap(
          el("div", { class: `rw-bm-hero ${b.tier} ${b.earned ? "earned" : "locked"}` },
            el("span", { class: "rw-bm-emoji" }, b.emoji),
            el("div", {},
              el("div", { class: "rw-bm-name" }, b.name),
              el("div", { class: "rw-bm-tier" }, TIER[b.tier] || b.tier,
                b.earned ? badge("獲得済み", "good", true) : badge("未獲得", "")))),
          el("p", { class: "rw-bm-desc" }, b.desc),
          el("div", { class: "rw-bm-cond" },
            el("div", { class: "rw-bm-cond-head" },
              el("span", {}, met.label),
              el("b", {}, `${fmtNum(b.current)} / ${fmtNum(b.threshold)}${met.unit}`)),
            el("div", { class: "rw-bar" },
              el("div", { class: `rw-bar-fill ${b.earned ? "done" : ""}`, style: { width: b.pct + "%" } })),
            el("div", { class: "rw-bm-cond-foot" },
              b.earned ? "条件を達成しています🎉" : `${remainText(b)}で獲得できます(達成 ${b.pct}%)`)),
          el("div", { class: "rw-bm-holders" },
            el("div", { class: "rw-bm-holders-head" },
              icon("users", 14),
              `この称号を持っている仲間 ${holders.length}名`),
            holders.length
              ? el("div", { class: "rw-bm-people" }, holders.map((s) => el("span", { class: "rw-person" },
                  avatar(s, 26), el("span", {}, s.name))))
              : el("p", { class: "rw-bm-none" }, "まだ誰も獲得していません。第一号を目指しましょう!")),
        ),
      });
    }

    function badgeTile(b, pmap) {
      return el("button", {
        class: `rw-badge ${b.tier} ${b.earned ? "earned" : "locked"}`,
        onclick: () => openBadgeModal(b, pmap),
      },
        el("span", { class: "rw-b-ring" },
          el("span", { class: "rw-b-emoji" }, b.emoji)),
        el("span", { class: "rw-b-name" }, b.name),
        el("span", { class: "rw-b-tier" }, TIER[b.tier] || b.tier),
        b.earned
          ? el("span", { class: "rw-b-got" }, icon("check", 12), "獲得済み")
          : el("span", { class: "rw-b-prog" },
              el("span", { class: "rw-bar" },
                el("span", { class: "rw-bar-fill", style: { width: b.pct + "%" } })),
              el("span", { class: "rw-b-remain" }, remainText(b))));
    }

    function renderBadges(body) {
      const pmap = progressMap();
      const mine = pmap.get(me.id) || badgeProgress(me.id);
      const got = mine.filter((b) => b.earned);
      const rest = mine.filter((b) => !b.earned).sort((a, b) => b.pct - a.pct);
      const next = rest[0] || null;

      /* --- サマリー --- */
      body.appendChild(el("div", { class: "rw-bsum" },
        el("div", { class: "rw-bsum-main" },
          el("div", { class: "rw-hero-label" }, icon("medal", 15), "獲得した称号"),
          el("div", { class: "rw-hero-num" },
            el("b", {}, fmtNum(got.length)),
            el("span", {}, `/ ${mine.length}`)),
          el("div", { class: "rw-bsum-emojis" },
            mine.map((b) => el("span", { class: `rw-bsum-e ${b.earned ? "on" : ""}` }, b.emoji)))),
        next
          ? el("div", { class: "rw-next" },
              el("div", { class: "rw-next-head" }, icon("target", 14), "いちばん近い称号"),
              el("div", { class: "rw-next-body" },
                el("span", { class: "rw-next-emoji" }, next.emoji),
                el("div", { class: "rw-next-meta" },
                  el("div", { class: "rw-next-name" }, next.name),
                  el("div", { class: "rw-next-sub" }, next.desc))),
              el("div", { class: "rw-next-track" },
                el("div", { class: "rw-next-fill", style: { width: next.pct + "%" } })),
              el("div", { class: "rw-next-foot" },
                el("b", {}, `${remainText(next)}で「${next.name}」`),
                el("span", { class: "rw-next-pct" }, `達成 ${next.pct}%`)))
          : el("div", { class: "rw-next" },
              el("div", { class: "rw-next-head" }, icon("sparkle", 14), "コンプリート"),
              el("p", { class: "rw-next-sub", style: { marginTop: "8px" } },
                "すべての称号を獲得しています。仲間の見本です!"))));

      /* --- 自分のバッジ一覧 --- */
      body.appendChild(card({
        title: "わたしの称号",
        sub: `獲得 ${got.length}個・挑戦中 ${rest.length}個(カードをタップすると条件が見られます)`,
        body: el("div", { class: "rw-badges" },
          [...got, ...rest].map((b) => badgeTile(b, pmap))),
      }));

      /* --- みんなの称号 --- */
      const ranked = store.get("staff")
        .map((s) => ({
          staff: s,
          badges: (pmap.get(s.id) || []).filter((b) => b.earned),
        }))
        .sort((a, b) => b.badges.length - a.badges.length || a.staff.id.localeCompare(b.staff.id));
      const withBadge = ranked.filter((r) => r.badges.length > 0);
      const none = ranked.length - withBadge.length;
      const totalGot = ranked.reduce((a, r) => a + r.badges.length, 0);
      // 同順位が並ぶときは順位を出さない(全員が同じ数の期間もあるため)
      const counts = withBadge.map((r) => r.badges.length);
      const rankOfRow = (i) => new Set(counts.filter((c) => c > counts[i])).size + 1;
      const tiedWith = (i) => counts.filter((c) => c === counts[i]).length;

      body.appendChild(card({
        title: "みんなの称号",
        sub: `獲得数の多い順・全社で ${totalGot}個 / ${ranked.length * mine.length}個を獲得`,
        body: el("div", {},
          el("div", { class: "rw-people" },
            withBadge.map((r, i) => {
              const rk = rankOfRow(i);
              const medal = rk <= 3 && tiedWith(i) <= 3;
              return el("div", { class: "rw-people-row" },
                el("span", { class: `rw-rank ${medal ? "r" + rk : "plain"}` }, medal ? rk : "・"),
                avatar(r.staff, 34),
                el("span", { class: "rw-people-meta" },
                  el("span", { class: "rw-people-name" }, r.staff.name,
                    r.staff.id === me.id ? badge("あなた", "brand") : null),
                  el("span", { class: "rw-people-sub" }, `${store.storeName(r.staff.storeId)}・${r.staff.role}`)),
                el("span", { class: "rw-people-emojis" },
                  r.badges.map((b) => el("span", { class: "rw-pe", title: b.name }, b.emoji))),
                el("span", { class: "rw-people-count" }, `${r.badges.length}個`));
            })),
          none
            ? el("p", { class: "rw-people-foot" },
                icon("info", 13),
                el("span", {}, `まだ称号のない仲間が ${none}名います。最初の1枚を送ると「はじめの一歩」を獲得できます。`))
            : null),
      }));
    }

    /* ============================================================
       3. 感謝の分析
       ============================================================ */

    /** 表彰状風カード */
    function awardCard({ kind, title, sub, entry, metricText, emptyLabel }) {
      if (!entry) {
        return el("div", { class: `rw-award ${kind}` },
          el("div", { class: "rw-award-inner" },
            el("div", { class: "rw-award-kicker" }, icon(kind === "mvp" ? "award" : "heart", 13), title),
            el("div", { class: "rw-award-sub" }, sub),
            emptyState({ icon: "🏆", title: emptyLabel })));
      }
      const s = store.byId("staff", entry.staffId);
      return el("div", { class: `rw-award ${kind}` },
        el("div", { class: "rw-award-inner" },
          el("div", { class: "rw-award-kicker" }, icon(kind === "mvp" ? "award" : "heart", 13), title),
          el("div", { class: "rw-award-sub" }, sub),
          avatar(s, 62),
          el("div", { class: "rw-award-name" }, s?.name || "—"),
          el("div", { class: "rw-award-role" }, `${store.storeName(s?.storeId)}・${s?.role || ""}`),
          el("div", { class: "rw-award-metric" }, metricText),
          el("div", { class: "rw-award-seal" }, "くまのみ整骨院・整体院グループ")));
    }

    /** 店舗間ヒートマップ */
    function heatmap(month) {
      const { stores, mat } = storeMatrix(month);
      const max = Math.max(1, ...mat.flat());
      const level = (v) => (v <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));

      const head = el("tr", {},
        el("th", { class: "rw-hm-corner" }, el("span", {}, "送り主 ＼ 受け取り")),
        stores.map((s) => el("th", { class: "rw-hm-top" }, s.short)));
      const rows = stores.map((from, i) => el("tr", {},
        el("th", { class: "rw-hm-side" }, from.short),
        stores.map((to, j) => {
          const v = mat[i][j];
          return el("td", {
            class: `rw-hm-cell lv${level(v)} ${i === j ? "self" : ""}`,
            title: `${from.name} → ${to.name}:${v}枚`,
          }, v > 0 ? String(v) : "");
        })));

      const legend = el("div", { class: "rw-hm-legend" },
        el("span", { class: "muted small" }, "少ない"),
        [1, 2, 3, 4].map((l) => el("span", { class: `rw-hm-sw lv${l}` })),
        el("span", { class: "muted small" }, "多い"),
        el("span", { class: "rw-hm-note" }, `最大 ${max}枚 / 対角線は同じ店舗内での感謝`));

      return el("div", {},
        el("div", { class: "rw-hm-wrap" },
          el("table", { class: "rw-hm" }, el("thead", {}, head), el("tbody", {}, rows))),
        legend);
    }

    function renderInsight(body) {
      const month = state.monthBack === 0 ? curMonth : shiftMonth(curMonth, -1);
      const cards = allCards().filter((c) => (c.date || "").startsWith(month));
      const movedPoints = cards.reduce(
        (a, c) => a + pointsPerRecipient(c) * ((c.toIds || []).length || 1), 0);
      const staffAll = store.get("staff");
      const reached = new Set(cards.flatMap((c) => c.toIds || []));
      const notYet = notYetThanked(month);

      /* --- 期間切替 --- */
      body.appendChild(el("div", { class: "rw-monthbar" },
        el("div", { class: "rw-monthbar-main" },
          el("span", { class: "rw-monthbar-title" }, `${monthLabel(month)}の感謝`),
          el("span", { class: "muted small" }, `サンクスカード ${cards.length}枚から集計しています`)),
        segmented(
          [{ id: 0, label: "今月" }, { id: 1, label: "先月" }],
          state.monthBack,
          (id) => { state.monthBack = id; renderAll(); })));

      body.appendChild(el("div", { class: "kpi-row rw-kpis" },
        statTile({ label: "サンクスカード", value: `${fmtNum(cards.length)}枚`, icon: "heart", sub: `${monthLabel(month)}に送られた枚数`, tone: "brand" }),
        statTile({ label: "動いた感謝ポイント", value: pts(movedPoints), icon: "sparkle", sub: "ブースト分を含む合計", tone: "accent" }),
        statTile({
          label: "感謝が届いた仲間", value: `${reached.size} / ${staffAll.length}名`,
          icon: "users", sub: notYet.length ? `未達 ${notYet.length}名` : "全員に届きました",
          tone: notYet.length ? "warn" : "good",
        }),
      ));

      /* --- 表彰状 --- */
      const mvp = ranking({ month, limit: 1 })[0] || null;
      const giver = giverRanking({ month, limit: 1 })[0] || null;
      body.appendChild(el("div", { class: "grid cols-2 rw-awards" },
        awardCard({
          kind: "mvp", title: "月間MVP", sub: `${monthLabel(month)}・もっとも感謝を受け取った仲間`,
          entry: mvp,
          metricText: mvp ? `${pts(mvp.points)}・${fmtNum(mvp.count)}枚のカード` : "",
          emptyLabel: "この月のカードはまだありません",
        }),
        awardCard({
          kind: "giver", title: "ギバー賞", sub: `${monthLabel(month)}・もっとも感謝を贈った仲間`,
          entry: giver,
          metricText: giver ? `${fmtNum(giver.count)}枚を送信・${pts(giver.points)}を贈呈` : "",
          emptyLabel: "この月のカードはまだありません",
        })));

      /* --- バリュー別 + 月次推移 --- */
      const vb = valueBreakdown(month).sort((a, b) => b.count - a.count);
      const vbTotal = vb.reduce((a, v) => a + v.count, 0);
      const top = vb[0];
      const valueCard = card({
        title: "バリュー別の感謝",
        sub: `${monthLabel(month)}・カード ${vbTotal}枚の内訳`,
        body: vbTotal
          ? el("div", {},
              el("p", { class: "rw-lead" },
                icon("sparkle", 15),
                el("span", {}, `${monthLabel(month)}は `,
                  el("b", {}, `「${top.label}」`),
                  ` への感謝がいちばん多く届きました(${top.count}枚・全体の ${Math.round((top.count / vbTotal) * 100)}%)。`)),
              donut({
                items: vb.map((v) => ({ label: `${v.emoji} ${v.label}`, value: v.count, color: v.color })),
                size: 168,
                centerLabel: "カード枚数", centerValue: `${vbTotal}枚`,
                fmt: (v) => `${fmtNum(v)}枚`,
              }))
          : emptyState({ icon: "💌", title: "この月に送られたカードはありません" }),
      });

      const labels = [], values = [];
      for (let i = 5; i >= 0; i--) {
        const mm = shiftMonth(curMonth, -i);
        labels.push(monthLabel(mm));
        values.push(allCards().filter((c) => (c.date || "").startsWith(mm)).length);
      }
      const trendCard = card({
        title: "サンクスカードの推移",
        sub: "直近6ヶ月・全社の送信枚数",
        body: barChart({
          series: [{ name: "サンクスカード", values }],
          labels, height: 220,
          yFmt: (v) => `${Math.round(v)}`,
        }),
      });
      body.appendChild(el("div", { class: "grid cols-2 rw-analytics" }, valueCard, trendCard));

      /* --- 店舗間ヒートマップ --- */
      body.appendChild(card({
        title: "店舗間の送り合い",
        sub: `${monthLabel(month)}・行=送り主の店舗 / 列=受け取った店舗`,
        body: el("div", {},
          el("p", { class: "rw-lead subtle" },
            icon("info", 15),
            el("span", {}, "色が濃いほど多くの感謝が行き来しています。店舗をまたぐマスが増えるほど、横のつながりが育っています。")),
          heatmap(month)),
      }));

      /* --- 感謝が届いていない仲間 --- */
      const goBtn = el("button", {
        class: "btn primary sm",
        onclick: () => { location.hash = "#/thanks"; },
      }, icon("send", 14), "サンクスカードを送る");

      body.appendChild(card({
        title: "感謝がまだ届いていない仲間",
        sub: notYet.length ? `${monthLabel(month)}・${notYet.length}名` : "全員に届いています",
        actions: notYet.length ? goBtn : null,
        body: notYet.length
          ? el("div", {},
              el("p", { class: "rw-lead subtle" },
                icon("heart", 15),
                el("span", {}, `${monthLabel(month)}はこの ${notYet.length}名にまだカードが届いていません。日々の小さな支えに、声をかけてみましょう。`)),
              el("div", { class: "rw-notyet" },
                notYet.map((s) => el("span", { class: "rw-person lg" },
                  avatar(s, 36),
                  el("span", { class: "rw-person-meta" },
                    el("b", {}, s.name),
                    el("span", { class: "muted small" }, `${store.storeName(s.storeId)}・${s.role}`))))))
          : emptyState({ icon: "🎉", title: "今月は全員に感謝が届いています", hint: "すばらしい月です。この空気を来月にも" }),
      }));
    }

    /* ============================================================
       レイアウト・タブ切替
       ============================================================ */
    const tabsWrap = el("div", {});
    const tabBody = el("div", { class: "stack rw-body" });

    function renderTabs() {
      const bal = balance(me.id);
      const canCount = store.get("giftCatalog").filter((g) => g.cost <= bal && g.stock > 0).length;
      const gotCount = badgeProgress(me.id).filter((b) => b.earned).length;
      const items = TABS.map((t) => ({
        ...t,
        badge: t.id === "gifts" && canCount ? canCount : t.id === "badges" && gotCount ? gotCount : null,
      }));
      clear(tabsWrap).appendChild(tabs(items, state.tab, (id) => { state.tab = id; renderAll(); }));
    }

    function renderAll() {
      renderTabs();
      clear(tabBody);
      if (state.tab === "gifts") renderGifts(tabBody);
      else if (state.tab === "badges") renderBadges(tabBody);
      else renderInsight(tabBody);
    }

    root.append(
      sectionHeader(
        "ごほうび交換",
        "仲間から届いた感謝ポイントを、ごほうび・称号に交換できます。貯まったポイントは翌月に持ち越されます。",
        el("button", { class: "btn ghost", onclick: () => { location.hash = "#/thanks"; } },
          icon("heart", 15), "サンクスを送る"),
      ),
      tabsWrap,
      tabBody,
    );
    renderAll();
  },
};
