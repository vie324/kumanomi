/* 日報 ページ(スタブ — ビルドエージェントが実装で置き換える) */
import { el, emptyState } from "../ui.js";

export default {
  id: "nippo",
  title: "日報",
  icon: "report",
  render(root) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🚧", title: "日報 は準備中です", hint: "このモジュールは現在実装中です" })));
  },
};
