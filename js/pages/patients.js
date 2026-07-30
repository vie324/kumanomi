/* 顧客・カルテ ページ(スタブ — ビルドエージェントが実装で置き換える) */
import { el, emptyState } from "../ui.js";

export default {
  id: "patients",
  title: "顧客・カルテ",
  icon: "users",
  render(root) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🚧", title: "顧客・カルテ は準備中です", hint: "このモジュールは現在実装中です" })));
  },
};
