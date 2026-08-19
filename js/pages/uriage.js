/* ============================================================
   売上報告 — 毎日の業務
   店舗の代表者(その日の締め担当)が、締め後に本日の数字を報告する。
   全スタッフが投稿でき、投稿は全スタッフの「売上報告」タイムライン
   (社内SNS)にも表示される。
   入力項目: ①店舗(必須) ②売上(必須) ③来患数(必須) ④新患数(必須)
             ⑤キャンセル数(必須) ⑥消化率の写真(必須) ⑦報連相(自由)
   ============================================================ */
import {
  el, clear, icon, avatar, badge, card, sectionHeader, statTile, chip,
  emptyState, modal, toast, celebrate, relTime, fmtDate, fmtYen, fmtNum,
  fileToDataURL, openImageModal,
} from "../ui.js";
import { store, todayStr } from "../store.js";

function nowIso() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${todayStr()}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

const byDateDesc = (a, b) => (a.date < b.date ? 1 : -1);

/** 売上報告の投稿一覧(新しい順) */
export function uriageReports() {
  return store.get("posts").filter((p) => p.type === "uriage").sort(byDateDesc);
}

/** 本日のその店舗の報告(最新1件) */
export function todaysReportOf(storeId) {
  const t = todayStr();
  return uriageReports().find((p) => p.storeId === storeId && (p.date || "").startsWith(t)) || null;
}

/* ============================================================
   投稿モーダル(社内SNSの売上報告タブからも共用する)
   ============================================================ */
export function openUriageModal({ onSubmitted } = {}) {
  const me = store.me();

  const storeSel = el("select", { class: "select" },
    store.get("stores").map((s) => el("option", { value: s.id, selected: s.id === me.storeId }, s.name)));

  const numIn = (placeholder) => el("input", {
    class: "input", type: "number", min: "0", step: "1", inputmode: "numeric", placeholder,
  });
  const salesIn = numIn("例)186000");
  const patientsIn = numIn("例)24");
  const newIn = numIn("例)2");
  const cancelIn = numIn("例)1");
  const bodyTa = el("textarea", {
    class: "textarea", rows: 3,
    placeholder: "報告・連絡・相談があれば記入してください(例:夕方枠に空きが出たため、明日のLINE配信で埋めます)",
  });

  /* --- 消化率の写真(必須) --- */
  const photo = { image: null };
  const fileIn = el("input", { type: "file", accept: "image/*", style: { display: "none" } });
  const thumbs = el("div", { class: "attach-thumbs" });
  const pickBtn = el("button", { class: "btn ghost sm", type: "button", onclick: () => fileIn.click() },
    "📷 ", "写真を選ぶ・撮影する");
  const paintPhoto = () => {
    clear(thumbs);
    if (photo.image) {
      thumbs.appendChild(el("span", { class: "attach-thumb" },
        el("img", { src: photo.image, alt: "消化率の写真" }),
        el("button", {
          class: "at-del", type: "button", "aria-label": "写真を外す",
          onclick: () => { photo.image = null; paintPhoto(); },
        }, "×")));
    }
  };
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files?.[0];
    fileIn.value = "";
    if (!f) return;
    try { photo.image = await fileToDataURL(f); paintPhoto(); }
    catch (e) { toast("画像を読み込めませんでした", "error"); }
  });

  const field = (label, input, { required = false, hint = "" } = {}) => el("div", { class: "field" },
    el("label", {}, label, required ? el("span", { class: "ur-req" }, "必須") : null),
    input,
    hint ? el("span", { class: "hint" }, hint) : null);

  const reqNum = (input, label) => {
    if (String(input.value).trim() === "") { toast(`${label}を入力してください`, "error"); return null; }
    const v = Math.floor(Number(input.value));
    if (!Number.isFinite(v) || v < 0) { toast(`${label}は0以上の数値で入力してください`, "error"); return null; }
    return v;
  };

  const okBtn = el("button", { class: "btn primary" }, icon("send", 15), "売上報告を投稿する");
  const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
  const m = modal({
    title: "売上報告を投稿(毎日の業務)",
    body: el("div", { class: "page-uriage" },
      el("div", { class: "stack", style: { gap: "12px" } },
        el("div", { class: "ur-lead" },
          icon("info", 15),
          el("span", {}, "店舗の代表者(その日の締め担当)が投稿してください。投稿は全スタッフの「売上報告」タイムラインに表示されます。")),
        field("① 店舗", storeSel, { required: true }),
        el("div", { class: "form-row" },
          field("② 売上(円)", salesIn, { required: true }),
          field("③ 来患数(人)", patientsIn, { required: true })),
        el("div", { class: "form-row" },
          field("④ 新患数(人)", newIn, { required: true }),
          field("⑤ キャンセル数(件)", cancelIn, { required: true })),
        field("⑥ 写真①:消化率の写真",
          el("div", {},
            el("div", { class: "flex wrap", style: { gap: "8px", alignItems: "center" } }, pickBtn, fileIn),
            thumbs),
          { required: true, hint: "店内の消化率ボードなどをスマホで撮影して添付してください" }),
        field("⑦ 報連相", bodyTa, { hint: "自由記入。全員に共有したい報告・連絡・相談を残せます" }))),
    actions: [cancelBtn, okBtn],
  });
  cancelBtn.addEventListener("click", m.close);
  okBtn.addEventListener("click", () => {
    const sales = reqNum(salesIn, "② 売上");
    if (sales == null) return;
    const patients = reqNum(patientsIn, "③ 来患数");
    if (patients == null) return;
    const newPatients = reqNum(newIn, "④ 新患数");
    if (newPatients == null) return;
    const cancels = reqNum(cancelIn, "⑤ キャンセル数");
    if (cancels == null) return;
    if (!photo.image) { toast("⑥ 消化率の写真を添付してください", "error"); return; }

    store.addFirst("posts", {
      type: "uriage",
      authorId: me.id,
      storeId: storeSel.value,
      date: nowIso(),
      uriage: { sales, patients, newPatients, cancels },
      images: [photo.image],
      body: bodyTa.value.trim(),
      likes: [], comments: [], pinned: false,
    });
    m.close();
    celebrate(`${store.storeName(storeSel.value)}の売上報告を投稿しました!全スタッフのタイムラインに共有されます`);
    onSubmitted?.();
  });
}

/* ============================================================
   報告カード(このページ用の詳細表示)
   ============================================================ */
function statCell(label, value, cls = "") {
  return el("div", { class: `ur-stat ${cls}` },
    el("span", { class: "ur-stat-label" }, label),
    el("span", { class: "ur-stat-value" }, value));
}

function reportCard(p) {
  const author = store.byId("staff", p.authorId);
  const st = store.byId("stores", p.storeId);
  const u = p.uriage || {};
  return el("article", { class: "card ur-report" },
    el("header", { class: "ur-head" },
      el("span", { class: "ur-storedot", style: { background: st?.color || "var(--brand)" } }),
      el("span", { class: "ur-store" }, st?.name || "—"),
      badge("売上報告", "brand"),
      el("span", { class: "spacer" }),
      el("span", { class: "ur-when" }, `${fmtDate((p.date || "").slice(0, 10))} ${(p.date || "").slice(11, 16)}`)),
    el("div", { class: "ur-stats" },
      statCell("売上", fmtYen(u.sales), "big"),
      statCell("来患数", `${fmtNum(u.patients)}人`),
      statCell("新患数", `${fmtNum(u.newPatients)}人`),
      statCell("キャンセル", `${fmtNum(u.cancels)}件`)),
    el("div", { class: "ur-body" },
      (p.images || [])[0]
        ? el("button", {
            class: "ur-photo", "aria-label": "消化率の写真を拡大",
            onclick: () => openImageModal(p.images[0], `消化率の写真 — ${st?.name || ""}`),
          },
            el("img", { src: p.images[0], alt: "消化率の写真" }),
            el("span", { class: "ur-photo-cap" }, "📷 消化率の写真"))
        : null,
      el("div", { class: "ur-note" },
        el("div", { class: "ur-author" },
          avatar(author, 26),
          el("span", {},
            el("b", {}, author?.name || "—"),
            el("span", { class: "small muted" }, ` ・ ${relTime(p.date)}`))),
        p.body
          ? el("p", { class: "ur-horenso" }, el("span", { class: "ur-horenso-label" }, "報連相"), p.body)
          : el("p", { class: "small muted" }, "報連相の記入はありません"))));
}

/* ============================================================
   ページ本体
   ============================================================ */
export default {
  id: "uriage",
  title: "売上報告",
  icon: "trend",

  render(root) {
    const state = { storeId: "all" };

    function draw() {
      clear(root);
      const today = todayStr();
      const reports = uriageReports();
      const todays = reports.filter((p) => (p.date || "").startsWith(today));

      root.appendChild(sectionHeader(
        "売上報告",
        "店舗の代表者が締め後に報告します。投稿は全スタッフの「売上報告」タイムラインに表示されます。",
        [el("button", { class: "btn primary", onclick: () => openUriageModal({ onSubmitted: draw }) },
          icon("plus", 16), "売上報告を投稿")],
      ));

      // --- 本日の集計タイル ---
      const sum = (k) => todays.reduce((a, p) => a + (p.uriage?.[k] || 0), 0);
      root.appendChild(el("div", { class: "kpi-row" },
        statTile({ label: "本日の報告済み店舗", value: `${new Set(todays.map((p) => p.storeId)).size}/${store.get("stores").length}店舗`, icon: "check", tone: "brand", sub: "全店舗の締め報告が目標です" }),
        statTile({ label: "本日の売上合計", value: fmtYen(sum("sales")), icon: "cash", tone: "accent", sub: "報告済み店舗の合計" }),
        statTile({ label: "本日の来患数", value: `${fmtNum(sum("patients"))}人`, icon: "users", tone: "good", sub: `新患 ${fmtNum(sum("newPatients"))}人` }),
        statTile({ label: "本日のキャンセル", value: `${fmtNum(sum("cancels"))}件`, icon: "alert", tone: sum("cancels") ? "warn" : "good", sub: "報告済み店舗の合計" })));

      // --- 本日の提出状況(店舗ごと) ---
      const rows = el("div", { class: "row-list" });
      for (const st of store.get("stores")) {
        const rep = todaysReportOf(st.id);
        rows.appendChild(el("div", { class: "row-item" },
          el("span", { class: "ur-storedot", style: { background: st.color } }),
          el("span", { class: "row-main" },
            el("span", { class: "row-title" }, st.name),
            el("span", { class: "row-sub" },
              rep
                ? `${(rep.date || "").slice(11, 16)} に ${store.staffName(rep.authorId)} さんが報告(売上 ${fmtYen(rep.uriage?.sales)})`
                : "本日の報告はまだありません")),
          rep ? badge("報告済", "good") : badge("未報告", "warn")));
      }
      root.appendChild(card({
        title: "本日の提出状況",
        sub: `${fmtDate(today)}・店舗の代表者が締め後に投稿してください`,
        body: rows,
      }));

      // --- 店舗フィルタ + 報告フィード ---
      const chips = el("div", { class: "flex wrap", style: { gap: "6px", margin: "16px 0 12px" } },
        chip("全店", { on: state.storeId === "all", onClick: () => { state.storeId = "all"; draw(); } }),
        store.get("stores").map((s) => chip(s.short, {
          on: state.storeId === s.id,
          onClick: () => { state.storeId = s.id; draw(); },
        })));
      root.appendChild(chips);

      const feed = reports.filter((p) => state.storeId === "all" || p.storeId === state.storeId);
      root.appendChild(feed.length
        ? el("div", { class: "ur-feed" }, feed.slice(0, 20).map(reportCard))
        : el("div", { class: "card" },
            emptyState({ icon: "📊", title: "まだ売上報告がありません", hint: "「売上報告を投稿」から本日の数字を共有しましょう" })));
    }

    draw();
  },
};
