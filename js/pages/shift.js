/* シフト管理 ページ(スタブ — ビルドエージェントが実装で置き換える) */
import { el, emptyState } from "../ui.js";

export default {
  id: "shift",
  title: "シフト管理",
  icon: "calendar",
  render(root) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🚧", title: "シフト管理 は準備中です", hint: "このモジュールは現在実装中です" })));
  },
};
