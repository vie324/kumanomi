/* ============================================================
   メンバーの手入力フォーム(追加・編集・異動・退職・委員会の任命)

   使えるのは「統括院長より上」(マネージャー / 統括マネージャー / 社長)と本部人事。
   所属(主所属・追加所属・委員会)を変えると、チャットのルームが自動で入れ替わる
   (デモ:js/rooms.js、本番:Supabase のトリガ)。
   ============================================================ */

import { el, clear, icon, avatar, badge, modal, confirmDialog, toast } from "./ui.js";
import { store, todayStr } from "./store.js";
import { RANKS, rankOf, rankLevel, can, subtreeIds } from "./auth.js";
import { syncAutoRooms, committeeList, committeeLabel } from "./rooms.js";

const RANK_ORDER = ["staff", "mentor", "manager", "chief", "area", "exec", "hr", "clerk", "ceo"];
const ROLE_SUGGEST = ["スタッフ", "柔道整復師", "鍼灸師", "整体師", "エステティシャン", "受付", "院長", "店長", "統括院長", "マネージャー", "統括マネージャー", "本部人事", "事務職員", "社長"];
const COLORS = ["#0c7489", "#c2547e", "#4a3aa7", "#b0771a", "#1f7a4d", "#d95926", "#2a78d6", "#a83a52", "#3d4f6b", "#7b5cc4", "#0f8f7a", "#c46a1f"];

/** 自分より上のランクは付けられない(社長は誰でも。本部人事は統括MGまで) */
function rankAssignable(me, rank) {
  if (rankOf(me) === "ceo") return true;
  if (rank === "ceo") return false;
  const ceiling = rankOf(me) === "hr" ? 6 : rankLevel(me);
  return (RANKS[rank]?.level ?? 1) <= ceiling;
}

/** 次の社員番号の候補(数字の最大+1) */
function nextEmployeeNo() {
  const nums = (store.get("staff") || [])
    .map((s) => Number(s.empCode))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? String(Math.max(...nums) + 1) : "1";
}

/**
 * @param {object} opts
 * @param {object|null} opts.existing  編集するメンバー(null なら追加)
 * @param {(member:object)=>void} [opts.onSaved]
 */
export function openMemberForm({ existing = null, onSaved } = {}) {
  const me = store.me();
  if (!can("members.manage")) {
    toast("メンバーの追加・編集はマネージャー以上と本部人事が行えます", "error");
    return null;
  }
  const live = (store.state.seedMode || "demo") === "live";
  const stores = (store.get("stores") || []).filter((s) => s.isActive !== false);
  const staff = (store.get("staff") || []);

  /* ---- 入力欄 ---- */
  const nameIn = el("input", { class: "input", placeholder: "例)山田 花子(姓と名の間にスペース)", autocomplete: "off" });
  nameIn.value = existing?.name || "";
  const kanaIn = el("input", { class: "input", placeholder: "例)やまだ はなこ", autocomplete: "off" });
  kanaIn.value = existing?.kana || "";
  const noIn = el("input", { class: "input", placeholder: "例)372", inputmode: "numeric", autocomplete: "off" });
  noIn.value = existing?.empCode || nextEmployeeNo();
  const roleIn = el("input", { class: "input", list: "mf-roles", placeholder: "例)柔道整復師", autocomplete: "off" });
  roleIn.value = existing?.role || "スタッフ";
  const roleList = el("datalist", { id: "mf-roles" }, ROLE_SUGGEST.map((r) => el("option", { value: r })));

  const rankSel = el("select", { class: "select" },
    RANK_ORDER.map((r) => el("option", {
      value: r, selected: r === (existing?.rank || "staff"), disabled: !rankAssignable(me, r),
    }, `${RANKS[r].label}${rankAssignable(me, r) ? "" : "(付与できません)"}`)));

  const storeSel = el("select", { class: "select" },
    el("option", { value: "" }, "—(本部など、店舗なし)"),
    stores.map((s) => el("option", { value: s.id, selected: s.id === (existing?.storeId || (stores[0]?.id ?? "")) }, s.name)));

  const extraStores = new Set(existing?.storeIds || []);
  const extraWrap = el("div", { class: "mf-chips" });
  const paintExtra = () => {
    clear(extraWrap);
    for (const s of stores) {
      if (s.id === storeSel.value) continue;
      extraWrap.appendChild(el("button", {
        class: `chip ${extraStores.has(s.id) ? "on" : ""}`, type: "button",
        onclick: () => { extraStores.has(s.id) ? extraStores.delete(s.id) : extraStores.add(s.id); paintExtra(); },
      }, s.short || s.name));
    }
    if (!extraWrap.children.length) extraWrap.appendChild(el("span", { class: "small muted" }, "他の店舗はありません"));
  };
  storeSel.addEventListener("change", () => { extraStores.delete(storeSel.value); paintExtra(); });
  paintExtra();

  /* ---- 委員会:固定の6つからプルダウンで選んで任命(複数可) ---- */
  const committeeIds = new Set(existing?.committeeIds || []);
  const cmSel = el("select", { class: "select mf-cmsel", "aria-label": "委員会を選ぶ" });
  const cmAdd = el("button", { class: "btn soft sm", type: "button" }, icon("plus", 13), "任命する");
  const cmTags = el("div", { class: "mf-chips mf-cmtags" });
  const paintCommittees = () => {
    const list = committeeList();
    clear(cmSel).append(
      el("option", { value: "" }, "委員会を選ぶ…"),
      ...list.filter((c) => !committeeIds.has(c.id)).map((c) => el("option", { value: c.id }, `${c.icon || "🗂"} ${c.name}`)));
    cmSel.disabled = list.every((c) => committeeIds.has(c.id));
    cmAdd.disabled = cmSel.disabled;
    clear(cmTags);
    if (!committeeIds.size) cmTags.appendChild(el("span", { class: "small muted" }, "任命なし"));
    for (const id of committeeIds) {
      cmTags.appendChild(el("span", { class: "chip on mf-tag" },
        committeeLabel(id),
        el("button", { class: "mf-tag-x", type: "button", "aria-label": "外す", onclick: () => { committeeIds.delete(id); paintCommittees(); } }, "×")));
    }
  };
  cmAdd.addEventListener("click", () => {
    const id = cmSel.value;
    if (!id) { toast("委員会を選んでください", "info"); return; }
    committeeIds.add(id);
    paintCommittees();
  });
  cmSel.addEventListener("change", () => { if (cmSel.value) cmAdd.click(); });
  paintCommittees();

  // 上司:自分の配下(や本人)を上司にはできない
  const forbidden = new Set(existing ? [existing.id, ...subtreeIds(existing.id)] : []);
  const bossCandidates = staff
    .filter((s) => s.isActive !== false && !forbidden.has(s.id))
    .sort((a, b) => rankLevel(b) - rankLevel(a) || a.name.localeCompare(b.name, "ja"));
  const bossSel = el("select", { class: "select" },
    el("option", { value: "" }, "—(上司なし)"),
    bossCandidates.map((s) => el("option", { value: s.id, selected: s.id === (existing?.reportsTo || "") },
      `${s.name}(${RANKS[rankOf(s)]?.label || ""}・${store.storeName(s.storeId)})`)));

  const joinedIn = el("input", { class: "input", type: "date", value: existing?.joined || todayStr() });
  const emailIn = el("input", { class: "input", type: "email", placeholder: "例)hanako@kumanomi.co.jp", autocomplete: "off" });
  emailIn.value = existing?.email || "";

  const activeCb = el("input", { type: "checkbox", checked: existing ? existing.isActive !== false : true });

  /* ---- 保存 ---- */
  const collect = () => ({
    name: nameIn.value.trim(),
    kana: kanaIn.value.trim(),
    empCode: noIn.value.trim(),
    role: roleIn.value.trim() || "スタッフ",
    rank: rankSel.value,
    storeId: storeSel.value || null,
    storeIds: [...extraStores],
    committeeIds: [...committeeIds],
    reportsTo: bossSel.value || null,
    joined: joinedIn.value || null,
    email: emailIn.value.trim(),
    isActive: activeCb.checked,
  });

  const validate = (d) => {
    if (!d.name) return "氏名を入力してください";
    if (!d.empCode) return "社員番号を入力してください";
    if (staff.some((s) => s.id !== existing?.id && String(s.empCode) === d.empCode)) return `社員番号 ${d.empCode} はすでに使われています`;
    if (!rankAssignable(me, d.rank)) return "自分より上のランクは付けられません";
    if (existing && d.reportsTo === existing.id) return "自分自身を上司にはできません";
    return null;
  };

  const save = async () => {
    const d = collect();
    const err = validate(d);
    if (err) { toast(err, "error"); return; }

    if (existing) {
      // store.update は同じオブジェクトを書き換えるので、変更前の値を先に控える
      const before = { storeId: existing.storeId, reportsTo: existing.reportsTo || null, isActive: existing.isActive, name: existing.name };
      const moved = before.storeId !== d.storeId;
      const bossChanged = before.reportsTo !== (d.reportsTo || null);
      const retired = before.isActive !== false && !d.isActive;
      if (retired) {
        const ok = await confirmDialog({
          title: "退職にする",
          message: `${existing.name}さんを退職(在籍なし)にします。すべてのチャットルームから外れ、名簿では退職者として扱われます。記録は残ります。`,
          okLabel: "退職にする", danger: true,
        });
        if (!ok) return;
      }
      store.update("staff", existing.id, d);
      if (moved || bossChanged) {
        store.addFirst("orgChangeLog", {
          date: todayStr(), staffId: existing.id, fromId: before.reportsTo, toId: d.reportsTo || null,
          by: me.id,
          note: [moved ? `${store.storeName(before.storeId)} → ${store.storeName(d.storeId)} へ異動` : null,
                 bossChanged ? "上司を変更" : null].filter(Boolean).join("・"),
        });
      }
      syncAutoRooms();
      m.close();
      toast(retired ? `${before.name}さんを退職にしました` : moved ? `${d.name}さんを${store.storeName(d.storeId)}へ異動しました(チャットのルームも入れ替わります)` : "メンバー情報を更新しました");
      onSaved?.(store.byId("staff", existing.id));
      return;
    }

    // 追加。本番は社員番号がそのまま id(サーバーの行と一致する)
    const id = live ? d.empCode : store.uid("s");
    const member = store.add("staff", {
      id, ...d,
      color: COLORS[staff.length % COLORS.length],
      licenses: [], skills: {}, points: 0, photoUrl: null, sortOrder: staff.length + 1,
    });
    syncAutoRooms();
    m.close();
    const rooms = [store.storeName(d.storeId), ...d.committeeIds.map((c) => committeeLabel(c))].filter((x) => x && x !== "—");
    toast(`${d.name}さんを追加しました${rooms.length ? `(チャット:全社・${rooms.join("・")}に自動参加)` : ""}`);
    onSaved?.(member);
  };

  const saveBtn = el("button", { class: "btn primary", onclick: save }, icon("check", 15), existing ? "保存する" : "メンバーを追加");
  const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
  const m = modal({
    title: existing ? `メンバーを編集 — ${existing.name}` : "メンバーを追加(手入力)",
    wide: true,
    body: el("div", { class: "mf-form" },
      existing ? el("div", { class: "mf-head" }, avatar(existing, 40),
        el("span", {}, el("b", {}, existing.name), el("span", { class: "small muted" }, ` 社員番号 ${existing.empCode || existing.id}`)),
        existing.isActive === false ? badge("退職", "critical") : badge("在籍", "good")) : null,
      el("div", { class: "form-row" },
        el("div", { class: "field", style: { flex: "2" } }, el("label", {}, "氏名"), nameIn),
        el("div", { class: "field", style: { flex: "2" } }, el("label", {}, "かな"), kanaIn),
        el("div", { class: "field" }, el("label", {}, "社員番号"), noIn)),
      roleList,
      el("div", { class: "form-row" },
        el("div", { class: "field" }, el("label", {}, "役職(呼称)"), roleIn),
        el("div", { class: "field" }, el("label", {}, "権限ランク"), rankSel)),
      el("div", { class: "form-row" },
        el("div", { class: "field" }, el("label", {}, "主な所属店舗"), storeSel),
        el("div", { class: "field" }, el("label", {}, "上司(組織図の傘)"), bossSel)),
      el("div", { class: "field" }, el("label", {}, "追加所属(兼務する店舗。複数可)"), extraWrap),
      el("div", { class: "field" }, el("label", {}, "委員会(プルダウンから選んで任命。複数可)"),
        el("div", { class: "mf-cmrow" }, cmSel, cmAdd),
        cmTags),
      el("div", { class: "form-row" },
        el("div", { class: "field" }, el("label", {}, "入社日"), joinedIn),
        el("div", { class: "field" }, el("label", {}, "メールアドレス(ログイン用)"), emailIn)),
      existing ? el("label", { class: "mf-check" }, activeCb, "在籍中(外すと退職扱いになり、すべてのチャットルームから外れます)") : null,
      el("p", { class: "small muted mf-note" },
        "所属店舗と委員会を保存すると、それぞれのチャットルームに自動で参加します。異動すると前の店舗のルームからは外れます。全社ルームには在籍中ずっと参加します。",
        live ? " ログインは、メールアドレスで Supabase Authentication のユーザーを作って紐付けると使えるようになります(管理者向け手順を参照)。" : "")),
    actions: [cancelBtn, saveBtn],
  });
  cancelBtn.addEventListener("click", () => m.close());
  setTimeout(() => nameIn.focus(), 50);
  return m;
}
