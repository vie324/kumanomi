/* ごほうび交換 ページ(スタブ — 実装で置き換える) */
import { el, emptyState } from "../ui.js";

export default {
  id: "rewards",
  title: "ごほうび交換",
  icon: "medal",
  render(root) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🚧", title: "ごほうび交換 は準備中です", hint: "このモジュールは現在実装中です" })));
  },
};
