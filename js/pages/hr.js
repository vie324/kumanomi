/* 人事管理 ページ(スタブ — 実装で置き換える) */
import { el, emptyState } from "../ui.js";

export default {
  id: "hr",
  title: "人事管理",
  icon: "clipboard",
  render(root) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🚧", title: "人事管理 は準備中です", hint: "このモジュールは現在実装中です" })));
  },
};
