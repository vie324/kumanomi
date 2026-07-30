/* 会議・議事録 ページ(スタブ — ビルドエージェントが実装で置き換える) */
import { el, emptyState } from "../ui.js";

export default {
  id: "meetings",
  title: "会議・議事録",
  icon: "clipboard",
  render(root) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🚧", title: "会議・議事録 は準備中です", hint: "このモジュールは現在実装中です" })));
  },
};
