/* ============================================================
   在庫・経費(バックオフィス)ページ
   小口・在庫管理、レジ(mPOP)との連携
   タブ: 在庫 / 小口現金 / 経費申請 / レジ連携
   ============================================================ */
import { store, todayStr, addDays, monthOf } from "../store.js";
import {
  el, clear, icon, card, sectionHeader, statTile, badge, statusBadge,
  staffChip, table, tabs, chip, toast, modal, emptyState,
  fmtYen, fmtNum, fmtDate,
} from "../ui.js";
import { donut, barChart } from "../charts.js";

const CASH_STORE_ID = "st-narimasu";
const INV_CATS = ["備品", "消耗品", "施術材料", "衛生", "物販", "事務"];
const CAT_SERIES = { 備品: 1, 消耗品: 2, 施術材料: 3, 衛生: 4, 物販: 5, 事務: 7 };
const CASH_OUT_CATS = ["消耗品購入", "郵送費", "交通費", "清掃用品", "雑費", "飲料(来客用)"];
const CASH_IN_CATS = ["小口補充", "レジ釣銭戻し", "その他入金"];
const EXP_CATS = ["交通費", "書籍・学習", "会議費", "消耗品", "備品", "郵送費", "雑費"];

/* カテゴリバッジ(色ドット+ニュートラル地。系列色はドットのみに使用) */
function catBadge(cat) {
  const n = CAT_SERIES[cat] || 8;
  return el("span", { class: "badge" },
    el("span", { class: "badge-dot", style: { background: `var(--series-${n})` } }),
    cat);
}

/* 万円表記(チャート軸・ドーナツ中央用) */
const man = (v) => `${Math.round((Number(v) || 0) / 10000)}万`;

/* モーダル用フィールド */
function field(label, input, hint) {
  return el("div", { class: "field" },
    el("label", {}, label),
    input,
    hint ? el("span", { class: "hint" }, hint) : null);
}
function numInput(value, placeholder = "0") {
  return el("input", {
    class: "input", type: "number", min: "1", step: "1",
    value: value != null ? String(value) : "", placeholder, inputmode: "numeric",
  });
}
function selectInput(options, selected) {
  const s = el("select", { class: "select" });
  for (const o of options) s.appendChild(el("option", { value: o, selected: o === selected }, o));
  return s;
}

export default {
  id: "backoffice",
  title: "在庫・経費",
  icon: "box",

  render(root, params) {
    const me = store.me();
    const today = todayStr();
    const month = monthOf(today);

    const TABS = [
      { id: "inv", label: "在庫" },
      { id: "cash", label: "小口現金" },
      { id: "expense", label: "経費申請" },
      { id: "register", label: "レジ連携" },
    ];
    const state = {
      tab: TABS.some((t) => t.id === params?.[0]) ? params[0] : "inv",
      invCat: "全て",
      regDate: today,
    };

    const lowStockItems = () => store.get("inventory").filter((it) => it.stock < it.min);
    const pendingExpenses = () => store.get("expenses").filter((e) => e.status === "pending");

    /* ============================================================
       在庫タブ
       ============================================================ */
    function openOrderModal(item) {
      const suggested = Math.max(item.min * 2 - item.stock, 1);
      const qty = numInput(suggested);
      const okBtn = el("button", { class: "btn primary" }, icon("send", 15), "発注する");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: `発注 — ${item.name}`,
        body: el("div", { class: "stack", style: { gap: "12px" } },
          el("p", { class: "muted", style: { fontSize: "var(--fs-sm)", lineHeight: "1.7" } },
            `現在庫 ${fmtNum(item.stock)}${item.unit} / 発注点 ${fmtNum(item.min)}${item.unit}・発注先:${item.supplier}(単価 ${fmtYen(item.price)})`),
          field(`発注数量(${item.unit})`, qty, "推奨:発注点の2倍まで補充する数量を初期表示しています")),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      okBtn.addEventListener("click", () => {
        const n = Math.floor(Number(qty.value));
        if (!n || n <= 0) { toast("1以上の数量を入力してください", "error"); return; }
        store.update("inventory", item.id, { lastOrder: today });
        m.close();
        toast(`「${item.name}」を ${fmtNum(n)}${item.unit} 発注しました(発注先:${item.supplier})`);
        renderAll();
      });
    }

    function openReceiveModal(item) {
      const qty = numInput(Math.max(item.min * 2 - item.stock, 1));
      const okBtn = el("button", { class: "btn primary" }, icon("download", 15), "入荷を記録");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: `入荷 — ${item.name}`,
        body: el("div", { class: "stack", style: { gap: "12px" } },
          el("p", { class: "muted", style: { fontSize: "var(--fs-sm)", lineHeight: "1.7" } },
            `現在庫 ${fmtNum(item.stock)}${item.unit}。入荷数量を入力すると在庫数に加算されます。`),
          field(`入荷数量(${item.unit})`, qty)),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      okBtn.addEventListener("click", () => {
        const n = Math.floor(Number(qty.value));
        if (!n || n <= 0) { toast("1以上の数量を入力してください", "error"); return; }
        store.update("inventory", item.id, { stock: item.stock + n });
        m.close();
        toast(`「${item.name}」を ${fmtNum(n)}${item.unit} 入荷しました(在庫 ${fmtNum(item.stock)}${item.unit})`);
        renderAll();
      });
    }

    function renderInv(body) {
      const inv = store.get("inventory");
      const low = lowStockItems();
      const totalValue = inv.reduce((a, it) => a + it.stock * it.price, 0);

      // サマリータイル
      body.appendChild(el("div", { class: "grid cols-3 bo-tiles" },
        statTile({ label: "登録品目", value: `${inv.length}品目`, icon: "box", sub: "成増店の管理対象", tone: "brand" }),
        statTile({ label: "発注点割れ", value: `${low.length}品目`, icon: "alert", sub: low.length ? "早めの発注をおすすめします" : "すべて充足しています", tone: low.length ? "warn" : "good" }),
        statTile({ label: "在庫評価額", value: fmtYen(totalValue), icon: "cash", sub: "単価×在庫数の合計", tone: "accent" }),
      ));

      // 発注点割れアラート
      if (low.length) {
        body.appendChild(el("div", { class: "bo-alert" },
          el("div", { class: "bo-alert-head" },
            icon("alert", 17),
            `発注点割れの品目が ${low.length}件 あります`),
          el("div", { class: "bo-alert-items" },
            low.map((it) => el("div", { class: "bo-alert-item" },
              el("span", { class: "bo-alert-name" }, it.name),
              el("span", { class: "bo-alert-short" },
                `不足 ${fmtNum(it.min - it.stock)}${it.unit}`,
                el("span", { class: "bo-alert-detail" }, `(在庫 ${fmtNum(it.stock)} / 発注点 ${fmtNum(it.min)})`)),
              el("span", { class: "spacer" }),
              el("button", { class: "btn danger sm", onclick: () => openOrderModal(it) },
                icon("send", 13), "発注する"))))));
      }

      // カテゴリフィルタ + テーブル
      const rows = inv.filter((it) => state.invCat === "全て" || it.category === state.invCat);
      const chipsRow = el("div", { class: "flex wrap bo-chips" },
        ["全て", ...INV_CATS].map((c) => chip(c, {
          on: state.invCat === c,
          onClick: () => { state.invCat = c; renderAll(); },
        })));

      const columns = [
        { key: "name", label: "品名", render: (it) => el("span", { class: "bo-name" }, it.name) },
        { key: "category", label: "カテゴリ", render: (it) => catBadge(it.category) },
        {
          key: "stock", label: "在庫数 / 発注点", align: "right",
          render: (it) => el("span", { class: `bo-stock ${it.stock < it.min ? "low" : ""}` },
            it.stock < it.min ? icon("alert", 13) : null,
            el("b", {}, `${fmtNum(it.stock)}${it.unit}`),
            el("span", { class: "bo-stock-min" }, ` / ${fmtNum(it.min)}`)),
        },
        { key: "price", label: "単価", align: "right", render: (it) => el("span", { class: "mono-num" }, fmtYen(it.price)) },
        { key: "supplier", label: "仕入先" },
        { key: "lastOrder", label: "最終発注", render: (it) => el("span", { class: it.lastOrder === today ? "bo-today" : "" }, fmtDate(it.lastOrder)) },
        {
          key: "ops", label: "操作", align: "center",
          render: (it) => el("span", { class: "bo-ops" },
            el("button", { class: "btn soft sm", onclick: () => openOrderModal(it) }, icon("send", 13), "発注"),
            el("button", { class: "btn ghost sm", onclick: () => openReceiveModal(it) }, icon("download", 13), "入荷")),
        },
      ];

      body.appendChild(card({
        title: "在庫一覧",
        sub: `成増店・${state.invCat === "全て" ? "全カテゴリ" : state.invCat}(${rows.length}品目)`,
        body: el("div", {}, chipsRow, table({ columns, rows, empty: "該当する品目がありません" })),
      }));
    }

    /* ============================================================
       小口現金タブ
       ============================================================ */
    function cashBalance() {
      const book = store.get("cashbook");
      return book.length ? book[book.length - 1].balance : 0;
    }

    function openCashModal(type) {
      const isIn = type === "in";
      const amount = numInput(null, "例)3000");
      const cat = selectInput(isIn ? CASH_IN_CATS : CASH_OUT_CATS);
      const memo = el("input", { class: "input", type: "text", placeholder: isIn ? "例)本部より補充" : "例)ドラッグストアで購入" });
      const okBtn = el("button", { class: `btn ${isIn ? "primary" : "accent"}` }, icon("cash", 15), isIn ? "入金を記録" : "出金を記録");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: isIn ? "小口現金 — 入金" : "小口現金 — 出金",
        body: el("div", { class: "stack", style: { gap: "12px" } },
          el("p", { class: "muted", style: { fontSize: "var(--fs-sm)" } },
            `現在残高:${fmtYen(cashBalance())}(成増店)`),
          field("金額(円)", amount),
          field("カテゴリ", cat),
          field("メモ", memo, "任意。レシートの有無などを残せます")),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      okBtn.addEventListener("click", () => {
        const amt = Math.floor(Number(amount.value));
        if (!amt || amt <= 0) { toast("1円以上の金額を入力してください", "error"); return; }
        const prev = cashBalance();
        if (!isIn && amt > prev) { toast(`残高不足です(現在残高 ${fmtYen(prev)})`, "error"); return; }
        const balance = isIn ? prev + amt : prev - amt;
        store.add("cashbook", {
          date: today, storeId: CASH_STORE_ID,
          type, amount: amt,
          category: cat.value, memo: memo.value.trim(),
          by: me.id, balance,
        });
        m.close();
        toast(`${fmtYen(amt)} を${isIn ? "入金" : "出金"}しました(残高 ${fmtYen(balance)})`);
        renderAll();
      });
    }

    function renderCash(body) {
      const book = store.get("cashbook");
      const monthIn = book.filter((e) => e.type === "in" && monthOf(e.date) === month).reduce((a, e) => a + e.amount, 0);
      const monthOut = book.filter((e) => e.type === "out" && monthOf(e.date) === month).reduce((a, e) => a + e.amount, 0);

      // 残高カード
      const balCard = card({
        title: "現在残高",
        sub: "成増店・小口現金",
        class: "bo-balcard",
        body: el("div", { class: "stack", style: { gap: "12px" } },
          el("div", { class: "bo-balance" },
            el("span", { class: "hero-number" }, fmtYen(cashBalance())),
            el("span", { class: "bo-bal-sub" }, `最終記帳 ${book.length ? fmtDate(book[book.length - 1].date) : "—"}`)),
          el("div", { class: "flex wrap", style: { gap: "8px" } },
            el("button", { class: "btn primary", onclick: () => openCashModal("in") }, icon("arrowDown", 15), "入金"),
            el("button", { class: "btn accent", onclick: () => openCashModal("out") }, icon("arrowUp", 15), "出金")),
          el("div", { class: "bo-bal-month" },
            el("div", { class: "bo-bal-kv" },
              el("span", { class: "muted small" }, "今月の入金"),
              el("span", { class: "bo-bal-in" }, `+${fmtYen(monthIn)}`)),
            el("div", { class: "bo-bal-kv" },
              el("span", { class: "muted small" }, "今月の出金"),
              el("span", { class: "bo-bal-out" }, `−${fmtYen(monthOut)}`)))),
      });

      // 当月カテゴリ別支出ドーナツ
      const outs = book.filter((e) => e.type === "out" && monthOf(e.date) === month);
      const byCat = new Map();
      for (const e of outs) byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount);
      const items = [...byCat.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
      const donutCard = card({
        title: "当月のカテゴリ別支出",
        sub: `${Number(month.slice(5))}月・出金のみ`,
        body: items.length
          ? donut({ items, size: 170, centerLabel: "当月支出", centerValue: fmtYen(monthOut), fmt: fmtYen })
          : emptyState({ icon: "💰", title: "今月の出金はまだありません" }),
      });

      body.appendChild(el("div", { class: "grid cols-2 bo-cashgrid" }, balCard, donutCard));

      // 出納帳(新しい順 = 記帳順の逆)
      const rows = [...book].reverse();
      const columns = [
        { key: "date", label: "日付", render: (e) => fmtDate(e.date) },
        { key: "category", label: "カテゴリ", render: (e) => badge(e.category, e.type === "in" ? "good" : "") },
        { key: "memo", label: "メモ", render: (e) => el("span", { class: "bo-memo" }, e.memo || "—") },
        {
          key: "amount", label: "入金 / 出金", align: "right",
          render: (e) => el("span", { class: `bo-amount ${e.type}` },
            `${e.type === "in" ? "+" : "−"}${fmtYen(e.amount)}`),
        },
        { key: "balance", label: "残高", align: "right", render: (e) => el("span", { class: "mono-num", style: { fontWeight: "700" } }, fmtYen(e.balance)) },
      ];
      body.appendChild(card({
        title: "出納帳",
        sub: "新しい順・直近の記帳から表示",
        body: table({ columns, rows, empty: "記帳がありません" }),
      }));
    }

    /* ============================================================
       経費申請タブ
       ============================================================ */
    function openExpenseModal() {
      const amount = numInput(null, "例)1280");
      const cat = selectInput(EXP_CATS);
      const memo = el("input", { class: "input", type: "text", placeholder: "例)研修会場までの往復交通費" });
      const okBtn = el("button", { class: "btn primary" }, icon("send", 15), "申請する");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: "経費を申請",
        body: el("div", { class: "stack", style: { gap: "12px" } },
          el("p", { class: "muted", style: { fontSize: "var(--fs-sm)", lineHeight: "1.7" } },
            "承認されると給与と合わせて精算されます。申請状況はこの画面で確認できます。"),
          field("金額(円)", amount),
          field("カテゴリ", cat),
          field("メモ", memo, "用途がわかるように記入してください")),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      okBtn.addEventListener("click", () => {
        const amt = Math.floor(Number(amount.value));
        if (!amt || amt <= 0) { toast("1円以上の金額を入力してください", "error"); return; }
        store.add("expenses", {
          staffId: me.id, date: today,
          amount: amt, category: cat.value, memo: memo.value.trim(),
          status: "pending",
        });
        m.close();
        toast(`経費を申請しました(${fmtYen(amt)}・承認待ち)`);
        renderAll();
      });
    }

    function approveExpense(e) {
      store.update("expenses", e.id, { status: "approved", approvedBy: me.id });
      toast(`${store.staffName(e.staffId)}さんの経費(${fmtYen(e.amount)})を承認しました`);
      renderAll();
    }

    function openRejectModal(e) {
      const reason = el("input", { class: "input", type: "text", placeholder: "例)本部一括購入の対象のため" });
      const okBtn = el("button", { class: "btn danger" }, icon("x", 15), "却下する");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: `却下 — ${store.staffName(e.staffId)}さんの申請`,
        body: el("div", { class: "stack", style: { gap: "12px" } },
          el("p", { class: "muted", style: { fontSize: "var(--fs-sm)", lineHeight: "1.7" } },
            `${fmtDate(e.date)}・${e.category}・${fmtYen(e.amount)}「${e.memo || "メモなし"}」を却下します。理由は申請者に通知されます。`),
          field("却下理由", reason)),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      okBtn.addEventListener("click", () => {
        const r = reason.value.trim();
        if (!r) { toast("却下理由を入力してください", "error"); return; }
        store.update("expenses", e.id, { status: "rejected", rejectReason: r });
        m.close();
        toast("経費申請を却下しました", "info");
        renderAll();
      });
    }

    function renderExpense(body) {
      const exps = store.get("expenses");
      const pending = pendingExpenses();
      const monthAll = exps.filter((e) => monthOf(e.date) === month);
      const monthTotal = monthAll.reduce((a, e) => a + e.amount, 0);
      const monthApproved = monthAll.filter((e) => e.status === "approved").reduce((a, e) => a + e.amount, 0);

      body.appendChild(el("div", { class: "grid cols-3 bo-tiles" },
        statTile({ label: "承認待ち", value: `${pending.length}件`, icon: "clipboard", sub: pending.length ? "承認・却下の対応をお願いします" : "すべて処理済みです", tone: pending.length ? "warn" : "good" }),
        statTile({ label: "今月の申請額", value: fmtYen(monthTotal), icon: "report", sub: `${monthAll.length}件の申請`, tone: "brand" }),
        statTile({ label: "今月の承認済額", value: fmtYen(monthApproved), icon: "check", sub: "給与と合わせて精算", tone: "accent" }),
      ));

      const rows = [...exps].sort((a, b) => {
        const pa = a.status === "pending" ? 0 : 1;
        const pb = b.status === "pending" ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.date < b.date ? 1 : -1;
      });

      const columns = [
        { key: "staff", label: "申請者", render: (e) => staffChip(e.staffId) },
        { key: "date", label: "日付", render: (e) => fmtDate(e.date) },
        { key: "category", label: "カテゴリ", render: (e) => badge(e.category) },
        { key: "memo", label: "メモ", render: (e) => el("span", { class: "bo-memo" }, e.memo || "—") },
        { key: "amount", label: "金額", align: "right", render: (e) => el("span", { class: "mono-num", style: { fontWeight: "700" } }, fmtYen(e.amount)) },
        { key: "status", label: "ステータス", align: "center", render: (e) => statusBadge(e.status) },
        {
          key: "ops", label: "操作", align: "center",
          render: (e) => {
            if (e.status === "pending") {
              return el("span", { class: "bo-ops" },
                el("button", { class: "btn primary sm", onclick: () => approveExpense(e) }, icon("check", 13), "承認"),
                el("button", { class: "btn danger sm", onclick: () => openRejectModal(e) }, icon("x", 13), "却下"));
            }
            if (e.status === "approved") return el("span", { class: "small muted" }, `承認:${store.staffName(e.approvedBy)}`);
            if (e.status === "rejected") return el("span", { class: "small muted bo-reject-reason" }, e.rejectReason || "—");
            return el("span", { class: "muted" }, "—");
          },
        },
      ];

      body.appendChild(card({
        title: "申請一覧",
        sub: "承認待ちを先頭に表示",
        actions: el("button", { class: "btn primary sm", onclick: openExpenseModal }, icon("plus", 14), "経費を申請"),
        body: table({ columns, rows, empty: "経費申請はまだありません" }),
      }));
    }

    /* ============================================================
       レジ連携タブ
       ============================================================ */
    function renderRegister(body) {
      const sales = store.get("registerSales");
      const minDate = addDays(today, -14);

      // 同期説明カード
      const syncBtn = el("button", { class: "btn primary" }, icon("refresh", 16), "今すぐ同期");
      syncBtn.addEventListener("click", () => {
        if (syncBtn.disabled) return;
        syncBtn.disabled = true;
        clear(syncBtn);
        const sp = icon("refresh", 16);
        sp.classList.add("bo-spin");
        syncBtn.append(sp, "同期中…");
        setTimeout(() => {
          clear(syncBtn).append(icon("refresh", 16), "今すぐ同期");
          syncBtn.disabled = false;
          toast("同期済みです");
        }, 1500);
      });
      body.appendChild(el("div", { class: "bo-sync" },
        el("span", { class: "bo-sync-ic" }, icon("register", 22)),
        el("div", { class: "bo-sync-main" },
          el("div", { class: "bo-sync-title" }, "mPOP レジと毎晩 21:00 に自動同期(レジ締め作業は不要)"),
          el("div", { class: "bo-sync-desc" },
            "各店舗のレジ売上(現金・カード・QR)と取引数は自動で取り込まれます。日中の数字を確認したいときだけ手動同期をご利用ください。")),
        syncBtn));

      // 日付ナビ + 店舗別テーブル
      const dayRows = sales.filter((r) => r.date === state.regDate);
      const prevBtn = el("button", {
        class: "btn ghost sm", disabled: state.regDate <= minDate,
        onclick: () => { state.regDate = addDays(state.regDate, -1); renderAll(); },
      }, icon("chevL", 14), "前日");
      const nextBtn = el("button", {
        class: "btn ghost sm", disabled: state.regDate >= today,
        onclick: () => { state.regDate = addDays(state.regDate, 1); renderAll(); },
      }, "翌日", icon("chevR", 14));
      const dateNav = el("div", { class: "bo-datenav" },
        prevBtn,
        el("span", { class: "bo-datenav-date" },
          fmtDate(state.regDate),
          state.regDate === today ? badge("本日", "brand") : null),
        nextBtn);

      const dayTotal = dayRows.reduce((a, r) => a + r.total, 0);
      const columns = [
        { key: "store", label: "店舗", render: (r) => el("span", { class: "bo-name" }, store.storeName(r.storeId)) },
        { key: "cash", label: "現金", align: "right", render: (r) => el("span", { class: "mono-num" }, fmtYen(r.cash)) },
        { key: "card", label: "カード", align: "right", render: (r) => el("span", { class: "mono-num" }, fmtYen(r.card)) },
        { key: "qr", label: "QR", align: "right", render: (r) => el("span", { class: "mono-num" }, fmtYen(r.qr)) },
        { key: "total", label: "合計", align: "right", render: (r) => el("span", { class: "mono-num", style: { fontWeight: "800" } }, fmtYen(r.total)) },
        { key: "txCount", label: "取引数", align: "right", render: (r) => `${fmtNum(r.txCount)}件` },
        { key: "syncedAt", label: "同期時刻", align: "center", render: (r) => el("span", { class: "mono-num" }, r.syncedAt ? r.syncedAt.slice(11, 16) : "—") },
        { key: "synced", label: "状態", align: "center", render: (r) => r.synced ? badge("同期済", "good", true) : badge("未同期", "warn", true) },
      ];
      body.appendChild(card({
        title: "店舗別レジ売上",
        sub: dayRows.length ? `全${dayRows.length}店舗・合計 ${fmtYen(dayTotal)}` : "同期データなし",
        actions: dateNav,
        body: dayRows.length
          ? table({ columns, rows: dayRows })
          : emptyState({ icon: "🛎", title: "この日の同期データはありません", hint: "水曜日は定休日のためレジデータがありません" }),
      }));

      // 直近14日:支払方法構成ドーナツ + 日次売上バー
      const recent = sales.filter((r) => r.date >= addDays(today, -13));
      const sum = (k) => recent.reduce((a, r) => a + r[k], 0);
      const payItems = [
        { label: "現金", value: sum("cash") },
        { label: "カード", value: sum("card") },
        { label: "QR", value: sum("qr") },
      ];
      const payDonut = card({
        title: "支払方法の構成",
        sub: "直近14日・全店舗合計",
        body: donut({
          items: payItems, size: 170,
          centerLabel: "直近14日合計", centerValue: `${man(sum("total"))}円`,
          fmt: fmtYen,
        }),
      });

      const labels = [], values = [];
      for (let i = 13; i >= 0; i--) {
        const d = addDays(today, -i);
        labels.push(fmtDate(d, { withDow: false }));
        values.push(sales.filter((r) => r.date === d).reduce((a, r) => a + r.total, 0));
      }
      const salesBar = card({
        title: "日次売上合計",
        sub: "直近14日・全店舗(水曜定休)",
        body: barChart({
          series: [{ name: "売上合計", values }],
          labels, height: 220,
          yFmt: man,
        }),
      });
      body.appendChild(el("div", { class: "grid cols-2 bo-reggrid" }, payDonut, salesBar));
    }

    /* ============================================================
       レイアウト・タブ切替
       ============================================================ */
    const tabsWrap = el("div", {});
    const tabBody = el("div", { class: "stack bo-body" });

    function renderTabs() {
      const low = lowStockItems().length;
      const pend = pendingExpenses().length;
      const items = TABS.map((t) => ({
        ...t,
        badge: t.id === "inv" && low ? low : t.id === "expense" && pend ? pend : null,
      }));
      clear(tabsWrap).appendChild(tabs(items, state.tab, (id) => { state.tab = id; renderAll(); }));
    }

    function renderAll() {
      renderTabs();
      clear(tabBody);
      if (state.tab === "inv") renderInv(tabBody);
      else if (state.tab === "cash") renderCash(tabBody);
      else if (state.tab === "expense") renderExpense(tabBody);
      else renderRegister(tabBody);
    }

    root.append(
      sectionHeader(
        "在庫・経費",
        "小口現金・在庫・経費申請をひとつに。レジ(mPOP)の売上は毎晩自動で同期されます。",
        badge("mPOP 連携・成増店 先行導入", "accent"),
      ),
      tabsWrap,
      tabBody,
    );
    renderAll();
  },
};
