/* ============================================================
   在庫・経費(バックオフィス)ページ
   小口・在庫管理、レジ(mPOP)との連携
   タブ: 在庫 / 小口現金 / 経費申請 / レジ連携
   ============================================================ */
import { store, todayStr, addDays, monthOf } from "../store.js";
import {
  el, clear, icon, card, sectionHeader, statTile, badge, statusBadge,
  staffChip, table, tabs, chip, toast, modal, confirmDialog, emptyState,
  fmtYen, fmtNum, fmtDate, fileToDataURL, openImageModal,
} from "../ui.js";
import { can, rankLabel } from "../auth.js";
import { donut, barChart } from "../charts.js";

const SURVEY_URL = "https://forms.gle/xjRUN51dF7Rj8vqs9";

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
      const noteIn = el("input", { class: "input", type: "text", placeholder: "例)発注点割れのため補充(任意)" });
      const okBtn = el("button", { class: "btn primary" }, icon("send", 15), "発注する");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: `発注 — ${item.name}`,
        body: el("div", { class: "stack", style: { gap: "12px" } },
          el("p", { class: "muted", style: { fontSize: "var(--fs-sm)", lineHeight: "1.7" } },
            `現在庫 ${fmtNum(item.stock)}${item.unit} / 発注点 ${fmtNum(item.min)}${item.unit}・発注先:${item.supplier}(単価 ${fmtYen(item.price)})`),
          field(`発注数量(${item.unit})`, qty, "推奨:発注点の2倍まで補充する数量を初期表示しています"),
          field("メモ", noteIn)),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      okBtn.addEventListener("click", () => {
        const n = Math.floor(Number(qty.value));
        if (!n || n <= 0) { toast("1以上の数量を入力してください", "error"); return; }
        // 発注履歴に記録する(給与確認ページの「発注」タブとCSV出力の元データになる)
        store.add("orders", {
          itemId: item.id, itemName: item.name,
          qty: n, unit: item.unit, unitPrice: item.price, amount: n * item.price,
          supplier: item.supplier, storeId: me.storeId, staffId: me.id,
          date: today, status: "ordered", note: noteIn.value.trim(),
        });
        store.update("inventory", item.id, { lastOrder: today });
        m.close();
        toast(`「${item.name}」を ${fmtNum(n)}${item.unit} 発注しました(発注先:${item.supplier}・${fmtYen(n * item.price)})`);
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
        // 入荷待ちの発注があれば「入荷済」にする(古い順に1件)
        const open = store.get("orders")
          .filter((o) => o.itemId === item.id && o.status === "ordered")
          .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
        if (open) store.update("orders", open.id, { status: "received", receivedAt: today });
        m.close();
        toast(`「${item.name}」を ${fmtNum(n)}${item.unit} 入荷しました(在庫 ${fmtNum(item.stock)}${item.unit})`);
        renderAll();
      });
    }

    /* ---- 品目の追加・編集(発注するものは今後も増えるため、ここで自由に登録できる) ---- */
    function openItemModal(item = null) {
      const isNew = !item;
      const nameIn = el("input", { class: "input", type: "text", placeholder: "例)フェイスタオル", value: item?.name || "" });
      const catSel = selectInput(INV_CATS, item?.category || INV_CATS[0]);
      const unitIn = el("input", { class: "input", type: "text", placeholder: "例)枚・箱・本", value: item?.unit || "" });
      const zeroNum = (v, ph) => el("input", {
        class: "input", type: "number", min: "0", step: "1", inputmode: "numeric",
        value: v != null ? String(v) : "", placeholder: ph,
      });
      const stockIn = zeroNum(item?.stock, "例)20");
      const minIn = zeroNum(item?.min, "例)10");
      const priceIn = zeroNum(item?.price, "例)380");
      const supplierIn = el("input", { class: "input", type: "text", placeholder: "例)白洋リネン", value: item?.supplier || "" });

      const okBtn = el("button", { class: "btn primary" }, icon("check", 15), isNew ? "品目を追加" : "保存する");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const delBtn = isNew ? null : el("button", { class: "btn danger" }, icon("trash", 14), "削除");

      const m = modal({
        title: isNew ? "発注品目を追加" : `品目を編集 — ${item.name}`,
        body: el("div", { class: "stack", style: { gap: "12px" } },
          el("p", { class: "muted", style: { fontSize: "var(--fs-sm)", lineHeight: "1.7" } },
            "発注するものは今後増えても、ここから自由に追加・編集できます。登録した品目は在庫一覧と発注アラートの対象になります。"),
          field("品名", nameIn),
          el("div", { class: "form-row" },
            field("カテゴリ", catSel),
            field("単位", unitIn, "枚・箱・本など数える単位")),
          el("div", { class: "form-row" },
            field("現在庫", stockIn),
            field("発注点", minIn, "在庫がこの数を下回るとアラートが出ます")),
          el("div", { class: "form-row" },
            field("単価(円)", priceIn),
            field("仕入先", supplierIn))),
        actions: [delBtn, cancelBtn, okBtn].filter(Boolean),
      });
      cancelBtn.addEventListener("click", m.close);
      okBtn.addEventListener("click", () => {
        const name = nameIn.value.trim();
        const unit = unitIn.value.trim();
        const supplier = supplierIn.value.trim();
        const stock = Math.floor(Number(stockIn.value));
        const min = Math.floor(Number(minIn.value));
        const price = Math.floor(Number(priceIn.value));
        if (!name) { toast("品名を入力してください", "error"); return; }
        if (!unit) { toast("単位を入力してください(枚・箱など)", "error"); return; }
        if (!Number.isFinite(stock) || stock < 0) { toast("現在庫は0以上で入力してください", "error"); return; }
        if (!Number.isFinite(min) || min < 0) { toast("発注点は0以上で入力してください", "error"); return; }
        if (!Number.isFinite(price) || price < 0) { toast("単価は0以上で入力してください", "error"); return; }
        const patch = { name, category: catSel.value, unit, stock, min, price, supplier: supplier || "未設定" };
        if (isNew) {
          store.add("inventory", { ...patch, lastOrder: null });
          toast(`品目「${name}」を追加しました`);
        } else {
          store.update("inventory", item.id, patch);
          toast(`品目「${name}」を更新しました`);
        }
        m.close();
        renderAll();
      });
      delBtn?.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: "品目の削除",
          message: `「${item.name}」を在庫一覧から削除します。発注履歴は残ります。よろしいですか?`,
          okLabel: "削除する", danger: true,
        });
        if (!ok) return;
        store.remove("inventory", item.id);
        m.close();
        toast(`品目「${item.name}」を削除しました`, "info");
        renderAll();
      });
    }

    function renderInv(body) {
      const inv = store.get("inventory");
      const low = lowStockItems();
      const totalValue = inv.reduce((a, it) => a + it.stock * it.price, 0);
      // 発注・入荷の操作は院長以上のみ。一般社員は閲覧のみ
      const canOrder = can("inventory.order");

      // サマリータイル
      body.appendChild(el("div", { class: "grid cols-3 bo-tiles" },
        statTile({ label: "登録品目", value: `${inv.length}品目`, icon: "box", sub: "成増店の管理対象", tone: "brand" }),
        statTile({ label: "発注点割れ", value: `${low.length}品目`, icon: "alert", sub: low.length ? "早めの発注をおすすめします" : "すべて充足しています", tone: low.length ? "warn" : "good" }),
        statTile({ label: "在庫評価額", value: fmtYen(totalValue), icon: "cash", sub: "単価×在庫数の合計", tone: "accent" }),
      ));

      if (!canOrder) {
        body.appendChild(el("div", { class: "bo-viewonly" },
          icon("eye", 15),
          el("span", {},
            el("strong", {}, "閲覧のみ:"),
            `在庫の発注・入荷は院長以上が行います(現在の権限:${rankLabel(me)})。必要な品があれば責任者へ連絡してください。`)));
      }

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
              canOrder
                ? el("button", { class: "btn danger sm", onclick: () => openOrderModal(it) },
                    icon("send", 13), "発注する")
                : badge("発注は院長以上", "warn"))))));
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
      ];
      if (canOrder) {
        columns.push({
          key: "ops", label: "操作", align: "center",
          render: (it) => el("span", { class: "bo-ops" },
            el("button", { class: "btn soft sm", onclick: () => openOrderModal(it) }, icon("send", 13), "発注"),
            el("button", { class: "btn ghost sm", onclick: () => openReceiveModal(it) }, icon("download", 13), "入荷"),
            el("button", { class: "icon-btn sm", title: "品目を編集", "aria-label": `${it.name} を編集`, onclick: () => openItemModal(it) }, icon("edit", 14))),
        });
      }

      body.appendChild(card({
        title: "在庫一覧",
        sub: `成増店・${state.invCat === "全て" ? "全カテゴリ" : state.invCat}(${rows.length}品目)${canOrder ? "・品目は追加・編集できます" : "・閲覧のみ"}`,
        actions: canOrder
          ? el("button", { class: "btn primary sm", onclick: () => openItemModal() }, icon("plus", 14), "品目を追加")
          : null,
        body: el("div", {}, chipsRow, table({ columns, rows, empty: "該当する品目がありません" })),
      }));

      // --- 発注履歴(発注操作が自動で記録される) ---
      const orders = [...store.get("orders")].sort((a, b) => (a.date < b.date ? 1 : -1));
      const orderCols = [
        { key: "date", label: "発注日", render: (o) => fmtDate(o.date) },
        { key: "item", label: "品目", render: (o) => el("span", { class: "bo-name" }, o.itemName) },
        { key: "qty", label: "数量", align: "right", render: (o) => `${fmtNum(o.qty)}${o.unit || ""}` },
        { key: "amount", label: "金額", align: "right", render: (o) => el("span", { class: "mono-num", style: { fontWeight: "700" } }, fmtYen(o.amount)) },
        { key: "supplier", label: "仕入先", render: (o) => o.supplier || "—" },
        { key: "staff", label: "発注者", render: (o) => staffChip(o.staffId, { size: 24, withRole: false }) },
        {
          key: "status", label: "状態", align: "center",
          render: (o) => o.status === "received" ? badge("入荷済", "good") : badge("入荷待ち", "warn"),
        },
      ];
      body.appendChild(card({
        title: "発注履歴",
        sub: `全${orders.length}件・「発注」ボタンの操作が自動で記録されます(給与確認ページからCSVで書き出せます)`,
        body: orders.length
          ? table({ columns: orderCols, rows: orders.slice(0, 12) })
          : emptyState({ icon: "📦", title: "発注履歴はまだありません" }),
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

    /** 領収書画像の添付フィールド(プレビュー・差し替え可) */
    function receiptField(label = "領収書画像") {
      const state2 = { image: null };
      const fileIn = el("input", { type: "file", accept: "image/*", style: { display: "none" } });
      const thumbs = el("div", { class: "attach-thumbs" });
      const pickBtn = el("button", { class: "btn ghost sm", type: "button", onclick: () => fileIn.click() },
        "📷 ", "画像を選ぶ・撮影する");
      const paint = () => {
        clear(thumbs);
        if (state2.image) {
          thumbs.appendChild(el("span", { class: "attach-thumb" },
            el("img", { src: state2.image, alt: "領収書" }),
            el("button", {
              class: "at-del", type: "button", "aria-label": "画像を外す",
              onclick: () => { state2.image = null; paint(); },
            }, "×")));
        }
      };
      fileIn.addEventListener("change", async () => {
        const f = fileIn.files?.[0];
        fileIn.value = "";
        if (!f) return;
        try { state2.image = await fileToDataURL(f); paint(); }
        catch (e) { toast("画像を読み込めませんでした", "error"); }
      });
      const node = el("div", { class: "field" },
        el("label", {}, label),
        el("div", { class: "flex wrap", style: { gap: "8px", alignItems: "center" } }, pickBtn, fileIn),
        thumbs,
        el("span", { class: "hint" }, "レシート・領収書をスマホで撮影してそのまま添付できます"));
      return { node, state: state2 };
    }

    function openExpenseModal() {
      const amount = numInput(null, "例)1280");
      const cat = selectInput(EXP_CATS.filter((c) => c !== "交通費"));
      const memo = el("input", { class: "input", type: "text", placeholder: "例)研修用の書籍代" });
      const receipt = receiptField();
      const okBtn = el("button", { class: "btn primary" }, icon("send", 15), "申請する");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: "経費を申請",
        body: el("div", { class: "stack", style: { gap: "12px" } },
          el("p", { class: "muted", style: { fontSize: "var(--fs-sm)", lineHeight: "1.7" } },
            "領収書の画像を添付して申請します。承認されると給与と合わせて精算されます。交通費は「交通費を申請」からお願いします。"),
          field("金額(円)", amount),
          field("カテゴリ", cat),
          field("メモ", memo, "用途がわかるように記入してください"),
          receipt.node),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      okBtn.addEventListener("click", () => {
        const amt = Math.floor(Number(amount.value));
        if (!amt || amt <= 0) { toast("1円以上の金額を入力してください", "error"); return; }
        if (!receipt.state.image) { toast("領収書の画像を添付してください", "error"); return; }
        store.add("expenses", {
          staffId: me.id, date: today,
          amount: amt, category: cat.value, memo: memo.value.trim(),
          receiptImage: receipt.state.image,
          status: "pending",
        });
        m.close();
        toast(`経費を申請しました(${fmtYen(amt)}・承認待ち)`);
        renderAll();
      });
    }

    /** 交通費の申請(画像+金額+区間+距離)。月1回まとめて申請する運用 */
    function openTransportModal() {
      const amount = numInput(null, "例)1280");
      const fromIn = el("input", { class: "input", type: "text", placeholder: "例)成増駅" });
      const toIn = el("input", { class: "input", type: "text", placeholder: "例)大宮駅" });
      const distIn = el("input", { class: "input", type: "number", min: "0", step: "0.1", inputmode: "decimal", placeholder: "例)28.4" });
      const memo = el("input", { class: "input", type: "text", placeholder: "例)8月分の研修移動まとめ(任意)" });
      const receipt = receiptField("領収書・経路の画像");
      const okBtn = el("button", { class: "btn primary" }, icon("send", 15), "交通費を申請する");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: "交通費を申請(月1回)",
        body: el("div", { class: "stack", style: { gap: "12px" } },
          el("p", { class: "muted", style: { fontSize: "var(--fs-sm)", lineHeight: "1.7" } },
            "交通費は月1回まとめて申請します。区間(どこからどこまで)・距離・金額と、領収書または経路の画像を添付してください。"),
          field("金額(円)", amount),
          el("div", { class: "form-row" },
            field("出発地(どこから)", fromIn),
            field("到着地(どこまで)", toIn)),
          field("距離(km)", distIn, "往復の場合は往復分の距離を入力してください"),
          field("メモ", memo),
          receipt.node),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      okBtn.addEventListener("click", () => {
        const amt = Math.floor(Number(amount.value));
        const from = fromIn.value.trim();
        const to = toIn.value.trim();
        const dist = Number(distIn.value);
        if (!amt || amt <= 0) { toast("1円以上の金額を入力してください", "error"); return; }
        if (!from || !to) { toast("区間(どこからどこまで)を入力してください", "error"); return; }
        if (!dist || dist <= 0) { toast("距離(km)を入力してください", "error"); return; }
        if (!receipt.state.image) { toast("領収書または経路の画像を添付してください", "error"); return; }
        store.add("expenses", {
          staffId: me.id, date: today,
          amount: amt, category: "交通費",
          memo: memo.value.trim(),
          routeFrom: from, routeTo: to, distanceKm: dist,
          receiptImage: receipt.state.image,
          status: "pending",
        });
        m.close();
        toast(`交通費を申請しました(${from}→${to}・${dist}km・${fmtYen(amt)})`);
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
      const canApprove = can("backoffice.approve");
      const myTransportThisMonth = monthAll.some((e) => e.staffId === me.id && e.category === "交通費");

      // 毎月のお願い(交通費の月1申請+1minuteアンケート)
      body.appendChild(el("div", { class: "bo-monthly" },
        el("span", { class: "bo-monthly-ic" }, "📌"),
        el("div", { class: "bo-monthly-main" },
          el("div", { class: "bo-monthly-title" }, `毎月のお願い(${Number(month.slice(5))}月分)`),
          el("div", { class: "bo-monthly-desc" },
            myTransportThisMonth
              ? "今月の交通費申請は提出済みです。"
              : "交通費は月1回、画像・金額・区間(どこからどこまで)・距離を付けてまとめて申請してください。",
            " あわせて月1回の1minuteアンケート(所要1分)にもご協力ください。")),
        el("div", { class: "bo-monthly-actions" },
          myTransportThisMonth ? badge("交通費 提出済", "good", true)
            : el("button", { class: "btn accent sm", onclick: openTransportModal }, "🚃 ", "交通費を申請"),
          el("a", { class: "btn ghost sm", href: SURVEY_URL, target: "_blank", rel: "noopener noreferrer" },
            "📝 ", "アンケートを開く"))));

      body.appendChild(el("div", { class: "grid cols-3 bo-tiles" },
        statTile({ label: "承認待ち", value: `${pending.length}件`, icon: "clipboard", sub: canApprove ? (pending.length ? "承認・却下の対応をお願いします" : "すべて処理済みです") : "承認は院長以上が行います", tone: pending.length ? "warn" : "good" }),
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
        { key: "category", label: "カテゴリ", render: (e) => badge(e.category, e.category === "交通費" ? "accent" : "") },
        {
          key: "memo", label: "内容", render: (e) => el("span", { class: "bo-memo" },
            e.routeFrom ? el("span", { class: "bo-route" },
              `${e.routeFrom} → ${e.routeTo}`,
              e.distanceKm ? el("span", { class: "bo-route-km" }, `(${e.distanceKm}km)`) : null) : null,
            e.memo ? el("span", { class: "bo-memo-text" }, e.memo) : (e.routeFrom ? null : "—")),
        },
        {
          key: "receipt", label: "領収書", align: "center",
          render: (e) => e.receiptImage
            ? el("button", {
                class: "bo-receipt", title: "領収書画像を見る",
                "aria-label": "領収書画像を見る",
                onclick: (ev) => { ev.stopPropagation(); openImageModal(e.receiptImage, `領収書 — ${store.staffName(e.staffId)}(${fmtDate(e.date)})`); },
              }, el("img", { src: e.receiptImage, alt: "領収書" }))
            : el("span", { class: "muted small" }, "なし"),
        },
        { key: "amount", label: "金額", align: "right", render: (e) => el("span", { class: "mono-num", style: { fontWeight: "700" } }, fmtYen(e.amount)) },
        { key: "status", label: "ステータス", align: "center", render: (e) => statusBadge(e.status) },
        {
          key: "ops", label: canApprove ? "操作" : "", align: "center",
          render: (e) => {
            if (e.status === "pending") {
              if (!canApprove) return el("span", { class: "small muted" }, "承認待ち");
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
        sub: "承認待ちを先頭に表示・領収書サムネイルをクリックで拡大",
        actions: el("span", { class: "bo-ops" },
          el("button", { class: "btn accent sm", onclick: openTransportModal }, "🚃 ", "交通費を申請"),
          el("button", { class: "btn primary sm", onclick: openExpenseModal }, icon("plus", 14), "経費を申請")),
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
