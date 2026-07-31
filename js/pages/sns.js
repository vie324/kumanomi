/* ============================================================
   社内SNS — サンクスギフト + 社内タイムライン(TUNAG代替)
   感謝を送り合う文化と連絡事項を1箇所に。
   ============================================================ */
import {
  el, clear, icon, avatar, badge, kv, meter, card, sectionHeader,
  tabs, segmented, statTile, emptyState, modal, toast, relTime, fmtNum, celebrate,
} from "../ui.js";
import { store, todayStr, monthOf } from "../store.js";


const TYPE_META = {
  notice: { label: "連絡", emoji: "📣", kind: "brand" },
  chourei: { label: "朝礼", emoji: "🌅", kind: "accent" },
  philosophy: { label: "理念", emoji: "🧭", kind: "brand" },
  committee: { label: "委員会", emoji: "🗂", kind: "" },
};

function nowIso() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${todayStr()}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function byDateDesc(a, b) { return a.date < b.date ? 1 : -1; }


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
        "連絡事項・朝礼メモ・理念の共有と、委員会ごとのやりとり。",
        [el("button", { class: "btn ghost", onclick: () => { location.hash = "#/thanks"; } },
          icon("gift", 17), "サンクスギフトへ")],
      ));

      const main = el("div", { class: "sns-main" });
      const side = el("aside", { class: "sns-side" }, thanksLinkCard(), philosophyCard());
      root.appendChild(el("div", { class: "sns-layout" }, main, side));

      const posts = store.get("posts");
      main.appendChild(tabs([
        { id: "timeline", label: "タイムライン", badge: posts.length },
        { id: "channels", label: "チャンネル" },
      ], tab === "timeline" || tab === "channels" ? tab : "timeline", (id) => { tab = id; draw(); }));

      if (tab === "channels") drawChannels(main);
      else drawTimeline(main);
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



    function thanksLinkCard() {
      const me = store.me();
      const cards = store.get("thanksCards") || [];
      const mine = cards.filter((c) => (c.toIds || []).includes(me.id)).length;
      return el("div", { class: "card points-card" },
        el("div", { class: "pc-head" }, "🎁 サンクスギフト"),
        el("p", { class: "small muted", style: { lineHeight: "1.7" } },
          "感謝のカードは専用ページに移りました。写真や動画をつけて贈れます。"),
        el("div", { class: "pc-kv" },
          kv("もらったカード", `${fmtNum(mine)} 枚`),
          kv("累計獲得ポイント", `${fmtNum(me.points)} pt`)),
        el("button", { class: "btn accent block", onclick: () => { location.hash = "#/thanks"; } },
          icon("gift", 16), "サンクスを送る"),
        el("button", { class: "btn ghost block mt-8", onclick: () => { location.hash = "#/rewards"; } },
          icon("medal", 15), "ごほうび交換へ"));
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


    draw();
  },
};
