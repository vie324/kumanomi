/* ============================================================
   社内SNS — 連絡事項 / タイムライン / チャンネル / 売上報告 / サンクスギフト
   タイムラインは用途別に分かれている:
   ① 連絡事項    … 全体への業務連絡(責任者はピン留めできる)
   ② タイムライン … 連絡事項と同じ使い勝手で、日々の共有・気づき・写真など何でも
   ③ チャンネル  … 委員会などチャンネルへの投稿だけ
   ④ 売上報告    … 各店舗の売上報告だけ
   ⑤ サンクスギフト … ありがとうをポイントと一緒に贈り合う
   ⑥ ランキング  … サンクスポイントの順位

   「毎月のお願い」(1minuteアンケート・交通費申請)は、ここに置くのをやめて
   タスクに自動で積むようにした(js/autotasks.js)。脇のカードは状況だけ映す。
   ============================================================ */
import {
  el, clear, icon, avatar, badge, kv, card, sectionHeader,
  tabs, statTile, emptyState, modal, toast, relTime, fmtDate, fmtNum, fmtYen, celebrate,
  fileToDataURL, openImageModal,
} from "../ui.js";
import { store, todayStr, addDays, monthOf } from "../store.js";
import { rankLevel } from "../auth.js";
import { openUriageModal } from "./uriage.js";

/* 手持ちポイント(月の上限)は廃止。
   送ると SEND_BONUS pt、受け取るとギフト分のポイントがそのまま貯まる。 */
const SEND_BONUS = 10;
const PT_OPTIONS = [10, 20, 30];
const MAX_POST_IMAGES = 3;

const TYPE_META = {
  notice: { label: "連絡事項", emoji: "📣", kind: "brand" },
  timeline: { label: "タイムライン", emoji: "📝", kind: "" },
  chourei: { label: "朝礼", emoji: "🌅", kind: "accent" },
  philosophy: { label: "理念", emoji: "🧭", kind: "brand" },
  committee: { label: "委員会", emoji: "🗂", kind: "" },
  thanks: { label: "サンクス", emoji: "🎁", kind: "accent" },
  uriage: { label: "売上報告", emoji: "📊", kind: "brand" },
  free: { label: "タイムライン", emoji: "📝", kind: "" },
};

/* ---- タイムラインの振り分け ---- */
const isChannelPost = (p) => !!p.channelId && p.channelId !== "ch-all";
const inNotice = (p) => ["notice", "chourei", "philosophy"].includes(p.type) && !isChannelPost(p);
const inTimeline = (p) => ["timeline", "free"].includes(p.type) && !isChannelPost(p);
const inUriage = (p) => p.type === "uriage";
const inThanks = (p) => p.type === "thanks";

const TABS = ["notice", "timeline", "channels", "uriage", "thanks", "ranking"];

const TIMELINE_META = {
  notice: { emoji: "📣", desc: "全店舗向けの業務連絡が流れるタイムラインです。責任者は重要な連絡をピン留めできます" },
  timeline: { emoji: "📝", desc: "日々の共有・気づき・お知らせを何でも。連絡事項と同じように写真も添えられます" },
  channels: { emoji: "🗂", desc: "委員会などチャンネルへの投稿だけが流れるタイムラインです" },
  uriage: { emoji: "📊", desc: "各店舗の売上報告だけが流れるタイムラインです(毎日の業務「売上報告」から投稿されます)" },
  thanks: { emoji: "🎁", desc: "ありがとうをポイントと一緒に贈り合うタイムラインです。送っても受け取ってもポイントが貯まります" },
};

function nowIso() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${todayStr()}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function byDateDesc(a, b) { return a.date < b.date ? 1 : -1; }

/* ---- ポイントは投稿から計算する ----
   以前はスタッフの行にポイントを書き込んでいたが、それだと端末ごとに数字がずれる。
   サンクス投稿(全員に届く)から毎回計算すれば、誰の画面でも同じ順位になる。
   デモデータのスタッフに入っている points は「これまでの持ち越し」として足す。 */
export function pointsOf(staffId) {
  const base = store.byId("staff", staffId)?.points || 0;
  let pts = 0;
  for (const p of store.get("posts") || []) {
    if (p.type !== "thanks") continue;
    if (p.toId === staffId) pts += p.points || 0;
    if (p.authorId === staffId) pts += SEND_BONUS;
  }
  return base + pts;
}

/** 今月自分が送ったサンクス(件数と送信ボーナス) */
function sentThisMonth() {
  const meId = store.me().id;
  const m = monthOf(todayStr());
  const mine = store.get("posts")
    .filter((p) => p.type === "thanks" && p.authorId === meId && (p.date || "").startsWith(m));
  return { count: mine.length, bonus: mine.length * SEND_BONUS };
}

/** 今月自分が受け取ったサンクスポイント合計 */
function receivedThisMonth() {
  const meId = store.me().id;
  const m = monthOf(todayStr());
  const mine = store.get("posts")
    .filter((p) => p.type === "thanks" && p.toId === meId && (p.date || "").startsWith(m));
  return { count: mine.length, points: mine.reduce((a, p) => a + (p.points || 0), 0) };
}

/** 今月の獲得ポイント(受取+送信ボーナス) */
function earnedThisMonth() {
  return receivedThisMonth().points + sentThisMonth().bonus;
}

function rankedStaff() {
  return [...store.get("staff")]
    .map((s) => ({ s, pts: pointsOf(s.id) }))
    .sort((a, b) => b.pts - a.pts);
}

function myRank() {
  return rankedStaff().findIndex((r) => r.s.id === store.me().id) + 1;
}

export default {
  id: "sns",
  title: "社内SNS",
  icon: "chat",

  // このページが必要とするデータ。ルーターがそろえてから render() を呼ぶ
  needs: ["channels", "posts", "staff", "stores", "tasks"],
  render(root, params = []) {
    /* ---- ページ内状態(再描画をまたいで保持) ---- */
    let tab = TABS.includes(params[0]) ? params[0] : "notice";
    let activeChannel = null;         // チャンネルタイムラインの絞り込み
    const drafts = { notice: "", timeline: "" };
    const images = { notice: [], timeline: [] };   // 添付画像 dataURL(最大3枚)
    let pinDraft = false;             // 連絡事項をピン留めして投稿するか
    let channelDraft = "";            // チャンネル投稿の下書き
    let channelTarget = null;         // チャンネル投稿先
    let feedQuery = "";               // タイムライン内の検索語
    let feedLimit = 12;               // 段階表示の件数
    const expanded = new Set();       // コメント展開中の投稿ID
    const commentDrafts = new Map();  // 投稿ID → 下書き

    // 「前回ここを見たとき」の基準時刻。ページを開いている間は固定して、
    // 再描画のたびに NEW が消えてしまわないようにする
    const seenBaseline = { ...(store.state.settings.timelineSeen || {}) };

    /* ================= 描画ルート ================= */
    function draw({ keepFocus = false } = {}) {
      const selStart = keepFocus ? root.querySelector(".feed-search")?.selectionStart : null;
      clear(root);
      root.appendChild(sectionHeader(
        "社内SNS",
        "連絡事項・タイムライン・チャンネル・売上報告・サンクスギフト。用途ごとに分かれているので、読みたいものだけ追えます。",
        [el("button", { class: "btn accent", onclick: openThanksModal }, icon("gift", 17), "サンクスを送る")],
      ));

      const main = el("div", { class: "sns-main" });
      const side = el("aside", { class: "sns-side" }, pointsCard(), monthlyCard(), philosophyCard());
      root.appendChild(el("div", { class: "sns-layout" }, main, side));

      const posts = store.get("posts");
      main.appendChild(tabs([
        { id: "notice", label: "📣 連絡事項", badge: posts.filter(inNotice).length },
        { id: "timeline", label: "📝 タイムライン", badge: posts.filter(inTimeline).length },
        { id: "channels", label: "🗂 チャンネル", badge: posts.filter(isChannelPost).length },
        { id: "uriage", label: "📊 売上報告", badge: posts.filter(inUriage).length },
        { id: "thanks", label: "🎁 サンクスギフト", badge: posts.filter(inThanks).length },
        { id: "ranking", label: "🏆 ランキング" },
      ], tab, (id) => {
        // タイムラインを切り替えたら検索と表示件数はリセットする
        tab = id; feedQuery = ""; feedLimit = PAGE_SIZE; activeChannel = null;
        try { history.replaceState(null, "", `#/sns/${id}`); } catch (e) { /* noop */ }
        draw();
      }));

      if (tab !== "ranking") main.appendChild(timelineLead(tab));

      if (tab === "notice") drawNotice(main);
      else if (tab === "timeline") drawTimeline(main);
      else if (tab === "channels") drawChannels(main);
      else if (tab === "uriage") drawUriage(main);
      else if (tab === "thanks") drawThanks(main);
      else drawRanking(main);

      if (keepFocus) {
        const s = root.querySelector(".feed-search");
        if (s) { s.focus(); if (selStart != null) s.setSelectionRange(selStart, selStart); }
      }
      markTimelineSeen();
    }

    /** このタイムラインを見た時刻を控える(次回の NEW 判定に使う) */
    function markTimelineSeen() {
      if (tab === "ranking") return;
      store.setSetting("timelineSeen", {
        ...(store.state.settings.timelineSeen || {}),
        [tab]: new Date().toISOString(),
      });
    }

    /** 各タイムラインの用途を示すリード */
    function timelineLead(id) {
      const meta = TIMELINE_META[id];
      if (!meta) return el("span");
      return el("div", { class: "tl-lead" },
        el("span", { class: "tl-lead-ic" }, meta.emoji),
        el("span", {}, meta.desc));
    }

    /* ================= ① 連絡事項 ================= */
    function drawNotice(main) {
      main.appendChild(composer("notice"));
      const posts = [...store.get("posts")].filter(inNotice).sort(byDateDesc);
      renderFeed(main, posts, { icon: "📣", title: "まだ連絡事項がありません", hint: "最初の業務連絡を書いてみましょう" });
    }

    /* ================= ② タイムライン(連絡事項と同じ機能) ================= */
    function drawTimeline(main) {
      main.appendChild(composer("timeline"));
      const posts = [...store.get("posts")].filter(inTimeline).sort(byDateDesc);
      renderFeed(main, posts, { icon: "📝", title: "まだ投稿がありません", hint: "今日の気づきや共有したいことを書いてみましょう" });
    }

    /* ---- 投稿フォーム(画像を1〜3枚添付できる)。連絡事項・タイムラインで共用 ---- */
    function composer(type) {
      const me = store.me();
      const isNotice = type === "notice";
      const ta = el("textarea", {
        class: "textarea composer-input", rows: 2,
        placeholder: isNotice
          ? "全体への業務連絡を書きましょう(連絡事項タイムラインに投稿されます)"
          : "業務連絡でなくてOK。今日の気づき、おすすめ、ちょっとした共有をどうぞ",
        oninput: (e) => { drafts[type] = e.target.value; },
      });
      ta.value = drafts[type];

      /* --- 画像添付 --- */
      const list = images[type];
      const fileIn = el("input", {
        type: "file", accept: "image/*", multiple: true,
        style: { display: "none" },
      });
      const thumbs = el("div", { class: "attach-thumbs composer-thumbs" });
      const attachBtn = el("button", { class: "btn ghost sm", type: "button", onclick: () => fileIn.click() },
        "🖼", el("span", {}, `画像(${list.length}/${MAX_POST_IMAGES})`));

      const paintThumbs = () => {
        clear(thumbs);
        list.forEach((src, i) => {
          thumbs.appendChild(el("span", { class: "attach-thumb" },
            el("img", { src, alt: `添付画像${i + 1}` }),
            el("button", {
              class: "at-del", type: "button", "aria-label": "この画像を外す",
              onclick: () => { list.splice(i, 1); paintThumbs(); },
            }, "×")));
        });
        clear(attachBtn).append("🖼", el("span", {}, `画像(${list.length}/${MAX_POST_IMAGES})`));
        attachBtn.disabled = list.length >= MAX_POST_IMAGES;
      };

      fileIn.addEventListener("change", async () => {
        const files = [...(fileIn.files || [])];
        fileIn.value = "";
        if (!files.length) return;
        const room = MAX_POST_IMAGES - list.length;
        if (files.length > room) toast(`画像は最大${MAX_POST_IMAGES}枚までです`, "info");
        for (const f of files.slice(0, room)) {
          try {
            list.push(await fileToDataURL(f));
          } catch (e) {
            toast(`「${f.name}」を読み込めませんでした`, "error");
          }
        }
        paintThumbs();
      });
      paintThumbs();

      // 責任者(院長以上)は連絡事項をピン留めして投稿できる
      const canPin = isNotice && rankLevel(me) >= 3;
      const pinCb = el("input", { type: "checkbox", checked: pinDraft, onchange: (e) => { pinDraft = e.target.checked; } });
      const pinLabel = canPin
        ? el("label", { class: "composer-pin" }, pinCb, "📌 重要(ピン留め)")
        : null;

      const submit = () => {
        const body = drafts[type].trim();
        if (!body && !list.length) { toast("共有する内容を入力してください", "error"); return; }
        store.addFirst("posts", {
          type,
          channelId: isNotice ? "ch-all" : null,
          authorId: me.id,
          date: nowIso(),
          title: null,
          body,
          images: [...list],
          likes: [], comments: [], pinned: canPin && pinDraft,
        });
        drafts[type] = "";
        images[type] = [];
        pinDraft = false;
        toast(isNotice ? "連絡事項に投稿しました" : "タイムラインに投稿しました");
        draw();
      };

      return el("div", { class: "card composer" },
        el("div", { class: "composer-row" }, avatar(me, 38), ta),
        thumbs,
        el("div", { class: "composer-foot" },
          badge(`${TYPE_META[type].emoji} ${TYPE_META[type].label}`, TYPE_META[type].kind),
          attachBtn, fileIn,
          pinLabel,
          el("span", { class: "spacer" }),
          el("button", { class: "btn primary", onclick: submit }, icon("send", 15), "投稿する")));
    }

    /* ---- 投稿画像のグリッド表示 ---- */
    function postImages(p) {
      const imgs = p.images || [];
      if (!imgs.length) return null;
      return el("div", { class: `post-images n${Math.min(imgs.length, 3)}` },
        imgs.slice(0, MAX_POST_IMAGES).map((src, i) => el("button", {
          class: "post-img",
          "aria-label": `添付画像${i + 1}を拡大`,
          onclick: () => openImageModal(src, "添付画像"),
        }, el("img", { src, alt: `添付画像${i + 1}`, loading: "lazy" }))));
    }

    /* ---- 長い投稿は折りたたむ(タイムラインを流し読みできるように) ---- */
    const FOLD_LEN = 170;
    function postBody(p, extra = null) {
      if (!p.body) return null;
      const long = p.body.length > FOLD_LEN;
      const body = el("p", { class: `post-body ${long ? "foldable" : ""}` }, extra, p.body);
      if (!long) return body;
      const more = el("button", { class: "post-more" }, "続きを読む");
      more.addEventListener("click", () => {
        const open = body.classList.toggle("open");
        more.textContent = open ? "折りたたむ" : "続きを読む";
      });
      return el("div", { class: "post-bodywrap" }, body, more);
    }

    /** その投稿が前回この画面を見たあとのものか(NEW バッジ用) */
    const isNew = (p) => !!seenBaseline[tab] && (p.date || "") > seenBaseline[tab];

    /* ---- 投稿カード(type別) ---- */
    function postCard(p) {
      if (p.type === "thanks") return thanksCard(p);
      if (p.type === "uriage") return uriageCard(p);
      const me = store.me();
      const author = store.byId("staff", p.authorId);
      const meta = TYPE_META[p.type] || TYPE_META.notice;
      const channel = p.channelId ? store.byId("channels", p.channelId) : null;
      const mayPin = ["notice", "chourei", "philosophy"].includes(p.type) && rankLevel(me) >= 3;
      const mayDelete = p.authorId === me.id || rankLevel(me) >= 3;

      return el("article", { class: `post-card ${p.type} ${p.pinned ? "pinned" : ""} ${isNew(p) ? "is-new" : ""}` },
        p.pinned ? el("div", { class: "pin-flag" }, "📌 ピン留めの重要連絡") : null,
        el("header", { class: "post-head" },
          avatar(author, 38),
          el("div", { class: "post-who" },
            el("span", { class: "post-name" }, author?.name || "—"),
            el("span", { class: "post-sub" },
              `${store.storeName(author?.storeId)}・${author?.role || ""} ・ ${relTime(p.date)}`)),
          el("div", { class: "post-tags" },
            isNew(p) ? el("span", { class: "post-new" }, "NEW") : null,
            badge(`${meta.emoji} ${meta.label}`, meta.kind),
            channel && channel.id !== "ch-all"
              ? el("span", { class: "channel-chip" }, `${channel.icon} ${channel.name}`)
              : null,
            mayPin ? el("button", {
              class: "icon-btn sm post-op", title: p.pinned ? "ピン留めを外す" : "ピン留めする", "aria-label": "ピン留め",
              onclick: () => { store.update("posts", p.id, { pinned: !p.pinned }); toast(p.pinned ? "ピン留めを外しました" : "ピン留めしました"); draw(); },
            }, icon("pin", 14)) : null,
            mayDelete ? el("button", {
              class: "icon-btn sm post-op", title: "この投稿を削除", "aria-label": "削除",
              onclick: () => { store.remove("posts", p.id); toast("投稿を削除しました", "info"); draw(); },
            }, icon("trash", 14)) : null)),
        p.title ? el("h4", { class: "post-title" }, p.title) : null,
        postBody(p),
        postImages(p),
        postFoot(p),
        expanded.has(p.id) ? commentsBlock(p) : null,
      );
    }

    /* ============================================================
       フィードの描画(各タイムライン共通)
       日付でまとめ、新着に印を付け、長いタイムラインは段階表示する
       ============================================================ */
    const PAGE_SIZE = 12;

    /** 日付見出しのラベル。今日・昨日は言葉で出す */
    function dayLabel(dateStr) {
      if (dateStr === todayStr()) return "今日";
      if (dateStr === addDays(todayStr(), -1)) return "昨日";
      return fmtDate(dateStr, { withYear: dateStr.slice(0, 4) !== todayStr().slice(0, 4) });
    }

    /**
     * @param {HTMLElement} main 追加先
     * @param {object[]} posts   表示する投稿(並び替え済み)
     * @param {{icon:string,title:string,hint:string}} empty 空のときの表示
     */
    function renderFeed(main, posts, empty) {
      /* --- 検索 --- */
      const search = el("input", {
        class: "input feed-search", type: "search", value: feedQuery,
        placeholder: "このタイムラインを検索(本文・タイトル・投稿者名)",
        "aria-label": "タイムラインを検索",
      });
      let timer = null;
      search.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => { feedQuery = search.value; feedLimit = PAGE_SIZE; draw({ keepFocus: true }); }, 200);
      });

      const q = feedQuery.trim();
      const filtered = q
        ? posts.filter((p) =>
            (p.body || "").includes(q) || (p.title || "").includes(q)
            || store.staffName(p.authorId).includes(q))
        : posts;
      const newCount = posts.filter(isNew).length;

      main.appendChild(el("div", { class: "feed-bar" },
        search,
        el("span", { class: "feed-count" },
          q ? `「${q}」に一致:${filtered.length}件` : `${posts.length}件`,
          newCount ? el("span", { class: "feed-newcount" }, `新着 ${newCount}`) : null)));

      if (!filtered.length) {
        main.appendChild(el("div", { class: "card" }, emptyState(q
          ? { icon: "🔍", title: "該当する投稿が見つかりません", hint: "別のキーワードで探してみてください" }
          : empty)));
        return;
      }

      /* --- ピン留めは常に先頭にまとめる --- */
      const list = el("div", { class: "post-list" });
      const pinned = filtered.filter((p) => p.pinned);
      const rest = filtered.filter((p) => !p.pinned);
      if (pinned.length) {
        list.appendChild(el("div", { class: "feed-sep pinned" }, "📌 ピン留め"));
        pinned.forEach((p) => list.appendChild(postCard(p)));
      }

      /* --- 日付ごとに区切って表示(段階表示) --- */
      const shown = rest.slice(0, feedLimit);
      let lastDay = null;
      for (const p of shown) {
        const day = (p.date || "").slice(0, 10);
        if (day !== lastDay) {
          lastDay = day;
          list.appendChild(el("div", { class: "feed-sep" }, dayLabel(day)));
        }
        list.appendChild(postCard(p));
      }
      main.appendChild(list);

      if (rest.length > shown.length) {
        main.appendChild(el("div", { class: "feed-more" },
          el("button", {
            class: "btn ghost",
            onclick: () => { feedLimit += PAGE_SIZE; draw(); },
          }, icon("chevD", 15), `過去の投稿をもっと見る(残り ${rest.length - shown.length}件)`)));
      }
    }

    /* ---- サンクスカード(ギフトカード風) ---- */
    function thanksCard(p) {
      const from = store.byId("staff", p.authorId);
      const to = store.byId("staff", p.toId);
      return el("article", { class: `post-card thanks-card ${isNew(p) ? "is-new" : ""}` },
        el("div", { class: "thanks-top" },
          el("span", { class: "thanks-label" }, "🎁 サンクスギフト"),
          isNew(p) ? el("span", { class: "post-new" }, "NEW") : null,
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

    /* ---- 売上報告カード(数値+消化率写真+報連相) ---- */
    function uriageCard(p) {
      const author = store.byId("staff", p.authorId);
      const st = store.byId("stores", p.storeId);
      const u = p.uriage || {};
      const cell = (label, value, cls = "") => el("span", { class: `ur-cell ${cls}` },
        el("span", { class: "ur-cell-label" }, label),
        el("span", { class: "ur-cell-value" }, value));
      return el("article", { class: `post-card uriage-post ${isNew(p) ? "is-new" : ""}` },
        el("header", { class: "post-head" },
          avatar(author, 38),
          el("div", { class: "post-who" },
            el("span", { class: "post-name" }, author?.name || "—"),
            el("span", { class: "post-sub" }, `${store.storeName(author?.storeId)}・${author?.role || ""} ・ ${relTime(p.date)}`)),
          el("div", { class: "post-tags" },
            isNew(p) ? el("span", { class: "post-new" }, "NEW") : null,
            badge("📊 売上報告", "brand"),
            el("span", { class: "channel-chip" },
              el("span", { class: "ur-dot", style: { background: st?.color || "var(--brand)" } }),
              st?.name || "—"))),
        el("div", { class: "ur-cells" },
          cell("売上", fmtYen(u.sales), "big"),
          cell("来患数", `${fmtNum(u.patients)}人`),
          cell("新患数", `${fmtNum(u.newPatients)}人`),
          cell("キャンセル", `${fmtNum(u.cancels)}件`)),
        postImages(p),
        (p.images || []).length ? el("div", { class: "ur-photo-note" }, "📷 消化率の写真") : null,
        postBody(p, el("b", { class: "ur-horenso-tag" }, "報連相")),
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

    /* ================= ③ チャンネルタイムライン ================= */
    /** チャンネル(ch-all 以外)への投稿だけが流れる。チップで絞り込み+ここから投稿もできる */
    function drawChannels(main) {
      const posts = store.get("posts");
      const channels = store.get("channels").filter((c) => c.id !== "ch-all");

      // 絞り込みチップ
      const chips = el("div", { class: "channel-chips" },
        el("button", {
          class: `chip ${!activeChannel ? "on" : ""}`,
          onclick: () => { activeChannel = null; draw(); },
        }, "すべて"),
        channels.map((ch) => el("button", {
          class: `chip ${activeChannel === ch.id ? "on" : ""}`,
          onclick: () => { activeChannel = activeChannel === ch.id ? null : ch.id; draw(); },
        }, `${ch.icon} ${ch.name}`)));
      main.appendChild(chips);

      if (activeChannel) {
        const ch = store.byId("channels", activeChannel);
        main.appendChild(el("div", { class: "card channel-banner" },
          el("span", { class: "channel-ic lg" }, ch?.icon || "💬"),
          el("div", { class: "channel-main" },
            el("span", { class: "channel-name" }, ch?.name || "—"),
            el("span", { class: "channel-desc wrap" }, ch?.desc || "")),
          badge(`投稿 ${posts.filter((p) => p.channelId === activeChannel).length}件`, "brand")));
      }

      main.appendChild(channelComposer(channels));

      const feed = posts
        .filter((p) => (activeChannel ? p.channelId === activeChannel : isChannelPost(p)))
        .sort(byDateDesc);
      renderFeed(main, feed, { icon: "🗂", title: "まだチャンネル投稿がありません", hint: "チャンネルを選んで最初の投稿をしてみましょう" });
    }

    /** チャンネル投稿フォーム(投稿先チャンネルを選んで投稿) */
    function channelComposer(channels) {
      const me = store.me();
      if (!channelTarget || !channels.some((c) => c.id === channelTarget)) {
        channelTarget = activeChannel && activeChannel !== "ch-all" ? activeChannel : channels[0]?.id;
      }
      if (activeChannel) channelTarget = activeChannel;

      const sel = el("select", { class: "select composer-chsel", "aria-label": "投稿先チャンネル",
        onchange: (e) => { channelTarget = e.target.value; } },
        channels.map((c) => el("option", { value: c.id, selected: c.id === channelTarget }, `${c.icon} ${c.name}`)));

      const ta = el("textarea", {
        class: "textarea composer-input", rows: 2,
        placeholder: "チャンネルのメンバーに共有したいことを書きましょう",
        oninput: (e) => { channelDraft = e.target.value; },
      });
      ta.value = channelDraft;

      const submit = () => {
        const body = channelDraft.trim();
        if (!body) { toast("共有する内容を入力してください", "error"); return; }
        store.addFirst("posts", {
          type: "committee",
          channelId: channelTarget,
          authorId: me.id,
          date: nowIso(),
          title: null,
          body,
          likes: [], comments: [], pinned: false,
        });
        channelDraft = "";
        toast(`${store.byId("channels", channelTarget)?.name || "チャンネル"}に投稿しました`);
        draw();
      };

      return el("div", { class: "card composer" },
        el("div", { class: "composer-row" }, avatar(me, 38), ta),
        el("div", { class: "composer-foot" },
          el("span", { class: "small muted" }, "投稿先"),
          sel,
          el("span", { class: "spacer" }),
          el("button", { class: "btn primary", onclick: submit }, icon("send", 15), "チャンネルに投稿")));
    }

    /* ================= ④ 売上報告タイムライン ================= */
    function drawUriage(main) {
      const feed = store.get("posts").filter(inUriage).sort(byDateDesc);
      const today = todayStr();
      const todays = feed.filter((p) => (p.date || "").startsWith(today));
      const storeN = store.get("stores").length;

      main.appendChild(el("div", { class: "uriage-actionbar card" },
        el("span", { class: "ua-main" },
          el("b", {}, `本日の報告:${new Set(todays.map((p) => p.storeId)).size}/${storeN}店舗`),
          el("span", { class: "small muted" }, "店舗の代表者が締め後に投稿してください(全スタッフ投稿可)")),
        el("span", { class: "spacer" }),
        el("a", { class: "btn ghost sm", href: "#/uriage" }, icon("trend", 14), "売上報告ページへ"),
        el("button", { class: "btn primary sm", onclick: () => openUriageModal({ onSubmitted: () => draw() }) },
          icon("plus", 14), "売上報告を投稿")));

      renderFeed(main, feed, { icon: "📊", title: "まだ売上報告がありません", hint: "「売上報告を投稿」から本日の数字を共有しましょう" });
    }

    /* ================= ⑤ サンクスギフト ================= */
    function drawThanks(main) {
      const me = store.me();
      const sent = sentThisMonth();
      const recv = receivedThisMonth();

      main.appendChild(el("div", { class: "kpi-row sns-kpi" },
        statTile({ label: "累計獲得ポイント", value: `${fmtNum(pointsOf(me.id))} pt`, icon: "gift", tone: "accent", sub: "送っても受け取っても貯まります" }),
        statTile({ label: "今月の獲得", value: `+${fmtNum(earnedThisMonth())} pt`, icon: "heart", tone: "good", sub: `受取 ${fmtNum(recv.points)}pt+送信ボーナス ${fmtNum(sent.bonus)}pt` }),
        statTile({ label: "全社ランキング", value: `${myRank()}位`, icon: "award", tone: "brand", sub: `全${store.get("staff").length}名中` }),
      ));

      main.appendChild(el("div", { class: "uriage-actionbar card thanks-bar" },
        el("span", { class: "ua-main" },
          el("b", {}, "ありがとうを、ポイントと一緒に。"),
          el("span", { class: "small muted" }, `送ると +${SEND_BONUS}pt、受け取るとギフト分が貯まります。今月はまだ ${sent.count} 件送っています`)),
        el("span", { class: "spacer" }),
        el("button", { class: "btn accent sm", onclick: openThanksModal }, icon("gift", 14), "サンクスを送る")));

      const feed = store.get("posts").filter(inThanks).sort(byDateDesc);
      renderFeed(main, feed, { icon: "🎁", title: "まだサンクスがありません", hint: "「サンクスを送る」から最初のありがとうを届けましょう" });
    }

    /* ================= ⑥ ランキング ================= */
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

      const sorted = rankedStaff().slice(0, 8);
      const max = sorted[0]?.pts || 1;
      const medals = ["🥇", "🥈", "🥉"];
      const meId = store.me().id;

      const rows = el("div", {}, sorted.map(({ s, pts }, i) =>
        el("div", { class: `rank-row ${s.id === meId ? "is-me" : ""}` },
          el("span", { class: "rank-no" }, i < 3 ? medals[i] : String(i + 1)),
          avatar(s, 36),
          el("div", { class: "rank-main" },
            el("div", { class: "flex between" },
              el("span", { class: "rank-name" }, s.name,
                s.id === meId ? badge("自分", "accent") : null,
                el("span", { class: "rank-sub" }, `${store.storeName(s.storeId)}・${s.role}`)),
              el("span", { class: "rank-pts" }, `${fmtNum(pts)} pt`)),
            el("div", { class: "rank-bar-track" },
              el("div", { class: "rank-bar", style: { width: `${Math.round((pts / max) * 100)}%` } }))))));

      main.appendChild(card({
        title: "サンクスポイント ランキング",
        sub: "累計獲得ポイント TOP8",
        body: sorted.length ? rows : emptyState({ icon: "🏆", title: "まだランキングがありません", hint: "サンクスを送り合うと順位が付きます" }),
      }));
    }

    /* ================= サイドカード ================= */
    function pointsCard() {
      const me = store.me();
      const sent = sentThisMonth();
      const recv = receivedThisMonth();
      return el("div", { class: "card points-card" },
        el("div", { class: "pc-head" }, "🎁 サンクスポイント"),
        el("div", { class: "pc-num" },
          el("span", { class: "pc-big" }, fmtNum(pointsOf(me.id))),
          el("span", { class: "pc-unit" }, "pt(累計)")),
        el("div", { class: "pc-earnnote" },
          icon("sparkle", 13),
          el("span", {}, "手持ちポイントの制限はありません。", el("strong", {}, `送ると+${SEND_BONUS}pt`), "、", el("strong", {}, "受け取るとギフト分"), "が貯まります。")),
        el("div", { class: "pc-kv" },
          kv("今月の獲得", `+${fmtNum(earnedThisMonth())} pt`),
          kv("今月:送った", `${fmtNum(sent.count)}件(+${fmtNum(sent.bonus)}pt)`),
          kv("今月:受け取った", `${fmtNum(recv.count)}件(+${fmtNum(recv.points)}pt)`),
          kv("全社ランキング", `${myRank()}位 / ${store.get("staff").length}名`)),
        el("button", { class: "btn accent block", onclick: openThanksModal }, icon("gift", 16), "サンクスを送る"));
    }

    /* 毎月のお願い:タスクに自動で積まれる。ここでは状況だけ映す */
    function monthlyCard() {
      const me = store.me();
      const month = monthOf(todayStr());
      const m = Number(month.slice(5));
      const tasksAll = store.get("tasks") || [];
      const items = [
        { key: `survey:${me.id}:${month}`, ic: "📝", title: "1minuteアンケートに回答", sub: "所要1分・月1回" },
        { key: `transport:${me.id}:${month}`, ic: "🚃", title: "交通費を申請(月1回)", sub: "領収書画像+金額+区間+距離" },
      ].map((it) => ({ ...it, task: tasksAll.find((t) => t.autoKey === it.key) || null }));

      return el("div", { class: "card monthly-card" },
        el("div", { class: "mc-head" }, "📌 毎月のお願い", badge(`${m}月分`, "accent")),
        el("p", { class: "small muted mc-note" }, "タスクに自動で追加されています。済んだらタスクで完了にしてください。"),
        items.map((it) => {
          const done = it.task?.status === "done";
          return el("a", { class: `mc-item ${done ? "done" : ""}`, href: "#/tasks" },
            el("span", { class: "mc-ic" }, done ? "✅" : it.ic),
            el("span", { class: "mc-main" },
              el("span", { class: "mc-title" }, it.title),
              el("span", { class: "mc-sub" }, done ? "完了しました" : it.task ? `タスクに追加済み・期限 ${fmtDate(it.task.due, { withDow: false })}` : it.sub)),
            icon("chevR", 15));
        }));
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
      let toId = null;
      let pts = 20;
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
            el("div", { class: "field" }, el("label", {}, "ギフトポイント(相手に貯まります)"), ptWrap),
            el("div", { class: "field" }, el("label", {}, "メッセージ"), ta),
            el("div", { class: "tm-remaining" },
              icon("info", 14),
              `送ると、あなたにも送信ボーナス +${SEND_BONUS}pt が貯まります(送信上限はありません)`))),
        actions: [cancelBtn, sendBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      sendBtn.addEventListener("click", () => {
        if (!toId) { toast("宛先のスタッフを選択してください", "error"); return; }
        if (!msg.trim()) { toast("メッセージを入力してください", "error"); return; }
        // ポイントは投稿から計算するので、ここで staff に書き込む必要はない
        store.addFirst("posts", {
          type: "thanks", authorId: me.id, toId, points: pts,
          date: nowIso(), body: msg.trim(), likes: [], comments: [], pinned: false,
        });
        m.close();
        celebrate(`${store.staffName(toId)}さんに ${pts}pt のサンクスを送りました!(あなたに+${SEND_BONUS}pt)`);
        if (tab !== "thanks" && tab !== "ranking") tab = "thanks";
        draw();
      });
    }

    draw();
  },
};
