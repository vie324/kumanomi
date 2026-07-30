/* ダッシュボード ページ(スタブ — ビルドエージェントが実装で置き換える) */
import { el, emptyState } from "../ui.js";

export default {
  id: "dashboard",
  title: "ダッシュボード",
  icon: "home",
  render(root) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🚧", title: "ダッシュボード は準備中です", hint: "このモジュールは現在実装中です" })));
  },
};
