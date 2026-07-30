/* 社内SNS ページ(スタブ — ビルドエージェントが実装で置き換える) */
import { el, emptyState } from "../ui.js";

export default {
  id: "sns",
  title: "社内SNS",
  icon: "chat",
  render(root) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🚧", title: "社内SNS は準備中です", hint: "このモジュールは現在実装中です" })));
  },
};
