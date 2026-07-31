/* ============================================================
   サンクスギフト — 感謝を「もらって嬉しい1枚のカード」にする
   ・フィード:グリーティングカードとして並ぶ感謝の流れ
   ・送る:左に入力 / 右にリアルタイムプレビューの2カラム
   ・もらったカード:自分のコレクションと強みの内訳
   ・ランキング:称える月次サマリー
   データ操作はすべて js/thanks.js の関数経由。
   ============================================================ */

import {
  el, clear, icon, avatar, badge, chip, sectionHeader, tabs, segmented,
  emptyState, modal, toast, relTime, fmtDate, meter, statTile, celebrate,
} from "../ui.js";
import { store, todayStr, monthOf } from "../store.js";
import { rankLevel } from "../auth.js";
import {
  MONTHLY_BUDGET, POINT_OPTIONS, BOOST_OPTIONS, REACTIONS,
  allCards, sortedCards, valueOf, designOf, involves, pointsPerRecipient,
  sentThisMonth, remainingPoints, earnedPoints, balance,
  statsOf, badgeProgress, ranking, giverRanking, valueBreakdown, storeMatrix,
  notYetThanked, sendCard, boostCard, toggleReaction, addComment, messageHints,
} from "../thanks.js";
import { mediaSrc, fmtDuration, SAMPLE_MEDIA } from "../media.js";

/* ============================================================
   小さなヘルパー
   ============================================================ */

const TAB_DEFS = [
  { id: "feed", label: "フィード" },
  { id: "compose", label: "送る" },
  { id: "mine", label: "もらったカード" },
  { id: "rank", label: "ランキング" },
];

const MAX_MEDIA = 4;
const MAX_MSG = 300;

function nameOf(id) { return store.byId("staff", id)?.name || "—"; }
function firstNameOf(id) { return (store.byId("staff", id)?.name || "").split(" ")[0]; }

function shiftMonth(m, delta) {
  const [y, mo] = String(m).split("-").map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(m) {
  const [y, mo] = String(m).split("-").map(Number);
  return `${y}年${mo}月`;
}

/* ------------------------------------------------------------
   media.js の photoDataUri は seed によっては絵文字が undefined になる
   (符号付きシフトで負のインデックスになるケースがある)。
   共有ファイルは変更できないため、ページ側で生成後に差し替える。
   ------------------------------------------------------------ */
const SCENE_FALLBACK = ["🤝", "🎉", "💪", "🌸", "📣", "🧑‍⚕️", "🏥", "✨", "🍰", "📸", "🌅", "🏆", "🧹", "📚", "💬", "🫶"];
function fnv(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) { h ^= String(str).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mediaUrl(m, opts = {}) {
  const url = mediaSrc(m, { label: "", ...opts });
  if (!url.includes("%3Eundefined%3C")) return url;
  const fb = SCENE_FALLBACK[(fnv(m?.seed ?? m?.id ?? "x") >>> 3) % SCENE_FALLBACK.length];
  return url.replace("%3Eundefined%3C", `%3E${encodeURIComponent(fb)}%3C`);
}

/** CSS カスタムプロパティは style オブジェクト代入では効かないため文字列で渡す */
function cssVars(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}:${v}`).join(";");
}

/** カードの台紙(デザイン)をCSS変数として渡す */
function designVars(design) {
  const g = design?.grad || ["#f8a423", "#e2621a"];
  return cssVars({ "--g1": g[0], "--g2": g[1], "--tcink": design?.ink || "#ffffff" });
}

/** 紙吹雪(送信成功のお祝い) */
function confettiBurst(colors) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const pal = (colors && colors.length ? colors : ["#f8a423", "#e2621a", "#0c7489", "#e87ba4", "#1baf7a", "#ffd66b"]);
  const layer = el("div", { class: "page-thanks tk-confetti", "aria-hidden": "true" });
  for (let i = 0; i < 34; i++) {
    layer.appendChild(el("span", {
      class: "tk-cf",
      style: {
        left: Math.random() * 100 + "%",
        background: pal[i % pal.length],
        width: 6 + Math.random() * 7 + "px",
        height: 9 + Math.random() * 9 + "px",
        animationDelay: Math.random() * 0.35 + "s",
        animationDuration: 1.5 + Math.random() * 1.1 + "s",
        transform: `rotate(${Math.random() * 360}deg)`,
      },
    }));
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 3000);
}

/* ============================================================
   ライトボックス(写真・動画の全画面表示)
   ============================================================ */

function openLightbox(list, startIndex = 0, subtitle = "") {
  let i = Math.max(0, Math.min(startIndex, list.length - 1));
  let timer = null;

  const stage = el("div", { class: "tlb-stage" });
  const capEl = el("div", { class: "tlb-cap" });
  const counter = el("div", { class: "tlb-count" });

  const prevBtn = el("button", { class: "tlb-nav prev", "aria-label": "前へ", onclick: (e) => { e.stopPropagation(); go(-1); } }, icon("chevL", 24));
  const nextBtn = el("button", { class: "tlb-nav next", "aria-label": "次へ", onclick: (e) => { e.stopPropagation(); go(1); } }, icon("chevR", 24));
  const closeBtn = el("button", { class: "tlb-close", "aria-label": "閉じる", onclick: close }, icon("x", 20));

  const scrim = el("div", { class: "page-thanks tlb-scrim", onclick: (e) => { if (e.target === scrim || e.target === inner) close(); } });
  const inner = el("div", { class: "tlb-inner" }, stage, el("div", { class: "tlb-foot" }, capEl, counter));
  scrim.append(closeBtn, prevBtn, nextBtn, inner);

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  function draw() {
    stopTimer();
    clear(stage);
    const m = list[i];
    const img = el("img", { class: "tlb-img", src: mediaUrl(m, { w: 1280, h: 860 }), alt: m.caption || "" });
    if (m.kind === "video") {
      const dur = Math.max(1, Math.round(m.durationSec || 30));
      let t = 0;
      let playing = true;
      const bar = el("div", { class: "tlb-bar-fill" });
      const time = el("span", { class: "tlb-time" }, `0:00 / ${fmtDuration(dur)}`);
      const glyph = (on) => (on
        ? el("span", { class: "tlb-pausebars" }, el("i"), el("i"))
        : icon("play", 16));
      const toggle = el("button", { class: "tlb-toggle", "aria-label": "再生/一時停止" }, glyph(true));
      const tick = () => {
        if (!playing) return;
        t = (t + 0.25) % (dur + 0.25);
        bar.style.width = Math.min(100, (t / dur) * 100) + "%";
        time.textContent = `${fmtDuration(t)} / ${fmtDuration(dur)}`;
      };
      timer = setInterval(tick, 250);
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        playing = !playing;
        toggle.classList.toggle("paused", !playing);
        clear(toggle).appendChild(glyph(playing));
      });
      stage.append(
        el("div", { class: "tlb-video" },
          img,
          el("div", { class: "tlb-vgrad" }),
          el("div", { class: "tlb-playing" }, icon("film", 15), "再生中"),
          el("div", { class: "tlb-ctrl" }, toggle, el("div", { class: "tlb-bar" }, bar), time)),
        el("div", { class: "tlb-note" }, icon("info", 13), "デモ表示です。実運用ではアップロードされた動画がそのまま再生されます。"));
    } else {
      stage.appendChild(img);
    }
    clear(capEl);
    capEl.appendChild(el("span", { class: "tlb-cap-main" }, m.caption || (m.kind === "video" ? "動画" : "写真")));
    if (subtitle) capEl.appendChild(el("span", { class: "tlb-cap-sub" }, subtitle));
    counter.textContent = list.length > 1 ? `${i + 1} / ${list.length}` : "";
    prevBtn.style.display = nextBtn.style.display = list.length > 1 ? "" : "none";
  }

  function go(d) { i = (i + d + list.length) % list.length; draw(); }

  function onKey(e) {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
  }

  function close() {
    stopTimer();
    scrim.remove();
    document.removeEventListener("keydown", onKey);
  }

  document.addEventListener("keydown", onKey);
  document.body.appendChild(scrim);
  draw();
  return { close };
}

/* ============================================================
   ページ
   ============================================================ */

export default {
  id: "thanks",
  title: "サンクスギフト",
  icon: "gift",

  render(root, params = []) {
    const me = store.me();
    const meId = me.id;
    const canBoost = rankLevel(me) >= 3;

    /* ---------------- 状態 ---------------- */
    let activeTab = TAB_DEFS.some((t) => t.id === params[0]) ? params[0] : "feed";
    let feedFilter = "all";
    let rankMonth = monthOf(todayStr());
    const expanded = new Set();     // コメント展開中のカード
    const draft = {
      toIds: [], valueId: null, points: 30, designId: "d1",
      message: "", media: [], visibility: "all",
      query: "", scope: "all",
    };

    /* ============================================================
       サンクスカード(このページの主役)
       ============================================================ */

    /**
     * card を「グリーティングカード」として描く。
     * opts: { preview: 送信前プレビュー(操作なし), flat: 影を薄く }
     */
    function cardNode(c, opts = {}) {
      const { preview = false } = opts;
      const design = designOf(c.designId);
      const value = valueOf(c.valueId);
      const from = store.byId("staff", c.fromId);
      const tos = (c.toIds || []).map((id) => store.byId("staff", id)).filter(Boolean);
      const boostPts = (c.boosts || []).reduce((a, b) => a + (b.points || 0), 0);

      const art = el("article", {
        class: `tcard ${c.pinned ? "pinned" : ""} ${preview ? "is-preview" : ""}`,
        style: designVars(design),
        dataset: preview ? {} : { cardId: c.id },
      });

      /* ---- 台紙(グラデーションのヘッダー) ---- */
      const toBox = el("span", { class: "tc-to" });
      tos.slice(0, 2).forEach((s) => toBox.appendChild(
        el("span", { class: "tc-person", title: `${s.name}(${store.storeName(s.storeId)}・${s.role})` },
          avatar(s, 26), el("span", { class: "tc-pname" }, s.name))));
      if (tos.length > 2) {
        const rest = tos.slice(2);
        toBox.appendChild(el("button", {
          class: "tc-more",
          title: rest.map((s) => s.name).join("、"),
          onclick: (e) => {
            e.stopPropagation();
            modal({
              title: "宛先のみなさん",
              body: el("div", { class: "page-thanks" },
                el("div", { class: "tc-modal-list" },
                  tos.map((s) => el("div", { class: "tcm-row" },
                    avatar(s, 34),
                    el("span", {},
                      el("span", { class: "tcm-name" }, s.name),
                      el("span", { class: "tcm-sub" }, `${store.storeName(s.storeId)}・${s.role}`)))))),
            });
          },
        }, `+${rest.length}名`));
      }
      if (!tos.length) toBox.appendChild(el("span", { class: "tc-pname dim" }, "宛先を選んでください"));

      const head = el("div", { class: "tc-head" },
        el("span", { class: "tc-motif", "aria-hidden": "true" }, design?.motif || "🎁"),
        el("div", { class: "tc-route" },
          el("span", { class: "tc-person from", title: from ? `${from.name}(${store.storeName(from.storeId)})` : "" },
            from ? avatar(from, 30) : null,
            el("span", { class: "tc-pname" }, from?.name || me.name)),
          el("span", { class: "tc-arrow", "aria-hidden": "true" }, icon("chevR", 15)),
          toBox),
        el("div", { class: "tc-meta" },
          el("span", { class: "tc-pts" }, `+${c.points || 0}pt`),
          el("span", {
            class: "tc-when",
            title: preview ? "" : `${fmtDate(String(c.date).slice(0, 10), { withYear: true })} ${String(c.date).slice(11, 16)}`,
          }, preview ? "たった今" : relTime(c.date)),
          c.visibility === "store" ? el("span", { class: "tc-vis", title: "自店舗のみに公開" }, icon("eye", 12), "自店舗") : null));

      if (c.pinned) head.appendChild(el("span", { class: "tc-pinflag" }, icon("pin", 12), "ピン留め"));
      art.appendChild(head);

      /* ---- 本文 ---- */
      const body = el("div", { class: "tc-body" });
      if (value) {
        body.appendChild(el("div", { class: "tc-valrow" },
          el("span", { class: "v-badge", style: cssVars({ "--vc": value.color }), title: value.desc },
            el("span", { class: "vb-e" }, value.emoji), value.label),
          el("span", { class: "tc-valdesc" }, value.desc)));
      } else if (preview) {
        body.appendChild(el("div", { class: "tc-valrow" },
          el("span", { class: "v-badge ghost" }, "バリューを選んでください")));
      }
      body.appendChild(el("p", { class: "tc-msg" }, c.message || (preview ? "ここにメッセージが入ります。" : "")));

      /* ---- メディア ---- */
      const media = c.media || [];
      if (media.length) {
        const n = Math.min(media.length, 4);
        const grid = el("div", { class: `tc-media n${n}` });
        media.slice(0, 4).forEach((m, idx) => {
          const isVideo = m.kind === "video";
          const tile = el("button", {
            class: `tm ${isVideo ? "video" : ""}`,
            "aria-label": `${m.caption || (isVideo ? "動画" : "写真")}を拡大`,
            onclick: (e) => { e.stopPropagation(); openLightbox(media, idx, from ? `${from.name} → ${tos.map((s) => s.name).join("、")}` : ""); },
          },
            el("img", { class: "tm-img", src: mediaUrl(m, { w: 800, h: 560 }), alt: m.caption || "" }),
            el("span", { class: "tm-shade" }),
            isVideo ? el("span", { class: "tm-play" }, icon("play", 20)) : null,
            isVideo ? el("span", { class: "tm-dur" }, icon("film", 12), fmtDuration(m.durationSec)) : null,
            m.caption ? el("span", { class: "tm-cap" }, m.caption) : null);
          grid.appendChild(tile);
        });
        if (media.length > 4) {
          grid.lastChild.appendChild(el("span", { class: "tm-more" }, `+${media.length - 4}`));
        }
        body.appendChild(grid);
      }

      /* ---- ブースト ---- */
      for (const b of c.boosts || []) {
        body.appendChild(el("div", { class: "tc-boost" },
          el("span", { class: "tb-ic", "aria-hidden": "true" }, "⚡"),
          el("span", { class: "tb-main" },
            el("span", { class: "tb-title" },
              el("strong", {}, nameOf(b.by)), "が ",
              el("span", { class: "tb-pts" }, `+${b.points}pt`), " ブースト"),
            b.comment ? el("span", { class: "tb-cmt" }, b.comment) : null)));
      }
      art.appendChild(body);

      if (preview) return art;

      /* ---- フッター(リアクション/コメント/ブースト) ---- */
      const foot = el("div", { class: "tc-foot" });
      const reactKeys = [...new Set([...REACTIONS, ...Object.keys(c.reactions || {})])];
      const reacts = el("div", { class: "tc-reacts" });
      for (const emoji of reactKeys) {
        const arr = (c.reactions || {})[emoji] || [];
        if (!arr.length) continue;
        const mine = arr.includes(meId);
        reacts.appendChild(el("button", {
          class: `rc ${mine ? "on" : ""}`,
          title: `${emoji} ${arr.map(nameOf).join("、")}`,
          onclick: () => { toggleReaction(c.id, emoji); refreshCard(c.id); },
        }, el("span", { class: "rc-e" }, emoji), el("span", { class: "rc-n" }, String(arr.length))));
      }

      const picker = el("div", { class: "tc-picker" },
        REACTIONS.map((e2) => el("button", {
          class: `pk ${((c.reactions || {})[e2] || []).includes(meId) ? "on" : ""}`,
          title: e2,
          onclick: (ev) => { ev.stopPropagation(); toggleReaction(c.id, e2); refreshCard(c.id); },
        }, e2)));
      const host = el("div", { class: "tc-react-host" },
        el("button", {
          class: "rc add",
          title: "リアクションする",
          onclick: (ev) => {
            ev.stopPropagation();
            const willOpen = !host.classList.contains("open");
            document.querySelectorAll(".tc-react-host.open").forEach((n) => n.classList.remove("open"));
            host.classList.toggle("open", willOpen);
          },
        }, icon("heart", 14), el("span", { class: "hide-mobile" }, "リアクション")),
        picker);
      reacts.appendChild(host);
      foot.appendChild(reacts);

      const nCom = (c.comments || []).length;
      const actions = el("div", { class: "tc-actions" },
        el("button", {
          class: `tc-act ${expanded.has(c.id) ? "on" : ""}`,
          onclick: () => { expanded.has(c.id) ? expanded.delete(c.id) : expanded.add(c.id); refreshCard(c.id); },
        }, icon("chat", 14), nCom ? `コメント ${nCom}` : "コメント"),
        canBoost && c.fromId !== meId
          ? el("button", { class: "tc-act boost", onclick: () => openBoost(c) }, el("span", {}, "⚡"), "ブースト")
          : null);
      foot.appendChild(actions);
      art.appendChild(foot);

      /* ---- コメント ---- */
      if (expanded.has(c.id)) {
        const list = el("div", { class: "tc-comments" });
        for (const cm of c.comments || []) {
          const a = store.byId("staff", cm.authorId);
          list.appendChild(el("div", { class: "tcm" },
            avatar(a, 28),
            el("div", { class: "tcm-bub" },
              el("div", { class: "tcm-head" },
                el("span", { class: "tcm-who" }, a?.name || "—"),
                el("span", { class: "tcm-time" }, relTime(cm.date))),
              el("div", { class: "tcm-body" }, cm.body))));
        }
        const input = el("input", { class: "input tcm-input", type: "text", placeholder: "あたたかい一言を添える…", maxlength: 140 });
        const send = () => {
          const v = input.value.trim();
          if (!v) return;
          addComment(c.id, v);
          refreshCard(c.id);
        };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });
        list.appendChild(el("div", { class: "tcm-form" },
          avatar(me, 28), input,
          el("button", { class: "btn primary sm", onclick: send, "aria-label": "コメントを送信" }, icon("send", 14))));
        art.appendChild(list);
      }

      if (boostPts > 0) art.classList.add("boosted");
      return art;
    }

    /** 1枚だけ描き直す(スクロール位置を保つ) */
    function refreshCard(cardId) {
      const fresh = store.byId("thanksCards", cardId);
      if (!fresh) return;
      const nodes = body.querySelectorAll(`[data-card-id="${cardId}"]`);
      nodes.forEach((n) => n.replaceWith(cardNode(fresh)));
    }

    /** コレクション用のミニカード */
    function miniCard(c, { role = "received" } = {}) {
      const design = designOf(c.designId);
      const value = valueOf(c.valueId);
      const other = role === "received" ? store.byId("staff", c.fromId)
        : store.byId("staff", (c.toIds || [])[0]);
      const extra = role === "sent" ? (c.toIds || []).length - 1 : 0;
      const pts = role === "received" ? pointsPerRecipient(c) : (c.points || 0) * ((c.toIds || []).length || 1);
      return el("button", {
        class: "tmini",
        style: designVars(design),
        onclick: () => openCardModal(c),
      },
        el("span", { class: "tmini-top" },
          el("span", { class: "tmini-motif", "aria-hidden": "true" }, design?.motif || "🎁"),
          el("span", { class: "tmini-who" },
            other ? avatar(other, 24) : null,
            el("span", {}, (other?.name || "—") + (extra > 0 ? ` 他${extra}名` : ""))),
          el("span", { class: "tmini-pts" }, `${role === "received" ? "+" : "-"}${pts}pt`)),
        el("span", { class: "tmini-msg" }, c.message),
        el("span", { class: "tmini-foot" },
          value ? el("span", { class: "tmini-val", style: cssVars({ "--vc": value.color }) }, value.emoji, value.label) : null,
          (c.media || []).length ? el("span", { class: "tmini-ic" }, icon("image", 12), String(c.media.length)) : null,
          el("span", { class: "tmini-date" }, fmtDate(String(c.date).slice(0, 10), { withDow: false }))));
    }

    function openCardModal(c) {
      modal({
        title: "サンクスカード",
        wide: true,
        body: el("div", { class: "page-thanks tc-modal" }, cardNode(store.byId("thanksCards", c.id) || c)),
      });
    }

    /* ---- ブースト ---- */
    function openBoost(c) {
      let pts = BOOST_OPTIONS[0];
      const opts = el("div", { class: "seg-row" });
      const draw = () => {
        clear(opts).append(...BOOST_OPTIONS.map((p) => el("button", {
          class: `pick ${p === pts ? "on" : ""}`,
          onclick: () => { pts = p; draw(); },
        }, `+${p}pt`)));
      };
      draw();
      const cmt = el("input", { class: "input", type: "text", placeholder: "ひとこと添える(任意)", maxlength: 60 });
      const ok = el("button", { class: "btn primary" }, "⚡ ブーストする");
      const m = modal({
        title: "このカードをブーストする",
        body: el("div", { class: "page-thanks stack", style: { gap: "14px" } },
          el("p", { class: "tk-lead" },
            `${nameOf(c.fromId)}さんの感謝に、上長として追加のポイントを贈ります。宛先のみなさんに均等に配分されます。`),
          el("div", { class: "field" }, el("label", {}, "ポイント"), opts),
          el("div", { class: "field" }, el("label", {}, "コメント"), cmt)),
        actions: [ok],
      });
      ok.addEventListener("click", () => {
        boostCard(c.id, pts, cmt.value.trim());
        m.close();
        refreshCard(c.id);
        toast(`+${pts}pt をブーストしました`, "success");
        confettiBurst(["#ffd66b", "#eda100", "#f8a423"]);
      });
    }

    /* ============================================================
       タブ1:フィード
       ============================================================ */

    function renderFeed(host) {
      /* ---- 自分の状況 ---- */
      const st = statsOf(meId);
      const rem = remainingPoints();
      const used = sentThisMonth();
      const streak = st.weekStreak;

      host.appendChild(el("section", { class: "card tk-me" },
        el("div", { class: "tkme-main" },
          el("div", { class: "tkme-lead" },
            el("span", { class: "tkme-label" }, "今月まだ贈れるポイント"),
            el("div", { class: "tkme-big" },
              el("span", { class: "tkme-num" }, String(rem)),
              el("span", { class: "tkme-unit" }, "pt")),
            el("div", { class: "tkme-meter" },
              meter({
                label: "今月の使用状況", value: used, max: MONTHLY_BUDGET,
                fmt: () => `${used} / ${MONTHLY_BUDGET}pt`,
                kind: rem <= 20 ? "warn" : "",
              })),
            el("div", { class: "tkme-note" },
              icon("info", 12),
              "毎月1日にリセットされます。使い切っても翌月また贈れます。")),
          el("div", { class: "tkme-side" },
            el("div", { class: "tkme-facts" },
              el("div", { class: "tkfact" },
                el("span", { class: "tkf-ic e" }, icon("medal", 16)),
                el("span", {}, el("span", { class: "tkf-v" }, String(st.earned)), el("span", { class: "tkf-l" }, "累計獲得pt"))),
              el("div", { class: "tkfact" },
                el("span", { class: "tkf-ic g" }, icon("gift", 16)),
                el("span", {}, el("span", { class: "tkf-v" }, String(st.balance)), el("span", { class: "tkf-l" }, "交換できる残高"))),
              el("div", { class: "tkfact" },
                el("span", { class: "tkf-ic f" }, "🔥"),
                el("span", {}, el("span", { class: "tkf-v" }, `${streak}週`), el("span", { class: "tkf-l" }, "連続で感謝を送信")))),
            el("div", { class: "tkme-cta" },
              el("button", { class: "btn primary lg", onclick: () => goTab("compose") }, icon("send", 16), "サンクスを送る"),
              el("button", { class: "btn ghost", onclick: () => location.hash = "#/rewards" }, icon("gift", 15), "ポイントを交換"))))));

      /* ---- 見落とされていない? ---- */
      const forgotten = notYetThanked().filter((s) => s.id !== meId);
      const fCard = el("section", { class: `card tk-forgot ${forgotten.length ? "" : "done"}` });
      if (forgotten.length) {
        fCard.append(
          el("div", { class: "tkf-head" },
            el("span", { class: "tkf-emoji", "aria-hidden": "true" }, "🫧"),
            el("div", {},
              el("h2", {}, `今月まだ感謝が届いていない仲間が ${forgotten.length}名 います`),
              el("p", {}, "がんばりは、見えていないだけかもしれません。ひとことで十分です。"))),
          el("div", { class: "tkf-people" },
            forgotten.map((s) => el("button", {
              class: "tkf-person",
              onclick: () => goTab("compose", s.id),
              title: `${s.name}さんにサンクスを送る`,
            },
              avatar(s, 34),
              el("span", { class: "tkfp-meta" },
                el("span", { class: "tkfp-name" }, s.name),
                el("span", { class: "tkfp-sub" }, `${store.storeName(s.storeId)}・${s.role}`)),
              el("span", { class: "tkfp-go" }, icon("send", 14))))));
      } else {
        fCard.append(el("div", { class: "tkf-head" },
          el("span", { class: "tkf-emoji", "aria-hidden": "true" }, "🎉"),
          el("div", {},
            el("h2", {}, "今月は全員が誰かに感謝されています"),
            el("p", {}, "ひとりも見落とされていません。この状態を来月も続けましょう。"))));
      }
      host.appendChild(fCard);

      /* ---- フィルタ ---- */
      const values = store.get("thanksValues") || [];
      const filterDefs = [
        { id: "all", label: "すべて" },
        { id: "to-me", label: "自分あて" },
        { id: "from-me", label: "自分が送った" },
        ...values.map((v) => ({ id: v.id, label: `${v.emoji} ${v.label}` })),
        { id: "media", label: "📷 写真・動画つき" },
      ];
      const bar = el("div", { class: "tk-filters" });
      const listWrap = el("div", { class: "tk-feed" });

      const matches = (c) => {
        if (feedFilter === "all") return true;
        if (feedFilter === "to-me") return (c.toIds || []).includes(meId);
        if (feedFilter === "from-me") return c.fromId === meId;
        if (feedFilter === "media") return (c.media || []).length > 0;
        return c.valueId === feedFilter;
      };

      function drawFilters() {
        clear(bar);
        for (const f of filterDefs) {
          const n = allCards().filter((c) => {
            const keep = feedFilter;
            feedFilter = f.id;
            const r = matches(c);
            feedFilter = keep;
            return r;
          }).length;
          bar.appendChild(el("button", {
            class: `chip ${feedFilter === f.id ? "on" : ""}`,
            onclick: () => { feedFilter = f.id; drawFilters(); drawList(); },
          }, f.label, el("span", { class: "chip-n" }, String(n))));
        }
      }

      function drawList() {
        clear(listWrap);
        const list = sortedCards().filter(matches);
        if (!list.length) {
          listWrap.appendChild(el("div", { class: "card" }, emptyState({
            icon: "💌", title: "該当するサンクスカードがありません",
            hint: "フィルタを変えるか、あなたから最初の1枚を贈ってみましょう",
          })));
          return;
        }
        list.forEach((c) => listWrap.appendChild(cardNode(c)));
      }

      drawFilters();
      drawList();
      host.append(
        el("div", { class: "tk-feedhead" },
          el("h2", { class: "tk-h2" }, icon("heart", 17), "みんなの感謝"),
          el("span", { class: "tk-h2sub" }, "新しい順・ピン留めが先頭")),
        bar, listWrap);
    }

    /* ============================================================
       タブ2:送る
       ============================================================ */

    function renderCompose(host) {
      const values = store.get("thanksValues") || [];
      const designs = store.get("cardDesigns") || [];
      if (!draft.valueId) draft.valueId = null;

      const formCol = el("div", { class: "cmp-form" });
      const prevCol = el("aside", { class: "cmp-preview" });
      host.appendChild(el("div", { class: "cmp-grid" }, formCol, prevCol));

      /* ---------- プレビュー ---------- */
      const prevBox = el("div", { class: "cmp-prevbox" });
      const costLine = el("div", { class: "cmp-cost" });
      const sendBtn = el("button", { class: "btn primary lg block" }, icon("send", 17), "サンクスカードを送る");

      function drawPreview() {
        clear(prevBox).appendChild(cardNode({
          id: "preview", fromId: meId, toIds: draft.toIds, points: draft.points,
          valueId: draft.valueId, designId: draft.designId, date: new Date().toISOString(),
          message: draft.message, media: draft.media, reactions: {}, comments: [], boosts: [],
          pinned: false, visibility: draft.visibility,
        }, { preview: true }));

        const cost = draft.points * draft.toIds.length;
        const rem = remainingPoints();
        const over = cost > rem;
        clear(costLine);
        costLine.classList.toggle("over", over);
        costLine.appendChild(el("div", { class: "cc-row" },
          el("span", {}, `${draft.toIds.length || 0}名 × ${draft.points}pt`),
          el("strong", {}, `${cost}pt`)));
        costLine.appendChild(el("div", { class: "cc-row sub" },
          el("span", {}, "送信後の残ポイント"),
          el("strong", {}, `${Math.max(0, rem - cost)}pt / ${MONTHLY_BUDGET}pt`)));
        if (over) {
          costLine.appendChild(el("div", { class: "cc-warn" }, icon("alert", 13),
            `今月の残りポイントが足りません(必要 ${cost}pt / 残り ${rem}pt)。宛先かポイントを見直してください。`));
        }
        const missing = [];
        if (!draft.toIds.length) missing.push("宛先");
        if (!draft.valueId) missing.push("バリュー");
        if (!draft.message.trim()) missing.push("メッセージ");
        sendBtn.disabled = over || missing.length > 0;
        clear(needHint);
        if (missing.length && !over) {
          needHint.appendChild(el("span", {}, icon("info", 12), `あと ${missing.join("・")} を入力すると送信できます`));
        }
      }

      const needHint = el("div", { class: "cmp-need" });
      prevCol.append(
        el("div", { class: "cmp-prevhead" },
          el("span", { class: "cph-t" }, icon("eye", 15), "受け取る人に見える形"),
          el("span", { class: "cph-s" }, "入力するとその場で反映されます")),
        prevBox,
        el("div", { class: "cmp-send" }, costLine, sendBtn, needHint));

      /* ---------- 1. 宛先 ---------- */
      const chosen = el("div", { class: "cmp-chosen" });
      const grid = el("div", { class: "cmp-staffgrid" });
      const search = el("input", {
        class: "input", type: "search", placeholder: "名前・店舗で絞り込む",
        oninput: (e) => { draft.query = e.target.value; drawStaff(); },
      });
      const scopeBox = el("div", { class: "cmp-scope" });

      function drawScope() {
        clear(scopeBox).appendChild(segmented([
          { id: "store", label: "同じ店舗のみ" },
          { id: "all", label: "全店から" },
        ], draft.scope, (id) => { draft.scope = id; drawScope(); drawStaff(); }));
      }

      function drawChosen() {
        clear(chosen);
        if (!draft.toIds.length) {
          chosen.appendChild(el("span", { class: "cmp-empty" }, "まだ選ばれていません。感謝を伝えたい人を選んでください。"));
          return;
        }
        for (const id of draft.toIds) {
          const s = store.byId("staff", id);
          if (!s) continue;
          chosen.appendChild(el("span", { class: "cmp-tag" },
            avatar(s, 22), s.name,
            el("button", {
              class: "cmp-tagx", "aria-label": `${s.name}を外す`,
              onclick: () => { draft.toIds = draft.toIds.filter((x) => x !== id); drawChosen(); drawStaff(); drawHints(); drawPreview(); },
            }, icon("x", 12))));
        }
      }

      function drawStaff() {
        clear(grid);
        const q = draft.query.trim();
        const list = store.get("staff")
          .filter((s) => s.id !== meId)
          .filter((s) => draft.scope === "all" || s.storeId === me.storeId)
          .filter((s) => !q || s.name.includes(q) || s.kana.includes(q) || store.storeName(s.storeId).includes(q) || s.role.includes(q));
        if (!list.length) {
          grid.appendChild(el("span", { class: "cmp-empty" }, "該当する仲間が見つかりません。"));
          return;
        }
        for (const s of list) {
          const on = draft.toIds.includes(s.id);
          grid.appendChild(el("button", {
            class: `cmp-sp ${on ? "on" : ""}`,
            onclick: () => {
              if (on) draft.toIds = draft.toIds.filter((x) => x !== s.id);
              else draft.toIds = [...draft.toIds, s.id];
              drawChosen(); drawStaff(); drawHints(); drawPreview();
            },
          },
            avatar(s, 30),
            el("span", { class: "cmp-spm" },
              el("span", { class: "cmp-spn" }, s.name),
              el("span", { class: "cmp-sps" }, `${store.storeName(s.storeId)}・${s.role}`)),
            on ? el("span", { class: "cmp-spc" }, icon("check", 13)) : null));
        }
      }

      drawScope();
      formCol.appendChild(el("section", { class: "card cmp-step" },
        stepHead(1, "誰に贈りますか?", "複数人まとめて贈れます"),
        chosen,
        el("div", { class: "cmp-searchrow" }, search, scopeBox),
        grid));

      /* ---------- 2. バリュー ---------- */
      const valGrid = el("div", { class: "cmp-values" });
      function drawValues() {
        clear(valGrid);
        for (const v of values) {
          valGrid.appendChild(el("button", {
            class: `cmp-val ${draft.valueId === v.id ? "on" : ""}`,
            style: cssVars({ "--vc": v.color }),
            onclick: () => { draft.valueId = v.id; drawValues(); drawHints(); drawPreview(); },
          },
            el("span", { class: "cv-e" }, v.emoji),
            el("span", { class: "cv-m" },
              el("span", { class: "cv-l" }, v.label),
              el("span", { class: "cv-d" }, v.desc))));
        }
      }
      drawValues();
      formCol.appendChild(el("section", { class: "card cmp-step" },
        stepHead(2, "どのバリューへの感謝ですか?", "何を称えたのかが記録に残ります(必須)"),
        valGrid));

      /* ---------- 3. ポイント ---------- */
      const ptRow = el("div", { class: "seg-row" });
      function drawPoints() {
        clear(ptRow);
        for (const p of POINT_OPTIONS) {
          ptRow.appendChild(el("button", {
            class: `pick ${draft.points === p ? "on" : ""}`,
            onclick: () => { draft.points = p; drawPoints(); drawPreview(); },
          }, `${p}pt`));
        }
      }
      drawPoints();
      formCol.appendChild(el("section", { class: "card cmp-step" },
        stepHead(3, "何ポイント贈りますか?", `今月の残り ${remainingPoints()}pt(1人あたりの金額です)`),
        ptRow));

      /* ---------- 4. デザイン ---------- */
      const dsGrid = el("div", { class: "cmp-designs" });
      function drawDesigns() {
        clear(dsGrid);
        for (const d of designs) {
          dsGrid.appendChild(el("button", {
            class: `cmp-ds ${draft.designId === d.id ? "on" : ""}`,
            style: designVars(d),
            title: d.name,
            onclick: () => { draft.designId = d.id; drawDesigns(); drawPreview(); },
          },
            el("span", { class: "cds-sw" }, el("span", { class: "cds-motif" }, d.motif)),
            el("span", { class: "cds-n" }, d.name)));
        }
      }
      drawDesigns();
      formCol.appendChild(el("section", { class: "card cmp-step" },
        stepHead(4, "台紙を選ぶ", "受け取った人の画面にそのまま表示されます"),
        dsGrid));

      /* ---------- 5. メッセージ ---------- */
      const ta = el("textarea", {
        class: "textarea cmp-ta", maxlength: MAX_MSG,
        placeholder: "具体的な場面が入っていると、何倍も嬉しく届きます。\n例:予約が重なってバタバタしていた時、受付とお会計を完璧に回してくれてありがとうございました!",
        oninput: (e) => { draft.message = e.target.value; drawCount(); drawPreview(); },
      });
      const counter = el("span", { class: "cmp-count" });
      const hints = el("div", { class: "cmp-hints" });
      function drawCount() {
        const n = draft.message.length;
        counter.textContent = `${n} / ${MAX_MSG}`;
        counter.classList.toggle("near", n > MAX_MSG - 40);
      }
      function drawHints() {
        clear(hints);
        const to = store.byId("staff", draft.toIds[0]);
        const v = valueOf(draft.valueId);
        const list = messageHints(to, v).map((h) => (to ? h : h.replace(/^さん[、,]?\s*/, "")));
        hints.append(el("span", { class: "cmp-hintlab" }, icon("sparkle", 13), "書き出しのヒント"));
        for (const h of list) {
          hints.appendChild(el("button", {
            class: "cmp-hint",
            onclick: () => {
              draft.message = (draft.message ? draft.message.replace(/\s*$/, "") + "\n" : "") + h;
              ta.value = draft.message;
              ta.focus();
              drawCount(); drawPreview();
            },
          }, h));
        }
      }
      drawCount(); drawHints();
      formCol.appendChild(el("section", { class: "card cmp-step" },
        stepHead(5, "メッセージ", "1〜3文で十分です"),
        hints, ta,
        el("div", { class: "cmp-tafoot" }, counter)));

      /* ---------- 6. 写真・動画 ---------- */
      const mediaList = el("div", { class: "cmp-medias" });
      function drawMedia() {
        clear(mediaList);
        if (!draft.media.length) {
          mediaList.appendChild(el("span", { class: "cmp-empty" }, "写真や動画があると、その瞬間ごと共有できます(最大4件)。"));
          return;
        }
        draft.media.forEach((m, i) => {
          mediaList.appendChild(el("div", { class: "cmp-mi" },
            el("img", { class: "cmi-img", src: mediaUrl(m, { w: 400, h: 300 }), alt: "" }),
            m.kind === "video" ? el("span", { class: "cmi-v" }, icon("play", 12), fmtDuration(m.durationSec)) : null,
            el("input", {
              class: "input cmi-cap", type: "text", value: m.caption || "", maxlength: 30,
              placeholder: "キャプション",
              oninput: (e) => { draft.media[i].caption = e.target.value; drawPreview(); },
            }),
            el("button", {
              class: "cmi-x", "aria-label": "この添付を外す",
              onclick: () => { draft.media.splice(i, 1); drawMedia(); drawPreview(); },
            }, icon("x", 13))));
        });
      }
      drawMedia();

      function openMediaPicker(kind) {
        if (draft.media.length >= MAX_MEDIA) { toast(`添付は最大${MAX_MEDIA}件までです`, "error"); return; }
        const picked = new Set();
        const gridEl = el("div", { class: "mp-grid" });
        const items = SAMPLE_MEDIA.filter((m) => m.kind === kind);
        const okBtn = el("button", { class: "btn primary", disabled: true }, "添付する");
        const sync = () => {
          okBtn.disabled = picked.size === 0;
          clear(okBtn).append(picked.size ? `${picked.size}件を添付する` : "添付する");
        };
        items.forEach((m, idx) => {
          const t = el("button", {
            class: "mp-item",
            onclick: () => {
              if (picked.has(idx)) picked.delete(idx);
              else if (picked.size + draft.media.length >= MAX_MEDIA) { toast(`添付は最大${MAX_MEDIA}件までです`, "error"); return; }
              else picked.add(idx);
              t.classList.toggle("on", picked.has(idx));
              sync();
            },
          },
            el("img", { class: "mp-img", src: mediaUrl(m, { w: 480, h: 340 }), alt: "" }),
            kind === "video" ? el("span", { class: "mp-play" }, icon("play", 16)) : null,
            kind === "video" ? el("span", { class: "mp-dur" }, fmtDuration(m.durationSec)) : null,
            el("span", { class: "mp-cap" }, m.caption),
            el("span", { class: "mp-check" }, icon("check", 13)));
          gridEl.appendChild(t);
        });
        const m2 = modal({
          title: kind === "video" ? "動画を選ぶ" : "写真を選ぶ",
          wide: true,
          body: el("div", { class: "page-thanks" },
            el("p", { class: "tk-lead" }, "複数選べます。タップで選択・解除できます。"),
            gridEl,
            el("div", { class: "tk-devnote" }, icon("info", 13),
              "実運用では端末のカメラ・アルバムから選択できます。ここではデモ用のサンプルを表示しています。")),
          actions: [okBtn],
        });
        okBtn.addEventListener("click", () => {
          [...picked].sort((a, b) => a - b).forEach((i) => {
            const src = items[i];
            draft.media.push({ id: store.uid("m"), kind: src.kind, seed: src.seed, caption: src.caption, durationSec: src.durationSec });
          });
          m2.close();
          drawMedia(); drawPreview();
        });
      }

      formCol.appendChild(el("section", { class: "card cmp-step" },
        stepHead(6, "写真・動画を添える", "任意・最大4件"),
        el("div", { class: "cmp-mbtns" },
          el("button", { class: "btn ghost", onclick: () => openMediaPicker("photo") }, icon("camera", 16), "写真を選ぶ"),
          el("button", { class: "btn ghost", onclick: () => openMediaPicker("video") }, icon("film", 16), "動画を選ぶ")),
        mediaList,
        el("div", { class: "tk-devnote" }, icon("info", 13),
          "実運用では端末のカメラ・アルバムから選択できます。")));

      /* ---------- 7. 公開範囲 ---------- */
      const visBox = el("div", {});
      function drawVis() {
        clear(visBox).appendChild(segmented([
          { id: "all", label: "全社に公開" },
          { id: "store", label: "自店舗のみ" },
        ], draft.visibility, (id) => { draft.visibility = id; drawVis(); drawPreview(); }));
      }
      drawVis();
      formCol.appendChild(el("section", { class: "card cmp-step" },
        stepHead(7, "公開範囲", "全社に公開すると他店舗の仲間にも届きます"),
        visBox));

      /* ---------- 送信 ---------- */
      sendBtn.addEventListener("click", () => {
        const res = sendCard({
          toIds: draft.toIds, points: draft.points, valueId: draft.valueId,
          designId: draft.designId, message: draft.message, media: draft.media,
          visibility: draft.visibility,
        });
        if (res?.error) { toast(res.error, "error"); return; }
        const names = draft.toIds.map((id) => firstNameOf(id)).join("・");
        const d = designOf(draft.designId);
        confettiBurst([...(d?.grad || []), valueOf(draft.valueId)?.color].filter(Boolean));
        celebrate(`${names}さんにサンクスカードを届けました!`);
        draft.toIds = []; draft.valueId = null; draft.message = ""; draft.media = [];
        draft.points = 30; draft.visibility = "all"; draft.query = "";
        goTab("feed");
      });

      drawChosen(); drawStaff(); drawPreview();
    }

    function stepHead(n, title, sub) {
      return el("div", { class: "cmp-head" },
        el("span", { class: "cmp-n" }, String(n)),
        el("div", {},
          el("h3", {}, title),
          sub ? el("p", {}, sub) : null));
    }

    /* ============================================================
       タブ3:もらったカード
       ============================================================ */

    function renderMine(host) {
      const st = statsOf(meId);
      const cards = allCards();
      const received = sortedCards(cards.filter((c) => (c.toIds || []).includes(meId)));
      const sent = sortedCards(cards.filter((c) => c.fromId === meId));

      host.appendChild(el("div", { class: "kpi-row" },
        statTile({ label: "累計獲得ポイント", value: `${st.earned}pt`, icon: "medal", tone: "brand", sub: `交換できる残高 ${st.balance}pt` }),
        statTile({ label: "もらったカード", value: `${st.received}枚`, icon: "heart", tone: "accent", sub: "あなたへの感謝の記録" }),
        statTile({ label: "送ったカード", value: `${st.sent}枚`, icon: "send", tone: "good", sub: `うち写真・動画つき ${st.withMedia}枚` }),
        statTile({ label: "連続送信", value: `${st.weekStreak}週`, icon: "star", tone: "violet", sub: "毎週だれかに感謝を届けています" })));

      /* ---- 強みの内訳 ---- */
      const values = store.get("thanksValues") || [];
      const byValue = values.map((v) => ({
        ...v, n: received.filter((c) => c.valueId === v.id).length,
      })).sort((a, b) => b.n - a.n);
      const maxV = Math.max(1, ...byValue.map((b) => b.n));

      const givers = new Map();
      for (const c of received) {
        const cur = givers.get(c.fromId) || { id: c.fromId, n: 0, pts: 0 };
        cur.n += 1; cur.pts += pointsPerRecipient(c);
        givers.set(c.fromId, cur);
      }
      const giverList = [...givers.values()].sort((a, b) => b.n - a.n || b.pts - a.pts).slice(0, 6);
      const maxG = Math.max(1, ...giverList.map((g) => g.n));

      host.appendChild(el("div", { class: "grid cols-2 tk-gap" },
        el("section", { class: "card" },
          el("div", { class: "card-title" }, "どのバリューで称えられているか",
            el("span", { class: "card-sub" }, "あなたの強み")),
          received.length
            ? el("div", { class: "hbars" }, byValue.map((b) => el("div", { class: "hbar", style: cssVars({ "--vc": b.color }) },
              el("span", { class: "hb-l" }, el("span", { class: "hb-e" }, b.emoji), b.label),
              el("span", { class: "hb-track" }, el("span", { class: "hb-fill", style: { width: (b.n / maxV) * 100 + "%" } })),
              el("span", { class: "hb-v" }, `${b.n}枚`))))
            : emptyState({ icon: "🌱", title: "まだカードを受け取っていません", hint: "感謝は巡ります。まずはあなたから贈ってみましょう" })),
        el("section", { class: "card" },
          el("div", { class: "card-title" }, "よく感謝をくれる仲間",
            el("span", { class: "card-sub" }, "上位6名")),
          giverList.length
            ? el("div", { class: "tk-givers" }, giverList.map((g) => {
              const s = store.byId("staff", g.id);
              return el("div", { class: "tkg-row" },
                avatar(s, 32),
                el("span", { class: "tkg-m" },
                  el("span", { class: "tkg-n" }, s?.name || "—"),
                  el("span", { class: "tkg-track" }, el("span", { class: "tkg-fill", style: { width: (g.n / maxG) * 100 + "%", background: s?.color || "var(--brand)" } }))),
                el("span", { class: "tkg-v" }, `${g.n}枚 / ${g.pts}pt`));
            }))
            : emptyState({ icon: "💌", title: "まだ記録がありません" }))));

      /* ---- コレクション ---- */
      host.appendChild(el("section", { class: "card" },
        el("div", { class: "card-title" },
          el("span", {}, "もらったカードのコレクション",
            el("span", { class: "card-sub" }, `${received.length}枚・クリックで拡大`))),
        received.length
          ? el("div", { class: "tk-collection" }, received.map((c) => miniCard(c, { role: "received" })))
          : emptyState({ icon: "💐", title: "まだ1枚も届いていません", hint: "あなたが贈った感謝は、きっと返ってきます" })));

      /* ---- バッジ ---- */
      const badges = badgeProgress(meId);
      const earnedB = badges.filter((b) => b.earned);
      host.appendChild(el("section", { class: "card" },
        el("div", { class: "card-title" },
          el("span", {}, "獲得バッジ", el("span", { class: "card-sub" }, `${earnedB.length} / ${badges.length}`))),
        el("div", { class: "tk-badges" }, badges.map((b) => el("div", {
          class: `tkb ${b.earned ? "on" : ""} tier-${b.tier}`,
          title: `${b.desc}(${b.current} / ${b.threshold})`,
        },
          el("span", { class: "tkb-e" }, b.emoji),
          el("span", { class: "tkb-m" },
            el("span", { class: "tkb-n" }, b.name),
            el("span", { class: "tkb-track" }, el("span", { class: "tkb-fill", style: { width: b.pct + "%" } })),
            el("span", { class: "tkb-s" }, b.earned ? "獲得済み" : `${b.current} / ${b.threshold}`)))))));

      /* ---- 送ったカード ---- */
      host.appendChild(el("section", { class: "card" },
        el("div", { class: "card-title" },
          el("span", {}, "あなたが送ったカード", el("span", { class: "card-sub" }, `${sent.length}枚`)),
          el("button", { class: "btn soft sm", onclick: () => goTab("compose") }, icon("plus", 14), "新しく送る")),
        sent.length
          ? el("div", { class: "tk-collection" }, sent.map((c) => miniCard(c, { role: "sent" })))
          : emptyState({ icon: "✉️", title: "まだ送っていません", hint: "「送る」タブから最初の1枚を贈りましょう" })));
    }

    /* ============================================================
       タブ4:ランキング
       ============================================================ */

    function renderRank(host) {
      const thisMonth = monthOf(todayStr());
      const prevMonth = shiftMonth(thisMonth, -1);
      const monthBox = el("div", {});
      const inner = el("div", { class: "tk-rankbody" });

      function drawMonth() {
        clear(monthBox).appendChild(segmented([
          { id: prevMonth, label: monthLabel(prevMonth) },
          { id: thisMonth, label: `${monthLabel(thisMonth)}(今月)` },
        ], rankMonth, (id) => { rankMonth = id; drawMonth(); drawRank(); }));
      }

      function drawRank() {
        clear(inner);
        const recv = ranking({ month: rankMonth, limit: 10 });
        const give = giverRanking({ month: rankMonth, limit: 10 });
        const vb = valueBreakdown(rankMonth);
        const { stores: sts, mat } = storeMatrix(rankMonth);
        const medals = ["🥇", "🥈", "🥉"];

        /* --- MVP --- */
        if (recv.length) {
          const top = recv[0];
          const s = store.byId("staff", top.staffId);
          inner.appendChild(el("section", { class: "card tk-mvp" },
            el("span", { class: "mvp-glow", "aria-hidden": "true" }),
            el("div", { class: "mvp-in" },
              el("span", { class: "mvp-medal", "aria-hidden": "true" }, "🥇"),
              el("div", { class: "mvp-who" },
                avatar(s, 76),
                el("div", {},
                  el("span", { class: "mvp-lab" }, `${monthLabel(rankMonth)} 月間MVP`),
                  el("span", { class: "mvp-name" }, s?.name || "—"),
                  el("span", { class: "mvp-sub" }, s ? `${store.storeName(s.storeId)}・${s.role}` : ""))),
              el("div", { class: "mvp-nums" },
                el("div", {}, el("span", { class: "mvpn-v" }, `${top.points}`), el("span", { class: "mvpn-l" }, "獲得pt")),
                el("div", {}, el("span", { class: "mvpn-v" }, `${top.count}`), el("span", { class: "mvpn-l" }, "枚のカード"))),
              el("p", { class: "mvp-msg" }, "たくさんの「ありがとう」が集まりました。おめでとうございます!"))));
        }

        inner.appendChild(el("div", { class: "grid cols-2 tk-gap" },
          /* --- 受け取りランキング --- */
          el("section", { class: "card" },
            el("div", { class: "card-title" },
              el("span", { class: "tk-ct" }, icon("medal", 16), "もらったポイント TOP10"),
              el("span", { class: "card-sub" }, monthLabel(rankMonth))),
            recv.length ? el("div", { class: "rk-list" }, recv.map((r, i) => {
              const s = store.byId("staff", r.staffId);
              const max = recv[0].points || 1;
              return el("div", { class: `rk-row ${r.staffId === meId ? "me" : ""} ${i < 3 ? "top" : ""}` },
                el("span", { class: "rk-rank" }, medals[i] || String(i + 1)),
                avatar(s, 32),
                el("span", { class: "rk-m" },
                  el("span", { class: "rk-n" }, s?.name || "—", r.staffId === meId ? el("span", { class: "rk-you" }, "あなた") : null),
                  el("span", { class: "rk-track" }, el("span", { class: "rk-fill", style: { width: (r.points / max) * 100 + "%" } }))),
                el("span", { class: "rk-v" }, `${r.points}pt`, el("span", { class: "rk-c" }, `${r.count}枚`)));
            })) : emptyState({ icon: "📭", title: "この月のデータはありません" })),
          /* --- 送った枚数ランキング --- */
          el("section", { class: "card tk-giver" },
            el("div", { class: "card-title" },
              el("span", { class: "tk-ct" }, icon("send", 16), "感謝を届けた人 TOP10"),
              el("span", { class: "card-sub" }, monthLabel(rankMonth))),
            el("p", { class: "tk-lead" }, "感謝は、送る人にもいちばん返ってきます。よく見て、よく伝えてくれた仲間です。"),
            give.length ? el("div", { class: "rk-list" }, give.map((r, i) => {
              const s = store.byId("staff", r.staffId);
              const max = give[0].count || 1;
              return el("div", { class: `rk-row alt ${r.staffId === meId ? "me" : ""} ${i < 3 ? "top" : ""}` },
                el("span", { class: "rk-rank" }, medals[i] || String(i + 1)),
                avatar(s, 32),
                el("span", { class: "rk-m" },
                  el("span", { class: "rk-n" }, s?.name || "—", r.staffId === meId ? el("span", { class: "rk-you" }, "あなた") : null),
                  el("span", { class: "rk-track" }, el("span", { class: "rk-fill", style: { width: (r.count / max) * 100 + "%" } }))),
                el("span", { class: "rk-v" }, `${r.count}枚`, el("span", { class: "rk-c" }, `${r.points}pt`)));
            })) : emptyState({ icon: "📭", title: "この月のデータはありません" }))));

        /* --- バリュー別 --- */
        const maxVb = Math.max(1, ...vb.map((v) => v.count));
        const totalVb = vb.reduce((a, v) => a + v.count, 0);
        inner.appendChild(el("section", { class: "card" },
          el("div", { class: "card-title" },
            el("span", {}, "何が称えられた月か", el("span", { class: "card-sub" }, `全${totalVb}枚のバリュー内訳`))),
          el("div", { class: "hbars" }, vb.map((v) => el("div", { class: "hbar", style: cssVars({ "--vc": v.color }) },
            el("span", { class: "hb-l" }, el("span", { class: "hb-e" }, v.emoji), v.label),
            el("span", { class: "hb-track" }, el("span", { class: "hb-fill", style: { width: (v.count / maxVb) * 100 + "%" } })),
            el("span", { class: "hb-v" }, `${v.count}枚`))))));

        /* --- 店舗マトリクス --- */
        const maxM = Math.max(1, ...mat.flat());
        const tbl = el("table", { class: "tk-matrix" },
          el("thead", {}, el("tr", {},
            el("th", { class: "corner" }, el("span", {}, "送り主 ↓ / 宛先 →")),
            sts.map((s) => el("th", {}, s.short)))),
          el("tbody", {}, sts.map((rs, ri) => el("tr", {},
            el("th", { class: "rowh" }, rs.short),
            sts.map((cs, ci) => {
              const v = mat[ri][ci];
              return el("td", {
                class: `mx ${v ? "has" : ""}`,
                title: `${rs.name} → ${cs.name}:${v}枚`,
                style: v ? cssVars({ "--a": (0.14 + (v / maxM) * 0.72).toFixed(2) }) : null,
              }, v ? String(v) : "");
            })))));
        inner.appendChild(el("section", { class: "card" },
          el("div", { class: "card-title" },
            el("span", {}, "店舗どうしの送り合い", el("span", { class: "card-sub" }, "色が濃いほど多く贈られています"))),
          el("div", { class: "tk-mxwrap" }, tbl),
          el("p", { class: "tk-lead mt-12" }, "対角線(自店舗内)だけが濃い月は、店舗をまたいだ交流が少ないサインです。")));
      }

      drawMonth();
      host.append(el("div", { class: "tk-rankhead" },
        el("div", {},
          el("h2", { class: "tk-h2" }, icon("award", 17), "今月の称え合い"),
          el("span", { class: "tk-h2sub" }, "順位は毎月リセットされます")),
        monthBox), inner);
      drawRank();
    }

    /* ============================================================
       シェル
       ============================================================ */

    root.appendChild(sectionHeader(
      "サンクスギフト",
      "日々の「ありがとう」をカードにして贈り合い、ポイントとして残していく場所です。",
      el("button", { class: "btn primary", onclick: () => goTab("compose") }, icon("gift", 16), "サンクスを送る")));

    const tabBar = el("div", {});
    const body = el("div", { class: "tk-tabbody" });
    root.append(tabBar, body);

    function drawTabs() {
      const monthCards = allCards().filter((c) => String(c.date).startsWith(monthOf(todayStr()))).length;
      const myReceived = allCards().filter((c) => (c.toIds || []).includes(meId)).length;
      clear(tabBar).appendChild(tabs([
        { id: "feed", label: "フィード", badge: monthCards },
        { id: "compose", label: "送る" },
        { id: "mine", label: "もらったカード", badge: myReceived },
        { id: "rank", label: "ランキング" },
      ], activeTab, (id) => { activeTab = id; drawTabs(); drawBody(); }));
    }

    function goTab(id, preselectStaffId) {
      activeTab = id;
      if (preselectStaffId && !draft.toIds.includes(preselectStaffId)) {
        draft.toIds = [...draft.toIds, preselectStaffId];
        const s = store.byId("staff", preselectStaffId);
        if (s && s.storeId !== me.storeId) draft.scope = "all";
      }
      drawTabs(); drawBody();
      window.scrollTo({ top: 0, behavior: "smooth" });
      document.getElementById("outlet")?.scrollTo?.({ top: 0 });
    }

    function drawBody() {
      clear(body);
      if (activeTab === "feed") renderFeed(body);
      else if (activeTab === "compose") renderCompose(body);
      else if (activeTab === "mine") renderMine(body);
      else renderRank(body);
    }

    // ピッカーの外側クリックで閉じる
    const onDocClick = () => document.querySelectorAll(".tc-react-host.open").forEach((n) => n.classList.remove("open"));
    document.addEventListener("click", onDocClick);

    drawTabs();
    drawBody();
  },
};
