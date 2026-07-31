/* チャット ページ(スタブ — 実装で置き換える) */
import { el, emptyState } from "../ui.js";

export default {
  id: "chat",
  title: "チャット",
  icon: "chat",
  render(root) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🚧", title: "チャット は準備中です", hint: "このモジュールは現在実装中です" })));
  },
};
