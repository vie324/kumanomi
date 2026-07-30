/* スタッフ管理 ページ(スタブ — ビルドエージェントが実装で置き換える) */
import { el, emptyState } from "../ui.js";

export default {
  id: "staff",
  title: "スタッフ管理",
  icon: "grad",
  render(root) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🚧", title: "スタッフ管理 は準備中です", hint: "このモジュールは現在実装中です" })));
  },
};
