/* 在庫・経費 ページ(スタブ — ビルドエージェントが実装で置き換える) */
import { el, emptyState } from "../ui.js";

export default {
  id: "backoffice",
  title: "在庫・経費",
  icon: "box",
  render(root) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🚧", title: "在庫・経費 は準備中です", hint: "このモジュールは現在実装中です" })));
  },
};
