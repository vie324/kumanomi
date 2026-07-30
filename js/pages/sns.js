/* ============================================================
   社内SNS — サンクスギフト + 社内タイムライン(TUNAG代替)
   感謝を送り合う文化と連絡事項を1箇所に。
   ============================================================ */
import {
  el, clear, icon, avatar, badge, kv, meter, card, sectionHeader,
  tabs, segmented, statTile, emptyState, modal, toast, relTime, fmtNum,
} from "../ui.js";
import { store, todayStr, monthOf } from "../store.js";

const MONTHLY_BUDGET = 200; // 月の持ちポイント(FAQ準拠)
const PT_OPTIONS = [10, 20, 30];

const TYPE_META = {
  notice: { label: "連絡", emoji: "📣", kind: "brand" },
  chourei: { label: "朝礼", emoji: "🌅", kind: "accent" },
  philosophy: { label: "理念", emoji: "🧭", kind: "brand" },
  committee: { label: "委員会", emoji: "🗂", kind: "" },
  thanks: { label: "サンクス", emoji: "🎁", kind: "accent" },
};

function nowIso() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${todayStr()}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function byDateDesc(a, b) { return a.date < b.date ? 1 : -1; }

/** 今月自分が送ったサンクスポイント合計 */
function sentThisMonth() {
  const meId = store.me().id;
  const m = monthOf(todayStr());
  return store.get("posts")
    .filter((p) => p.type === "thanks" && p.authorId === meId && (p.date || "").startsWith(m))
    .reduce((a, p) => a + (p.points || 0), 0);
}

function myRank() {
  const sorted = [...store.get("staff")].sort((a, b) => (b.points || 0) - (a.points || 0));
  return sorted.findIndex((s) => s.id === store.me().id) + 1;
}

export default {
  id: "sns",
  title: "社内SNS",
  icon: "chat",

  render(root) {
    /* ---- ページ内状態(再描画をまたいで保持) ---- */
    let tab = "timeline";
    let activeChannel = null;
    let composerType = "notice";
    let composerDraft = "";
    const expanded = new Set();       // コメント展開中の投稿ID
    const commentDrafts = new Map();  // 投稿ID → 下書き

    /* ================= 描画ルート ================= */
    function draw() {
      clear(root);
      root.appendChild(sectionHeader(
        "社内SNS",
        "感謝を送り合う文化と連絡事項を、ここ1箇所に。",
        [el("button", { class: "btn accent", onclick: openThanksModal }, icon("gift", 17), "サンクスを送る")],
      ));

      const main = el("div", { class: "sns-main" });
      const side = el("aside", { class: "sns-side" }, pointsCard(), philosophyCard());
      root.appendChild(el("div", { class: "sns-layout" }, main, side));

      const posts = store.get("posts");
      main.appendChild(tabs([
        { id: "timeline", label: "タイムライン", badge: posts.length },
        { id: "thanks", label: "サンクス", badge: posts.filter((p) => p.type === "thanks").length },
        { id: "channels", label: "チャンネル" },
        { id: "ranking", label: "ランキング" },
      ], tab, (id) => { tab = id; draw(); }));

      if (tab === "timeline") drawTimeline(main);
      else if (tab === "thanks") drawThanks(main);
      else if (tab === "channels") drawChannels(main);
      else drawRanking(main);
    }

    /* ================= タイムライン ================= */
    function drawTimeline(main) {
      main.appendChild(composer());
      const list = el("div", { class: "post-list" });
      const posts = [...store.get("posts")].sort((a, b) =>
        (b.pinned === true) - (a.pinned === true) || byDateDesc(a, b));
      if (!posts.length) {
        list.appendChild(el("div", { class: "card" },
          emptyState({ icon: "💬", title: "まだ投稿がありません", hint: "最初の共有を書いてみましょう" })));
      } else {
        posts.forEach((p) => list.appendChild(postCard(p)));
      }
      main.appendChild(list);
    }

    /* ---- 投稿フォーム ---- */
    function composer() {
      const me = store.me();
      const ta = el("textarea", {
        class: "textarea composer-input", rows: 2,
        placeholder: "いま共有したいことはありますか?(全体連絡に投稿されます)",
        oninput: (e) => { composerDraft = e.target.value; },
      });
      ta.value = composerDraft;

      const segWrap = el("div", { class: "composer-seg" });
      const buildSeg = () => segmented(
        [{ id: "notice", label: "📣 連絡" }, { id: "chourei", label: "🌅 朝礼メモ" }],
        composerType,
        (id) => { composerType = id; clear(segWrap).appendChild(buildSeg()); },
      );
      segWrap.appendChild(buildSeg());

      const submit = () => {
        const body = composerDraft.trim();
        if (!body) { toast("共有する内容を入力してください", "error"); return; }
        store.addFirst("posts", {
          type: composerType,
          channelId: "ch-all",
          authorId: me.id,
          date: nowIso(),
          title: composerType === "chourei" ? `朝礼メモ(${store.storeName(me.storeId)})` : null,
          body,
          likes: [], comments: [], pinned: false,
        });
        composerDraft = "";
        toast("タイムラインに投稿しました");
        draw();
      };

      return el("div", { class: "card composer" },
        el("div", { class: "composer-row" }, avatar(me, 38), ta),
        el("div", { class: "composer-foot" },
          segWrap,
          el("span", { class: "spacer" }),
          el("button", { class: "btn primary", onclick: submit }, icon("send", 15), "投稿する")));
    }

    /* ---- 投稿カード(type別) ---- */
    function postCard(p) {
      if (p.type === "thanks") return thanksCard(p);
      const author = store.byId("staff", p.authorId);
      const meta = TYPE_META[p.type] || TYPE_META.notice;
      const channel = p.channelId ? store.byId("channels", p.channelId) : null;

      return el("article", { class: `post-card ${p.type} ${p.pinned ? "pinned" : ""}` },
        p.pinned ? el("div", { class: "pin-flag" }, "📌 ピン留めの重要連絡") : null,
        el("header", { class: "post-head" },
          avatar(author, 38),
          el("div", { class: "post-who" },
            el("span", { class: "post-name" }, author?.name || "—"),
            el("span", { class: "post-sub" },
              `${store.storeName(author?.storeId)}・${author?.role || ""} ・ ${relTime(p.date)}`)),
          el("div", { class: "post-tags" },
            badge(`${meta.emoji} ${meta.label}`, meta.kind),
            channel && channel.id !== "ch-all"
              ? el("span", { class: "channel-chip" }, `${channel.icon} ${channel.name}`)
              : null)),
        p.title ? el("h4", { class: "post-title" }, p.title) : null,
        el("p", { class: "post-body" }, p.body),
        postFoot(p),
        expanded.has(p.id) ? commentsBlock(p) : null,
      );
    }

    /* ---- サンクスカード(ギフトカード風) ---- */
    function thanksCard(p) {
      const from = store.byId("staff", p.authorId);
      const to = store.byId("staff", p.toId);
      return el("article", { class: "post-card thanks-card" },
        el("div", { class: "thanks-top" },
          el("span", { class: "thanks-label" }, "🎁 サンクスギフト"),
          el("span", { class: "thanks-pts" }, `+${p.points ?? 0}pt`)),
        el("div", { class: "thanks-people" },
          el("span", { class: "tp" },
            avatar(from, 32),
            el("span", { class: "tp-meta" },
              el("b", {}, from?.name || "—"),
              el("span", { class: "tp-rel" }, "から"))),
          el("span", { class: "thanks-arrow" }, icon("chevR", 17)),
          el("span", { class: "tp" },
            avatar(to, 32),
            el("span", { class: "tp-meta" },
              el("b", {}, to?.name || "—"),
              el("span", { class: "tp-rel" }, "へ")))),
        el("p", { class: "thanks-msg" }, p.body),
        postFoot(p, { withTime: true }),
        expanded.has(p.id) ? commentsBlock(p) : null,
      );
    }

    /* ---- いいね・コメントのフッター ---- */
    function postFoot(p, { withTime = false } = {}) {
      const meId = store.me().id;
      const liked = (p.likes || []).includes(meId);
      const likeBtn = el("button", {
        class: `pill-btn like ${liked ? "on" : ""}`,
        "aria-label": "いいね",
        onclick: () => {
          const likes = new Set(p.likes || []);
          likes.has(meId) ? likes.delete(meId) : likes.add(meId);
          store.update("posts", p.id, { likes: [...likes] });
          draw();
        },
      }, icon("heart", 15), String((p.likes || []).length));

      const commentBtn = el("button", {
        class: `pill-btn ${expanded.has(p.id) ? "on2" : ""}`,
        onclick: () => {
          expanded.has(p.id) ? expanded.delete(p.id) : expanded.add(p.id);
          draw();
        },
      }, icon("chat", 15), `コメント ${(p.comments || []).length}`);

      return el("div", { class: "post-foot" },
        withTime ? el("span", { class: "small muted" }, relTime(p.date)) : null,
        el("span", { class: "spacer" }),
        likeBtn, commentBtn);
    }

    /* ---- コメント欄 ---- */
    function commentsBlock(p) {
      const me = store.me();
      const wrap = el("div", { class: "comments" });
      for (const c of p.comments || []) {
        const ca = store.byId("staff", c.authorId);
        wrap.appendChild(el("div", { class: "comment" },
          avatar(ca, 28),
          el("div", { class: "comment-bubble" },
            el("div", { class: "comment-meta" },
              el("b", {}, ca?.name || "—"),
              el("span", { class: "muted small" }, relTime(c.date))),
            el("div", { class: "comment-text" }, c.body))));
      }
      const input = el("input", {
        class: "input", placeholder: "コメントを書く…",
        oninput: (e) => commentDrafts.set(p.id, e.target.value),
        onkeydown: (e) => { if (e.key === "Enter" && !e.isComposing) submit(); },
      });
      input.value = commentDrafts.get(p.id) || "";
      const submit = () => {
        const body = (commentDrafts.get(p.id) || "").trim();
        if (!body) return;
        store.update("posts", p.id, (post) => ({
          comments: [...(post.comments || []), { id: store.uid("c"), authorId: me.id, body, date: nowIso() }],
        }));
        commentDrafts.delete(p.id);
        toast("コメントしました");
        draw();
      };
      wrap.appendChild(el("div", { class: "comment-form" },
        avatar(me, 28), input,
        el("button", { class: "btn primary sm", onclick: submit }, icon("send", 13), "送信")));
      return wrap;
    }

    /* ================= サンクスタブ ================= */
    function drawThanks(main) {
      const me = store.me();
      const staffCount = store.get("staff").length;
      const sent = sentThisMonth();
      const thanksPosts = store.get("posts").filter((p) => p.type === "thanks").sort(byDateDesc);

      main.appendChild(el("div", { class: "kpi-row sns-kpi" },
        statTile({ label: "累計獲得ポイント", value: `${fmtNum(me.points)} pt`, icon: "gift", tone: "accent", sub: "サンクスで受け取った合計" }),
        statTile({ label: "全社ランキング", value: `${myRank()}位`, icon: "award", tone: "brand", sub: `全${staffCount}名中` }),
        statTile({ label: "今月の送信", value: `${fmtNum(sent)} pt`, icon: "heart", tone: "good", sub: `残り ${fmtNum(Math.max(0, MONTHLY_BUDGET - sent))}pt / 月${MONTHLY_BUDGET}pt` }),
      ));

      if (!thanksPosts.length) {
        main.appendChild(el("div", { class: "card" },
          emptyState({ icon: "🎁", title: "まだサンクスがありません", hint: "「サンクスを送る」から感謝を届けましょう" })));
        return;
      }
      main.appendChild(el("div", { class: "thanks-grid" }, thanksPosts.map((p) => thanksCard(p))));
    }

    /* ================= チャンネル(委員会) ================= */
    function drawChannels(main) {
      const posts = store.get("posts");
      if (activeChannel) {
        const ch = store.byId("channels", activeChannel);
        const chPosts = posts.filter((p) => p.channelId === activeChannel).sort(byDateDesc);
        main.appendChild(el("div", { class: "channel-back" },
          el("button", { class: "btn ghost sm", onclick: () => { activeChannel = null; draw(); } },
            icon("chevL", 14), "チャンネル一覧に戻る")));
        main.appendChild(el("div", { class: "card channel-banner" },
          el("span", { class: "channel-ic lg" }, ch?.icon || "💬"),
          el("div", { class: "channel-main" },
            el("span", { class: "channel-name" }, ch?.name || "—"),
            el("span", { class: "channel-desc wrap" }, ch?.desc || "")),
          badge(`投稿 ${chPosts.length}件`, "brand")));
        const list = el("div", { class: "post-list" });
        if (!chPosts.length) {
          list.appendChild(el("div", { class: "card" },
            emptyState({ icon: ch?.icon || "💬", title: "まだ投稿がありません", hint: "このチャンネルの最初の投稿を待っています" })));
        } else {
          chPosts.forEach((p) => list.appendChild(postCard(p)));
        }
        main.appendChild(list);
        return;
      }

      const grid = el("div", { class: "channel-grid" });
      for (const ch of store.get("channels")) {
        const count = posts.filter((p) => p.channelId === ch.id).length;
        grid.appendChild(el("button", {
          class: "channel-card",
          onclick: () => { activeChannel = ch.id; draw(); },
        },
          el("span", { class: "channel-ic" }, ch.icon),
          el("span", { class: "channel-main" },
            el("span", { class: "channel-name" }, ch.name),
            el("span", { class: "channel-desc" }, ch.desc)),
          el("span", { class: "channel-count" }, badge(`${count}件`), icon("chevR", 15))));
      }
      main.appendChild(grid);
    }

    /* ================= ランキング ================= */
    function drawRanking(main) {
      const m = monthOf(todayStr());
      const monthThanks = store.get("posts").filter((p) => p.type === "thanks" && (p.date || "").startsWith(m));
      const participants = new Set(monthThanks.flatMap((p) => [p.authorId, p.toId].filter(Boolean)));
      const totalPts = monthThanks.reduce((a, p) => a + (p.points || 0), 0);

      main.appendChild(el("div", { class: "kpi-row sns-kpi" },
        statTile({ label: "今月のサンクス", value: `${fmtNum(monthThanks.length)} 件`, icon: "gift", tone: "accent", sub: "全店舗合計" }),
        statTile({ label: "動いたポイント", value: `${fmtNum(totalPts)} pt`, icon: "trend", tone: "brand", sub: "今月の送受信合計" }),
        statTile({ label: "参加スタッフ", value: `${fmtNum(participants.size)} 名`, icon: "users", tone: "good", sub: "送った人+受け取った人" }),
      ));

      const sorted = [...store.get("staff")].sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, 8);
      const max = sorted[0]?.points || 1;
      const medals = ["🥇", "🥈", "🥉"];
      const meId = store.me().id;

      const rows = el("div", {}, sorted.map((s, i) =>
        el("div", { class: `rank-row ${s.id === meId ? "is-me" : ""}` },
          el("span", { class: "rank-no" }, i < 3 ? medals[i] : String(i + 1)),
          avatar(s, 36),
          el("div", { class: "rank-main" },
            el("div", { class: "flex between" },
              el("span", { class: "rank-name" }, s.name,
                s.id === meId ? badge("自分", "accent") : null,
                el("span", { class: "rank-sub" }, `${store.storeName(s.storeId)}・${s.role}`)),
              el("span", { class: "rank-pts" }, `${fmtNum(s.points)} pt`)),
            el("div", { class: "rank-bar-track" },
              el("div", { class: "rank-bar", style: { width: `${Math.round(((s.points || 0) / max) * 100)}%` } }))))));

      main.appendChild(card({
        title: "サンクスポイント ランキング",
        sub: "累計獲得ポイント TOP8",
        body: rows,
      }));
    }

    /* ================= サイドカード ================= */
    function pointsCard() {
      const me = store.me();
      const sent = sentThisMonth();
      const remaining = Math.max(0, MONTHLY_BUDGET - sent);
      return el("div", { class: "card points-card" },
        el("div", { class: "pc-head" }, "🎁 今月のサンクスポイント"),
        el("div", { class: "pc-num" },
          el("span", { class: "pc-big" }, fmtNum(remaining)),
          el("span", { class: "pc-unit" }, `/ ${MONTHLY_BUDGET}pt 残っています`)),
        meter({ label: "今月の使用分", value: sent, max: MONTHLY_BUDGET, fmt: (v) => `${v}pt`, kind: "accent" }),
        el("div", { class: "pc-kv" },
          kv("累計獲得ポイント", `${fmtNum(me.points)} pt`),
          kv("全社ランキング", `${myRank()}位 / ${store.get("staff").length}名`)),
        el("button", { class: "btn accent block", onclick: openThanksModal }, icon("gift", 16), "サンクスを送る"));
    }

    function philosophyCard() {
      const ph = store.state.philosophy;
      return el("div", { class: "card philosophy-card" },
        el("div", { class: "ph-label" }, "🧭 私たちの理念"),
        el("p", { class: "ph-mission" }, ph.mission),
        el("div", { class: "ph-values" },
          ph.values.map((v, i) => el("div", { class: "ph-value" },
            el("span", { class: "ph-idx" }, String(i + 1).padStart(2, "0")),
            el("span", { class: "ph-text" }, v)))),
        el("div", { class: "ph-note" }, "朝礼ではテーマを1つ選んで、自分の言葉で共有しましょう。"));
    }

    /* ================= サンクス送信モーダル ================= */
    function openThanksModal() {
      const me = store.me();
      const sent = sentThisMonth();
      const remaining = Math.max(0, MONTHLY_BUDGET - sent);
      let toId = null;
      let pts = [...PT_OPTIONS].reverse().find((p) => p <= remaining) ?? 0;
      let msg = "";

      const others = store.get("staff").filter((s) => s.id !== me.id);

      const staffWrap = el("div", { class: "tm-staff" });
      const renderStaff = () => {
        clear(staffWrap);
        for (const s of others) {
          staffWrap.appendChild(el("button", {
            class: `tm-person ${toId === s.id ? "on" : ""}`,
            onclick: () => { toId = s.id; renderStaff(); },
          },
            avatar(s, 30),
            el("span", { class: "tm-pmeta" },
              el("span", { class: "tm-pname" }, s.name),
              el("span", { class: "tm-prole" }, `${store.storeName(s.storeId)}・${s.role}`))));
        }
      };
      renderStaff();

      const ptWrap = el("div", { class: "tm-pts" });
      const renderPts = () => {
        clear(ptWrap);
        for (const p of PT_OPTIONS) {
          ptWrap.appendChild(el("button", {
            class: `tm-pt ${pts === p ? "on" : ""}`,
            disabled: p > remaining,
            onclick: () => { pts = p; renderPts(); },
          },
            el("span", { class: "tm-pt-emoji" }, p === 10 ? "🌱" : p === 20 ? "🌷" : "💐"),
            el("span", { class: "tm-pt-val" }, `${p}pt`)));
        }
      };
      renderPts();

      const ta = el("textarea", {
        class: "textarea", rows: 3,
        placeholder: "ありがとうの気持ちを言葉にして届けましょう(例:昨日のフォロー、本当に助かりました!)",
        oninput: (e) => { msg = e.target.value; },
      });

      const sendBtn = el("button", { class: "btn accent" }, icon("send", 15), "サンクスを送る");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: "サンクスを送る",
        body: el("div", { class: "page-sns" },
          el("div", { class: "thanks-modal" },
            el("div", { class: "field" }, el("label", {}, "宛先"), staffWrap),
            el("div", { class: "field" }, el("label", {}, "ギフトポイント"), ptWrap),
            el("div", { class: "field" }, el("label", {}, "メッセージ"), ta),
            el("div", { class: "tm-remaining" },
              icon("info", 14),
              `今月の残りポイント:${fmtNum(remaining)}pt(毎月${MONTHLY_BUDGET}ptまで送れます)`))),
        actions: [cancelBtn, sendBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      sendBtn.addEventListener("click", () => {
        if (!toId) { toast("宛先のスタッフを選択してください", "error"); return; }
        if (!msg.trim()) { toast("メッセージを入力してください", "error"); return; }
        if (!pts || pts > remaining) { toast("今月の残りポイントが足りません", "error"); return; }
        store.addFirst("posts", {
          type: "thanks", authorId: me.id, toId, points: pts,
          date: nowIso(), body: msg.trim(), likes: [], comments: [], pinned: false,
        });
        store.update("staff", toId, (s) => ({ points: (s.points || 0) + pts }));
        m.close();
        toast(`${store.staffName(toId)}さんに ${pts}pt のサンクスを送りました 🎁`);
        draw();
      });
    }

    draw();
  },
};
