/* AIアシスタント ページ(スタブ — ビルドエージェントが実装で置き換える) */
import { el, emptyState } from "../ui.js";

export default {
  id: "assistant",
  title: "AIアシスタント",
  icon: "sparkle",
  render(root) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🚧", title: "AIアシスタント は準備中です", hint: "このモジュールは現在実装中です" })));
  },
};
