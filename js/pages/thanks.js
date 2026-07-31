/* サンクスギフト ページ(スタブ — 実装で置き換える) */
import { el, emptyState } from "../ui.js";

export default {
  id: "thanks",
  title: "サンクスギフト",
  icon: "gift",
  render(root) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🚧", title: "サンクスギフト は準備中です", hint: "このモジュールは現在実装中です" })));
  },
};
