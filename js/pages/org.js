/* ============================================================
   組織図 — 管轄(傘)を視覚化し、ドラッグで付け替える
   ・社長→統括マネージャー→マネージャー→統括院長→院長/店長→スタッフ
   ・カードを役職者へドラッグ&ドロップすると reportsTo が変わり、
     日報などの「見える範囲」に即時反映される
   ・メンター関係はオーバーレイ表示(点線の傘)
   ============================================================ */

import { el, clear, icon, avatar, badge, toast, fmtDate, drawer, confirmDialog } from "../ui.js";
import { store, todayStr } from "../store.js";
import { directorTitle } from "../data.js";
import {
  can, rankOf, rankLabel, rankLevel,
  subtreeIds, directReports, isDescendant, chainOf,
  visibleStaff, managedStores, myMentees, scopeLabel,
} from "../auth.js";

/* ---- ページ内状態 ---- */
let showMentors = false;
let focusMode = false; // 自分の傘だけハイライト

function storeOf(person) { return store.byId("stores", person.storeId); }

/** ドロップ先にできるか(役職者のみ・自分自身/自分の配下は不可) */
function isValidTarget(draggedId, targetId) {
  if (!draggedId || draggedId === targetId) return false;
  const target = store.byId("staff", targetId);
  if (!target) return false;
  if (rankOf(target) === "hr") return false;          // 人事の下に現場は付けない
  if (rankLevel(target) < 3) return false;            // 役職者(院長/店長以上)のみ
  if (isDescendant(targetId, draggedId)) return false; // 自分の傘の下には移せない(循環)
  const dragged = store.byId("staff", draggedId);
  if (dragged && dragged.reportsTo === targetId) return false; // いまと同じ
  return true;
}

/** 付け替えを保存し、履歴を残す */
function reassign(staffId, toId, note = "") {
  const person = store.byId("staff", staffId);
  const fromId = person?.reportsTo || null;
  store.update("staff", staffId, { reportsTo: toId });
  store.addFirst("orgChangeLog", {
    date: todayStr(), staffId, fromId, toId,
    by: store.me().id, note,
  });
  toast(`${person.name}さんの上司を ${store.staffName(toId)}さんに変更しました(見える範囲に即時反映)`);
}

export default {
  id: "org",
  title: "組織図",
  icon: "org",

  // このページが必要とするデータ。ルーターがそろえてから render() を呼ぶ
  needs: ["orgChangeLog", "staff", "stores"],
  render(root) {
    const me = store.me();
    const editable = can("org.edit");
    let draggingId = null;

    let firstDraw = true;
    const draw = () => {
      const scrollEl = root.querySelector(".org-scroll");
      const sx = scrollEl?.scrollLeft ?? 0;
      clear(root);
      build();
      const ns = root.querySelector(".org-scroll");
      if (!ns) return;
      if (firstDraw) {
        firstDraw = false;
        // 初回はツリーの中央(社長の真下)へスクロール
        requestAnimationFrame(() => { ns.scrollLeft = (ns.scrollWidth - ns.clientWidth) / 2; });
      } else {
        ns.scrollLeft = sx;
      }
    };

    /* ================= カード ================= */
    function personCard(person) {
      const st = storeOf(person);
      const isDirector = ["院長", "店長"].includes(person.role);
      const subs = subtreeIds(person.id).length;
      const mentees = person.menteeIds?.length || 0;
      const isMe = person.id === me.id;
      const inMyUmbrella = isMe || isDescendant(person.id, me.id);

      const card = el("div", {
        class: [
          "org-card",
          `rk-${rankOf(person)}`,
          isMe ? "is-me" : "",
          focusMode && !inMyUmbrella ? "dim" : "",
        ].join(" "),
        dataset: { id: person.id },
        tabindex: "0",
        role: "button",
        "aria-label": `${person.name}(${person.role})の詳細`,
        onclick: () => openPersonDrawer(person.id),
      },
        el("div", { class: "oc-top" },
          avatar(person, 40),
          el("div", { class: "oc-meta" },
            el("span", { class: "oc-name" }, person.name, isMe ? badge("自分", "accent") : null),
            el("span", { class: "oc-role" }, person.role)),
        ),
        el("div", { class: "oc-tags" },
          isDirector && st ? el("span", { class: "oc-store" }, st.category === "美容・エステ" ? "💆 " : "🏥 ", st.name,
            el("i", { class: "oc-cat" }, st.category)) : null,
          subs > 0 ? el("span", { class: "oc-subs" }, icon("users", 11), `配下 ${subs}名`) : null,
          showMentors && mentees > 0 ? el("span", { class: "oc-mentor-tag" }, "🌱 メンティー", String(mentees), "名") : null,
          showMentors && person.mentorId ? el("span", { class: "oc-mentor-tag mentee" }, "🌱 ", `メンター:${store.staffName(person.mentorId).split(" ")[0]}`) : null,
        ),
      );

      // ---- ドラッグ&ドロップ(編集権限があるときだけ) ----
      if (editable && rankOf(person) !== "ceo") {
        card.draggable = true;
        card.addEventListener("dragstart", (e) => {
          draggingId = person.id;
          e.dataTransfer.setData("text/plain", person.id);
          e.dataTransfer.effectAllowed = "move";
          requestAnimationFrame(() => {
            root.querySelectorAll(".org-card").forEach((c) => {
              if (isValidTarget(person.id, c.dataset.id)) c.classList.add("can-drop");
            });
            card.classList.add("dragging");
          });
        });
        card.addEventListener("dragend", () => {
          draggingId = null;
          root.querySelectorAll(".org-card").forEach((c) => c.classList.remove("can-drop", "drop-hint", "dragging"));
        });
      }
      if (editable) {
        card.addEventListener("dragover", (e) => {
          if (isValidTarget(draggingId, person.id)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            card.classList.add("drop-hint");
          }
        });
        card.addEventListener("dragleave", () => card.classList.remove("drop-hint"));
        card.addEventListener("drop", (e) => {
          e.preventDefault();
          const did = e.dataTransfer.getData("text/plain") || draggingId;
          card.classList.remove("drop-hint");
          if (!isValidTarget(did, person.id)) return;
          reassign(did, person.id);
          draw();
        });
      }
      return card;
    }

    /* ================= ツリー(再帰) ================= */
    function treeNode(person) {
      const children = directReports(person.id)
        .sort((a, b) => rankLevel(b) - rankLevel(a) || a.id.localeCompare(b.id));
      return el("li", { class: "org-li" },
        personCard(person),
        children.length
          ? el("ul", { class: "org-ul" }, children.map(treeNode))
          : null);
    }

    /* ================= 詳細ドロワー ================= */
    function openPersonDrawer(staffId) {
      const p = store.byId("staff", staffId);
      if (!p) return;
      const st = storeOf(p);
      const chain = chainOf(staffId);
      const vis = visibleStaff(p).filter((s) => s.id !== p.id);
      const direct = directReports(staffId);
      const deeper = vis.filter((s) => !direct.some((d) => d.id === s.id) && isDescendant(s.id, p.id));
      const mentees = myMentees(p);
      const mStores = managedStores(p);

      const body = el("div", { class: "page-org org-drawer" },
        el("div", { class: "od-head" },
          avatar(p, 52),
          el("div", {},
            el("div", { class: "od-name" }, p.name),
            el("div", { class: "od-sub" }, `${st?.name || "—"}・${p.role}`),
            el("div", { class: "flex wrap", style: { gap: "5px", marginTop: "5px" } },
              badge(rankLabel(p), "brand"),
              st && ["院長", "店長"].includes(p.role) ? badge(`${st.category}の${directorTitle(st)}`, "accent") : null))),

        // 上司チェーン
        el("div", { class: "od-sec" },
          el("div", { class: "od-sec-title" }, "レポートライン"),
          chain.length
            ? el("div", { class: "od-chain" },
                el("span", { class: "od-chain-me" }, p.name.split(" ")[0]),
                chain.map((c) => el("span", { class: "od-chain-item" }, icon("chevR", 12), `${c.name.split(" ")[0]}(${c.role})`)))
            : el("p", { class: "muted small" }, "組織のトップです")),

        // 見える範囲
        el("div", { class: "od-sec" },
          el("div", { class: "od-sec-title" }, "この人が見える範囲(日報・情報)"),
          el("p", { class: "od-scope" }, icon("eye", 14), scopeLabel(p)),
          direct.length ? el("div", { class: "od-group" },
            el("span", { class: "od-glabel" }, `直属 ${direct.length}名`),
            el("div", { class: "od-chips" }, direct.map((s) => miniPerson(s)))) : null,
          deeper.length ? el("div", { class: "od-group" },
            el("span", { class: "od-glabel" }, `その配下 ${deeper.length}名`),
            el("div", { class: "od-chips" }, deeper.map((s) => miniPerson(s)))) : null,
          mentees.length ? el("div", { class: "od-group" },
            el("span", { class: "od-glabel" }, `🌱 メンティー ${mentees.length}名(組織とは別に閲覧可)`),
            el("div", { class: "od-chips" }, mentees.map((s) => miniPerson(s)))) : null,
          !direct.length && !deeper.length && !mentees.length
            ? el("p", { class: "muted small" }, "自分の記録のみ閲覧できます") : null),

        // 管轄店舗
        mStores.length && rankLevel(p) >= 3 && rankOf(p) !== "hr" ? el("div", { class: "od-sec" },
          el("div", { class: "od-sec-title" }, `管轄店舗(シフト編集・勤怠承認が可能)`),
          el("div", { class: "od-chips" }, mStores.map((sid) => {
            const s = store.byId("stores", sid);
            return el("span", { class: "od-store-chip" }, s?.category === "美容・エステ" ? "💆 " : "🏥 ", s?.name || sid, el("i", {}, s?.category || ""));
          }))) : null,

        // 上司の変更(モバイル/クリック派向けフォールバック)
        editable && rankOf(p) !== "ceo" ? el("div", { class: "od-sec" },
          el("div", { class: "od-sec-title" }, "上司(管轄)を変更"),
          bossSelector(p)) : null,
      );

      drawer({ title: "メンバー詳細", body });
    }

    function miniPerson(s) {
      return el("span", { class: "od-person", title: `${store.storeName(s.storeId)}・${s.role}` },
        avatar(s, 22), s.name.split(" ")[0]);
    }

    function bossSelector(p) {
      const candidates = store.get("staff").filter((s) => isValidTarget(p.id, s.id));
      const sel = el("select", { class: "select" },
        el("option", { value: "" }, "移動先の上司を選択…"),
        candidates.map((c) => el("option", { value: c.id }, `${c.name}(${c.role}・${store.storeName(c.storeId)})`)));
      const btn = el("button", { class: "btn primary sm", onclick: async () => {
        if (!sel.value) { toast("移動先を選択してください", "error"); return; }
        const ok = await confirmDialog({
          title: "管轄の変更",
          message: `${p.name}さん(とその配下)を ${store.staffName(sel.value)}さんの傘の下に移動します。日報などの見える範囲が即時に変わります。よろしいですか?`,
          okLabel: "移動する",
        });
        if (!ok) return;
        reassign(p.id, sel.value);
        document.querySelector(".drawer-scrim")?.click();
        draw();
      } }, "移動する");
      return el("div", { class: "od-move" }, sel, btn,
        el("p", { class: "small muted mt-8" }, "ドラッグ&ドロップでも同じ操作ができます(カードを役職者のカードへ重ねるだけ)。"));
    }

    /* ================= 変更履歴 ================= */
    function openLogDrawer() {
      const logs = [...store.get("orgChangeLog")].sort((a, b) => (a.date < b.date ? 1 : -1));
      const body = el("div", { class: "page-org" },
        logs.length ? el("div", { class: "og-log" }, logs.map((lg) => el("div", { class: "og-log-item" },
          el("div", { class: "og-log-top" },
            el("span", { class: "og-log-date" }, fmtDate(lg.date)),
            el("span", { class: "small muted" }, `実施:${store.staffName(lg.by)}`)),
          el("div", { class: "og-log-body" },
            el("b", {}, store.staffName(lg.staffId)),
            ` の上司を `,
            el("b", {}, lg.fromId ? store.staffName(lg.fromId) : "—"),
            " → ",
            el("b", {}, store.staffName(lg.toId)),
            " に変更"),
          lg.note ? el("div", { class: "small muted" }, `メモ:${lg.note}`) : null,
          editable && lg.fromId ? el("button", { class: "btn ghost sm mt-8", onclick: () => {
            reassign(lg.staffId, lg.fromId, "変更を元に戻す");
            document.querySelector(".drawer-scrim")?.click();
            draw();
            toast("変更を元に戻しました");
          } }, icon("refresh", 13), "この変更を元に戻す") : null,
        ))) : el("p", { class: "muted", style: { padding: "20px 0" } }, "まだ変更履歴はありません。"));
      drawer({ title: `組織変更の履歴(${logs.length}件)`, body });
    }

    /* ================= 構築 ================= */
    function build() {
      const all = store.get("staff");
      const roots = all.filter((s) => !s.reportsTo || !store.byId("staff", s.reportsTo));

      // ヘッダー
      root.appendChild(el("div", { class: "page-head" },
        el("div", {},
          el("h1", {}, "組織図"),
          el("div", { class: "page-desc" },
            "管轄は毎月変わります。カードを役職者へドラッグするだけで付け替えられ、日報・情報の見える範囲に即時反映されます。")),
        el("div", { class: "page-actions" },
          el("button", { class: "btn ghost", onclick: openLogDrawer }, icon("clipboard", 15), "変更履歴"),
        )));

      // 権限バー+表示オプション
      root.appendChild(el("div", { class: `org-perm ${editable ? "rw" : ""}` },
        el("span", { class: "org-perm-ic" }, icon(editable ? "edit" : "eye", 15)),
        el("span", { class: "org-perm-txt" },
          editable
            ? "ドラッグで管轄を変更できます(統括マネージャー以上・本部人事)"
            : "閲覧のみ — 管轄の変更は統括マネージャー以上が行えます",
          badge(rankLabel(me), "brand")),
        el("span", { class: "spacer" }),
        el("label", { class: "toggle" },
          el("input", { type: "checkbox", checked: showMentors || null, onchange: (e) => { showMentors = e.target.checked; draw(); } }),
          el("span", { class: "tg-track" }),
          el("span", { class: "tg-label" }, "🌱 メンター関係")),
        el("label", { class: "toggle" },
          el("input", { type: "checkbox", checked: focusMode || null, onchange: (e) => { focusMode = e.target.checked; draw(); } }),
          el("span", { class: "tg-track" }),
          el("span", { class: "tg-label" }, "自分の傘を強調")),
      ));

      // 凡例
      root.appendChild(el("div", { class: "org-legend" },
        legendItem("rk-ceo", "社長"),
        legendItem("rk-exec", "統括マネージャー"),
        legendItem("rk-area", "マネージャー"),
        legendItem("rk-chief", "統括院長"),
        legendItem("rk-manager", "院長・店長"),
        legendItem("rk-hr", "本部人事"),
        el("span", { class: "small muted", style: { marginLeft: "auto" } },
          "店舗の呼称:整骨・整体・鍼灸=院長 / 美容・エステ=店長"),
      ));

      // ツリー本体
      const tree = el("div", { class: "org-tree" },
        el("ul", { class: "org-ul org-root" }, roots
          .sort((a, b) => rankLevel(b) - rankLevel(a))
          .map(treeNode)));
      root.appendChild(el("div", { class: "card org-canvas" },
        el("div", { class: "org-scroll" }, tree)));

      // ヒント
      root.appendChild(el("div", { class: "org-hint" },
        icon("info", 14),
        el("span", {},
          "カードをクリックすると、その人が見える範囲(傘の中身)を確認できます。",
          editable ? " 例:山口 蓮さんを 大森 統括院長のカードへドラッグ → 浦和店の日報が大森さん・加藤マネージャーの傘に入ります。" : ""),
      ));
    }

    function legendItem(cls, label) {
      return el("span", { class: "org-lg" }, el("i", { class: `org-lg-sw ${cls}` }), label);
    }

    draw();
  },
};
