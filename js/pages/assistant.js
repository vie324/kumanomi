/* ============================================================
   AIアシスタント — 使い方・疑問を何でも聞けるAIチャット
   左:チャットスレッド / 右:FAQ検索・アコーディオン
   ============================================================ */

import { el, icon, clear, emptyState, toast, fishMark } from "../ui.js";
import { store } from "../store.js";
import { chatReply, quickQuestions } from "../ai.js";

/* 会話ログ(モジュールスコープ:ページ遷移して戻っても同セッション中は残る) */
let chatLog = [];
let pending = false;

const WELCOME =
  "こんにちは!くまのみポータルのAIアシスタントです。\n" +
  "システムの使い方、シフトや日報のルール、患者様対応のフローなど、何でも日本語で質問してください。\n" +
  "下のクイック質問をタップするか、右の「よくある質問」からも聞けます。";

export default {
  id: "assistant",
  title: "AIアシスタント",
  icon: "sparkle",
  render(root) {

    /* ================= チャット(左カラム) ================= */

    const thread = el("div", { class: "as-thread", role: "log", "aria-live": "polite" });

    const scrollBottom = (smooth = true) => {
      requestAnimationFrame(() => {
        thread.scrollTo({ top: thread.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      });
    };

    const aiRow = (children) => el("div", { class: "as-row ai" },
      el("span", { class: "as-avatar", "aria-hidden": "true" }, fishMark(28, "float")),
      el("div", { class: "as-col" }, children));

    const bubbleFor = (m) => {
      if (m.role === "user") {
        return el("div", { class: "as-row user" },
          el("div", { class: "as-bubble user" }, m.text));
      }
      return aiRow([
        el("div", { class: "as-bubble ai" }, m.text),
        m.source ? el("div", { class: "as-source" }, icon("book", 12), `参照: ${m.source}`) : null,
      ]);
    };

    const typingRow = () => aiRow([
      el("div", { class: "as-bubble ai" },
        el("span", { class: "ai-thinking" },
          el("span", { class: "th-dots" }, el("i"), el("i"), el("i")),
          "考えています…")),
    ]);

    // ウェルカムバブル+クイック質問チップ(会話ログとは別の固定表示)
    const chips = el("div", { class: "as-chips" },
      quickQuestions().map((q) =>
        el("button", { class: "as-chip", onclick: () => send(q) }, q)));
    thread.append(aiRow([el("div", { class: "as-bubble ai" }, WELCOME)]), chips);
    chatLog.forEach((m) => thread.appendChild(bubbleFor(m)));

    /* ---- 入力バー ---- */
    const input = el("input", {
      class: "as-input",
      type: "text",
      placeholder: "質問を入力…(例:GPS打刻ができない)",
      "aria-label": "AIアシスタントへの質問",
      autocomplete: "off",
      onkeydown: (e) => { if (e.key === "Enter" && !e.isComposing) send(input.value); },
    });
    const sendBtn = el("button", {
      class: "as-send", "aria-label": "送信",
      onclick: () => send(input.value),
    }, icon("send", 17));

    async function send(raw) {
      const text = (raw || "").trim();
      if (!text || pending) return;
      pending = true;
      input.value = "";
      sendBtn.disabled = true;

      const um = { role: "user", text };
      chatLog.push(um);
      thread.appendChild(bubbleFor(um));
      const tRow = typingRow();
      thread.appendChild(tRow);
      scrollBottom();

      try {
        const r = await chatReply(text);
        chatLog.push({ role: "ai", text: r.text, source: r.source || null });
        if (thread.isConnected) {
          tRow.replaceWith(bubbleFor(chatLog[chatLog.length - 1]));
          scrollBottom();
        }
      } finally {
        pending = false;
        if (thread.isConnected) {
          if (tRow.isConnected) tRow.remove();
          sendBtn.disabled = false;
          input.focus();
        }
      }
    }

    const clearBtn = el("button", {
      class: "btn ghost sm",
      onclick: () => {
        if (!chatLog.length) return;
        chatLog = [];
        while (chips.nextSibling) chips.nextSibling.remove();
        toast("会話履歴をクリアしました", "info");
      },
    }, icon("trash", 13), "履歴をクリア");

    const chatCard = el("section", { class: "as-chat card" },
      el("div", { class: "as-chat-head" },
        el("span", { class: "as-head-ic", "aria-hidden": "true" }, fishMark(34, "wiggle")),
        el("div", { class: "as-head-meta" },
          el("div", { class: "as-head-title" }, "使い方アシスタント"),
          el("div", { class: "as-head-sub" }, "操作方法・社内ルール、何でも質問OK")),
        clearBtn),
      thread,
      el("div", { class: "as-inputbar" }, input, sendBtn));

    /* ================= FAQ(右カラム) ================= */

    const faqAll = store.get("faq");
    const faqList = el("div", { class: "as-faq-list" });
    const faqSearch = el("input", {
      class: "input as-faq-search",
      type: "search",
      placeholder: "FAQを検索(例:打刻・回数券)…",
      "aria-label": "FAQを検索",
      oninput: () => renderFaq(),
    });

    let openId = null;
    function renderFaq() {
      const q = faqSearch.value.trim().toLowerCase();
      const items = faqAll.filter((f) =>
        !q ||
        f.q.toLowerCase().includes(q) ||
        f.a.toLowerCase().includes(q) ||
        f.keywords.some((k) => k.toLowerCase().includes(q)));
      clear(faqList);
      if (!items.length) {
        faqList.appendChild(emptyState({
          icon: "🔍", title: "該当するFAQがありません",
          hint: "キーワードを変えるか、チャットで直接質問してください",
        }));
        return;
      }
      for (const f of items) {
        const isOpen = openId === f.id;
        faqList.appendChild(el("div", { class: `as-faq-item ${isOpen ? "open" : ""}` },
          el("button", {
            class: "as-faq-q", "aria-expanded": String(isOpen),
            onclick: () => { openId = isOpen ? null : f.id; renderFaq(); },
          },
            el("span", { class: "as-faq-qtext" }, f.q),
            el("span", { class: "as-faq-chev" }, icon("chevD", 15))),
          isOpen ? el("div", { class: "as-faq-a" },
            el("p", {}, f.a),
            el("button", {
              class: "btn soft sm mt-8",
              onclick: () => {
                send(f.q);
                chatCard.scrollIntoView({ behavior: "smooth", block: "start" });
              },
            }, icon("chat", 13), "この質問をチャットで聞く")) : null));
      }
    }
    renderFaq();

    const faqCard = el("aside", { class: "as-faq card" },
      el("div", { class: "card-title" },
        el("span", {}, "よくある質問",
          el("span", { class: "card-sub", style: { marginLeft: "8px" } }, `全${faqAll.length}件`))),
      el("div", { class: "as-faq-searchwrap" },
        el("span", { class: "sw-ic" }, icon("search", 15)),
        faqSearch),
      faqList);

    /* ================= 組み立て ================= */

    root.append(
      el("div", { class: "as-grid" }, chatCard, faqCard),
      el("p", { class: "as-foot" }, icon("info", 14),
        el("span", {}, "実運用では Claude API に接続し、操作マニュアル・就業規則・社内ナレッジを参照して回答します。答えられなかった質問は自動で FAQ に追加されます。")),
    );

    // 履歴がある状態で戻ってきたら最下部へ(アニメーションなし)
    if (chatLog.length) scrollBottom(false);
  },
};
