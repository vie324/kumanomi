/* ============================================================
   顧客・カルテ — KUMANOMI の目玉ページ
   来患ノート廃止/カルテに写真/姿勢分析33ポイント自動/
   ボイス入力SOAP/AIで患者様へLINE送信/回数券デジタル化/離反リマインド
   ============================================================ */

import {
  el, clear, icon, card, sectionHeader, badge, chip, kv, meter,
  statTile, emptyState, toast, aiButton, aiPanel,
  avatar, staffChip, fmtDate, fmtYen,
} from "../ui.js";
import { store, todayStr } from "../store.js";
import {
  delay, sampleVoiceTranscript, voiceToSoap,
  kartePatientMessage, analyzePosture,
} from "../ai.js";

/* ---------------- ページ状態(再描画をまたいで保持) ---------------- */
const state = { q: "", filter: "all" };
let voiceIdx = 0;

/* ---------------- 共通ヘルパー ---------------- */

const GENDER = { F: "女性", M: "男性" };

const FILTERS = [
  { id: "all", label: "全員" },
  { id: "ticket", label: "回数券保有" },
  { id: "risk", label: "離反リスク" },
  { id: "line", label: "LINE連携済" },
];

const ticketOf = (p) => p.tickets?.[0] || null;
const ticketLeft = (p) => {
  const t = ticketOf(p);
  return t ? Math.max(t.total - t.used, 0) : null;
};

function karteOf(patientId) {
  return store.get("karte")
    .filter((k) => k.patientId === patientId)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1));
}

/** 今日から見て何日前か(未来なら負値) */
function daysSince(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [ty, tm, td] = todayStr().split("-").map(Number);
  return Math.round((new Date(ty, tm - 1, td) - new Date(y, m - 1, d)) / 86400000);
}

function churnBadge(risk) {
  if (risk === "high") return badge("離反リスク高", "critical", true);
  if (risk === "mid") return badge("要フォロー", "warn");
  return badge("定着", "good");
}

function lineBadge(p) {
  return p.lineLinked ? badge("LINE連携済", "good") : badge("LINE未連携", "warn");
}

/** 患者アバター(店舗カラー) */
function pAvatar(p, size = 36) {
  return avatar({ name: p.name, color: store.byId("stores", p.storeId)?.color }, size);
}

function matchesFilter(p, fid) {
  if (fid === "ticket") return !!ticketOf(p);
  if (fid === "risk") return p.churnRisk !== "low";
  if (fid === "line") return !!p.lineLinked;
  return true;
}

/* ---------------- LINE風プレビュー ---------------- */

function lineBubble(text) {
  return el("div", { class: "pt-line" },
    el("div", { class: "pt-line-head" }, icon("line", 14), "LINEプレビュー"),
    el("div", { class: "pt-line-body" },
      el("div", { class: "pt-line-bubble" }, text),
      el("div", { class: "pt-line-meta" }, "送信すると患者様のトーク画面に届きます")));
}

/** 離反リマインドの文面テンプレ(名前・最終来院日・回数券残を織り込む) */
function reminderMessage(p) {
  const t = ticketOf(p);
  const lines = [
    `${p.name}様`,
    "",
    `こんにちは!くまのみ整体院 ${store.storeName(p.storeId)}です🐠`,
    `前回のご来院(${fmtDate(p.lastVisit, { withYear: true })})から少しお時間が空きましたが、その後お身体の調子はいかがでしょうか?`,
  ];
  if (t) {
    lines.push("",
      `お持ちの「${t.name}」は残り${Math.max(t.total - t.used, 0)}回、有効期限は${fmtDate(t.expires, { withYear: true })}です。期限内にゆっくりお使いいただけるよう、お席をご用意してお待ちしています。`);
  }
  lines.push("",
    `${p.tags[0] || "お身体"}の状態は、施術の間隔が空くと戻りやすい時期です。下のボタンからご都合の良い日時をお選びください😊`,
    "",
    "▼ 空き状況を見る・予約する",
    "https://lin.ee/kumanomi-reserve");
  return lines.join("\n");
}

/* ============================================================
   一覧ビュー
   ============================================================ */

/* ---- 離反リスクカード ---- */
function riskCard() {
  const highs = store.get("patients").filter((p) => p.churnRisk === "high");
  if (!highs.length) return null;

  const panel = aiPanel("AIリマインド文面");
  panel.el.style.display = "none";

  const btn = aiButton("AIでリマインドLINE文面を作成", async () => {
    panel.el.style.display = "";
    panel.thinking("最終来院日と回数券の残数から文面を作成しています");
    await delay(1600);
    const wrap = el("div", { class: "stack", style: { gap: "16px" } });
    for (const p of highs) {
      const msg = reminderMessage(p);
      const send = el("button", { class: "btn primary sm" },
        icon("send", 13), p.lineLinked ? "LINEで送信" : "SMSで送信");
      send.addEventListener("click", () => {
        send.disabled = true;
        clear(send).append(icon("check", 13), "送信済み");
        toast(`${p.name}様へ送信しました(シミュレーション)`);
      });
      wrap.appendChild(el("div", { class: "pt-remind" },
        el("div", { class: "pt-remind-head" },
          el("span", { class: "pt-remind-name" },
            pAvatar(p, 22), `${p.name}様への文面`,
            p.lineLinked ? null : badge("LINE未連携", "warn")),
          send),
        lineBubble(msg)));
    }
    panel.setNode(wrap);
  });

  const rows = highs.map((p) => {
    const t = ticketOf(p);
    return el("button", {
      class: "pt-risk-row",
      onclick: () => { location.hash = `#/patients/${p.id}`; },
    },
      pAvatar(p, 34),
      el("span", { class: "pt-risk-main" },
        el("span", { class: "pt-risk-name" }, p.name),
        el("span", { class: "pt-risk-sub" },
          `最終来院 ${fmtDate(p.lastVisit)}(${daysSince(p.lastVisit)}日前)` +
          (t ? ` ・ 回数券 残${Math.max(t.total - t.used, 0)}回` : ""))),
      el("span", { class: "pt-risk-chev" }, icon("chevR", 15)));
  });

  return el("div", { class: "card pt-risk" },
    el("div", { class: "pt-risk-head" },
      el("span", { class: "pt-risk-ic" }, icon("alert", 19)),
      el("span", { class: "pt-risk-txt" },
        el("span", { class: "pt-risk-title" }, `離反リスクの高い患者様が${highs.length}名います`),
        el("span", { class: "pt-risk-desc" },
          "最終来院から35日以上が経過。回数券の期限が切れる前に、AIがひとりずつ文面を作ってリマインドできます。")),
      btn),
    el("div", { class: "pt-risk-list" }, rows),
    panel.el);
}

/* ---- 患者一覧の1行 ---- */
function patientRow(p) {
  const left = ticketLeft(p);
  return el("button", {
    class: "pt-row",
    onclick: () => { location.hash = `#/patients/${p.id}`; },
  },
    el("span", { class: "pt-cell-person" },
      pAvatar(p, 38),
      el("span", { class: "pt-person-txt" },
        el("span", { class: "pt-person-name" }, p.name),
        el("span", { class: "pt-person-kana" }, p.kana),
        el("span", { class: "pt-person-tags" }, p.tags.map((t) => el("i", {}, t))))),
    el("span", { class: "pt-cell pt-cell-age" }, `${p.age}歳・${GENDER[p.gender] || "—"}`),
    el("span", { class: "pt-cell pt-cell-visit" }, fmtDate(p.lastVisit)),
    left == null
      ? el("span", { class: "pt-cell pt-cell-ticket none" }, "—")
      : el("span", { class: `pt-cell pt-cell-ticket ${left <= 2 ? "low" : ""}` }, `残${left}回`),
    el("span", { class: "pt-cell pt-cell-risk" }, churnBadge(p.churnRisk)),
    el("span", { class: "pt-chev" }, icon("chevR", 16)));
}

function renderList(root) {
  const patients = store.get("patients");
  const nTicket = patients.filter((p) => ticketOf(p)).length;
  const nLine = patients.filter((p) => p.lineLinked).length;
  const nHigh = patients.filter((p) => p.churnRisk === "high").length;

  root.appendChild(sectionHeader("顧客・カルテ",
    "来患ノートは廃止。カルテ・写真・姿勢分析・回数券・LINE連携をここに一本化しました。"));

  root.appendChild(el("div", { class: "kpi-row" },
    statTile({ label: "登録患者数", value: `${patients.length}名`, icon: "users", tone: "brand", sub: "全店舗合計" }),
    statTile({ label: "回数券保有", value: `${nTicket}名`, icon: "ticket", tone: "accent", sub: "実物の券は廃止・デジタル化済み" }),
    statTile({ label: "LINE連携済", value: `${nLine}名`, icon: "line", tone: "good", sub: `連携率 ${Math.round((nLine / (patients.length || 1)) * 100)}%` }),
    statTile({ label: "離反リスク高", value: `${nHigh}名`, icon: "alert", tone: "warn", sub: "35日以上ご来院なし" })));

  const rc = riskCard();
  if (rc) root.appendChild(rc);

  /* ---- 検索 + フィルタ + 一覧 ---- */
  const subEl = el("span", { class: "card-sub", style: { marginLeft: "8px" } });
  const chipsRow = el("div", { class: "pt-chips" });
  const listWrap = el("div", { class: "pt-list" });

  const searchInput = el("input", {
    class: "pt-search-input", type: "search",
    placeholder: "名前・かな・タグで検索", value: state.q, "aria-label": "患者検索",
  });
  searchInput.addEventListener("input", () => { state.q = searchInput.value; update(); });

  const filtered = () => {
    const q = state.q.trim();
    let rows = patients.filter((p) => {
      if (q && !`${p.name} ${p.kana} ${p.tags.join(" ")}`.includes(q)) return false;
      return matchesFilter(p, state.filter);
    });
    const rank = { high: 0, mid: 1, low: 2 };
    rows = rows.slice().sort((a, b) =>
      state.filter === "risk"
        ? rank[a.churnRisk] - rank[b.churnRisk]
        : (a.lastVisit < b.lastVisit ? 1 : -1));
    return rows;
  };

  function update() {
    clear(chipsRow);
    for (const f of FILTERS) {
      const count = patients.filter((p) => matchesFilter(p, f.id)).length;
      chipsRow.appendChild(chip(`${f.label} ${count}`, {
        on: state.filter === f.id,
        onClick: () => { state.filter = f.id; update(); },
      }));
    }
    const rows = filtered();
    clear(subEl).append(`${rows.length}名`);
    clear(listWrap);
    if (!rows.length) {
      listWrap.appendChild(emptyState({
        icon: "🔍", title: "該当する患者様がいません", hint: "検索条件やフィルタを変更してください",
      }));
      return;
    }
    listWrap.appendChild(el("div", { class: "pt-rowhead" },
      el("span", {}, "患者様"), el("span", {}, "年齢・性別"), el("span", {}, "最終来院"),
      el("span", {}, "回数券残"), el("span", {}, "離反リスク"), el("span", {})));
    rows.forEach((p) => listWrap.appendChild(patientRow(p)));
  }
  update();

  root.appendChild(el("div", { class: "card pt-listcard" },
    el("div", { class: "card-title" }, el("span", {}, "患者一覧", subEl)),
    el("div", { class: "pt-toolbar" },
      el("div", { class: "pt-search" }, icon("search", 16), searchInput),
      chipsRow),
    listWrap));
}

/* ============================================================
   詳細ビュー
   ============================================================ */

/* ---- プロフィールカード ---- */
function profileCard(p, latest) {
  return card({
    class: "pt-profile",
    body: el("div", { class: "stack", style: { gap: "12px" } },
      el("div", { class: "pt-prof-head" },
        pAvatar(p, 52),
        el("span", { class: "pt-prof-names" },
          el("span", { class: "pt-prof-kana" }, p.kana),
          el("span", { class: "pt-prof-name" }, p.name,
            el("i", { class: "pt-prof-suffix" }, "様")),
          el("span", { class: "flex wrap", style: { gap: "6px" } },
            churnBadge(p.churnRisk), lineBadge(p)))),
      el("div", { class: "pt-prof-tags" }, p.tags.map((t) => el("span", { class: "pt-tag" }, t))),
      el("div", {},
        kv("担当店舗", store.storeName(p.storeId)),
        kv("年齢・性別", `${p.age}歳・${GENDER[p.gender] || "—"}`),
        kv("来院回数", `${p.visitCount}回`),
        kv("初回来院", fmtDate(p.firstVisit, { withYear: true })),
        kv("最終来院", `${fmtDate(p.lastVisit, { withYear: true })}(${daysSince(p.lastVisit)}日前)`),
        kv("電話番号", p.phone)),
      latest?.chief ? el("div", { class: "pt-chief" },
        el("span", { class: "pt-chief-label" }, "主訴"), latest.chief) : null),
  });
}

/* ---- 回数券カード ---- */
function ticketCard(p) {
  const copy = el("div", { class: "pt-ticket-copy" }, icon("sparkle", 14),
    el("span", {}, el("strong", {}, "実物の回数券・診察券は不要になりました。"),
      "残数はカルテ保存時に自動で消化され、患者様のLINEにも通知されます。"));

  const t = ticketOf(p);
  if (!t) {
    return card({
      title: "回数券(デジタル)", class: "pt-ticket",
      body: el("div", { class: "stack", style: { gap: "12px" } },
        el("div", { class: "pt-ticket-none" },
          el("span", { class: "pt-ticket-none-ic" }, icon("ticket", 22)),
          el("span", {},
            el("span", { class: "pt-ticket-none-title" }, "回数券は未購入です"),
            el("span", { class: "pt-ticket-none-sub" }, "次回ご来院時にデジタル回数券をご案内できます"))),
        copy),
    });
  }

  const left = Math.max(t.total - t.used, 0);
  const expDays = -daysSince(t.expires);
  const notify = el("button", { class: "btn soft block" }, icon("line", 16), "残数をLINEで通知");
  notify.addEventListener("click", () =>
    toast(`${p.name}様へ回数券の残数(${left}回)をLINEで通知しました(シミュレーション)`));

  return card({
    title: "回数券(デジタル)", sub: t.name, class: "pt-ticket",
    body: el("div", { class: "stack", style: { gap: "14px" } },
      el("div", { class: `pt-ticket-hero ${left <= 2 ? "low" : ""}` },
        el("span", { class: "pt-ticket-left" }, "残り"),
        el("span", { class: "pt-ticket-num" }, left),
        el("span", { class: "pt-ticket-unit" }, `回 / 全${t.total}回`)),
      meter({
        label: "消化状況", value: t.used, max: t.total,
        fmt: () => `${t.used}/${t.total}回`, kind: left <= 2 ? "warn" : "",
      }),
      el("div", {},
        kv("有効期限", el("span", { class: "pt-kv-inline" },
          fmtDate(t.expires, { withYear: true }),
          expDays <= 30 ? badge(`あと${Math.max(expDays, 0)}日`, "warn") : null)),
        kv("購入日", fmtDate(t.purchased, { withYear: true })),
        kv("購入金額", fmtYen(t.price))),
      notify,
      copy),
  });
}

/* ---- 新規カルテ作成(ボイス入力) ---- */
function newKarteCard(p, draw) {
  const me = store.me();
  const menuSel = el("select", { class: "select" },
    store.get("menus").map((m) => el("option", { value: m.id }, m.name)));

  const SOAP_DEF = [
    ["subjective", "S", "主観的情報(患者様の訴え)"],
    ["objective", "O", "客観的所見(触診・検査)"],
    ["assessment", "A", "評価"],
    ["plan", "P", "計画・指導"],
  ];
  const ta = {};
  const fields = SOAP_DEF.map(([key, tag, label]) => {
    ta[key] = el("textarea", { class: "textarea pt-soap-ta", rows: "2", placeholder: label });
    return el("div", { class: "pt-soap-field" },
      el("span", { class: `pt-soap-tag ${key}` }, tag),
      el("span", { class: "field", style: { flex: "1" } },
        el("label", {}, label), ta[key]));
  });

  let lastTranscript = null;
  const recBtn = el("button", { class: "btn accent" }, "🎤 ボイス入力を開始");
  const recArea = el("div", { class: "pt-rec", hidden: true },
    el("span", { class: "pt-rec-mic" }, icon("mic", 20)),
    el("span", { class: "pt-rec-bars" }, [0, 1, 2, 3, 4, 5, 6].map(() => el("i"))),
    el("span", { class: "pt-rec-label" }, "録音中… 施術内容をお話しください"));
  const transcriptBox = el("div", { class: "pt-transcript", hidden: true });
  const thinking = el("div", { hidden: true },
    el("span", { class: "ai-thinking" },
      el("span", { class: "th-dots" }, el("i"), el("i"), el("i")),
      "AIがSOAP形式に整理しています…"));

  recBtn.addEventListener("click", async () => {
    if (recBtn.disabled) return;
    recBtn.disabled = true;
    transcriptBox.hidden = true;
    recArea.hidden = false;
    await delay(2000); // 録音風アニメーション
    recArea.hidden = true;
    lastTranscript = sampleVoiceTranscript(voiceIdx++);
    clear(transcriptBox).append(
      el("span", { class: "pt-transcript-label" }, icon("mic", 13), "書き起こし(自動)"),
      el("span", { class: "pt-transcript-text" }, lastTranscript));
    transcriptBox.hidden = false;
    thinking.hidden = false;
    const soap = await voiceToSoap(lastTranscript);
    thinking.hidden = true;
    for (const [key] of SOAP_DEF) {
      ta[key].value = soap[key] || "";
      ta[key].classList.remove("pt-flash");
      void ta[key].offsetWidth;
      ta[key].classList.add("pt-flash");
    }
    clear(recBtn).append("🎤 もう一度録音する");
    recBtn.disabled = false;
    toast("SOAPに自動整理しました。内容を確認・編集して保存してください", "info");
  });

  const saveBtn = el("button", { class: "btn primary lg block" }, icon("check", 17), "カルテを保存");
  saveBtn.addEventListener("click", () => {
    const vals = {};
    for (const [key] of SOAP_DEF) vals[key] = ta[key].value.trim();
    if (!vals.subjective && !vals.objective && !vals.assessment && !vals.plan) {
      toast("SOAPが空です。ボイス入力または手入力で記入してください", "error");
      return;
    }
    const t = ticketOf(p);
    const willUseTicket = !!(t && t.used < t.total);
    const latest = karteOf(p.id)[0] || null;
    const stamp = Date.now().toString(36);
    store.add("karte", {
      patientId: p.id,
      staffId: me.id,
      date: todayStr(),
      menuId: menuSel.value,
      chief: latest?.chief || "",
      ...vals,
      photos: [
        { id: `ph-${p.id}-${stamp}-f`, label: "正面", angle: "front" },
        { id: `ph-${p.id}-${stamp}-s`, label: "側面", angle: "side" },
      ],
      posture: null,
      voiceTranscript: lastTranscript,
      aiPatientMessage: null,
      sentToLine: false,
      ticketUsed: willUseTicket,
    });
    let msg = "カルテを保存しました";
    if (willUseTicket) {
      store.update("patients", p.id, (pt) => {
        const tk = pt.tickets[0];
        if (tk && tk.used < tk.total) tk.used += 1;
        return {};
      });
      msg = `カルテを保存しました。回数券を1回消化(残り${Math.max(t.total - t.used, 0)}回)`;
    }
    store.update("patients", p.id, { lastVisit: todayStr(), visitCount: p.visitCount + 1 });
    toast(msg);
    draw();
  });

  return card({
    title: "新規カルテ作成", sub: "ボイス入力対応", class: "pt-new",
    body: el("div", { class: "stack", style: { gap: "13px" } },
      el("div", { class: "pt-lead" }, icon("sparkle", 14),
        el("span", {}, "施術内容を話すだけ。AIが書き起こしてSOAP形式に自動整理します。",
          el("strong", {}, "紙の来患ノートは不要です。"))),
      el("div", { class: "form-row" },
        el("span", { class: "field", style: { flex: "1.4" } }, el("label", {}, "施術メニュー"), menuSel),
        el("span", { class: "field", style: { flex: "1" } }, el("label", {}, "担当"),
          el("span", { class: "pt-staffbox" }, staffChip(me.id, { size: 26, withRole: false })))),
      recBtn, recArea, transcriptBox, thinking,
      el("div", { class: "stack", style: { gap: "10px" } }, fields),
      saveBtn,
      ticketOf(p)
        ? el("div", { class: "small muted", style: { textAlign: "center" } },
            "保存すると回数券が自動で1回消化され、残数が患者様のLINEに通知されます")
        : null),
  });
}

/* ---- カルテタイムライン ---- */
function soapRow(tag, key, text) {
  if (!text) return null;
  return el("div", { class: "pt-soap-row" },
    el("span", { class: `pt-soap-tag ${key}` }, tag),
    el("span", { class: "pt-soap-text" }, text));
}

function timelineCard(list) {
  const items = list.map((k) => el("div", { class: "tl-item" },
    el("div", { class: "pt-tl-head" },
      el("span", { class: "tl-date" }, fmtDate(k.date, { withYear: true })),
      el("span", { class: "pt-tl-menu" }, store.menuName(k.menuId)),
      k.posture ? badge(`姿勢 ${k.posture.score}点`, "brand") : null,
      k.sentToLine ? badge("LINE送信済み", "good") : null),
    el("div", { class: "pt-karte" },
      el("div", { class: "pt-karte-top" },
        staffChip(k.staffId, { size: 26 }),
        k.photos?.length
          ? el("span", { class: "pt-photos" },
              k.photos.map((ph) => el("span", { class: "pt-photo" }, "📷 ", ph.label)))
          : null),
      el("div", { class: "pt-soap" },
        soapRow("S", "subjective", k.subjective),
        soapRow("O", "objective", k.objective),
        soapRow("A", "assessment", k.assessment),
        soapRow("P", "plan", k.plan)))));

  return card({
    title: "カルテタイムライン", sub: `${list.length}件`, class: "pt-timelinecard",
    body: list.length
      ? el("div", { class: "stack", style: { gap: "14px" } },
          el("div", { class: "pt-lead" }, icon("info", 14),
            "紙の来患ノートは廃止されました。施術履歴・写真・LINE送信状況はすべてここに残ります。"),
          el("div", { class: "timeline" }, items))
      : emptyState({ icon: "📋", title: "カルテはまだありません", hint: "ボイス入力から最初のカルテを作成できます" }),
  });
}

/* ---- 姿勢分析(33ポイント) ---- */

const SVG_NS = "http://www.w3.org/2000/svg";
function svEl(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

const POSE_BONES = [
  ["鼻", "胸骨"], ["左肩", "右肩"], ["左肩", "左肘"], ["左肘", "左手首"],
  ["右肩", "右肘"], ["右肘", "右手首"], ["左肩", "左腰"], ["右肩", "右腰"],
  ["左腰", "右腰"], ["左腰", "左膝"], ["左膝", "左足首"], ["右腰", "右膝"],
  ["右膝", "右足首"], ["左足首", "左かかと"], ["左かかと", "左爪先"],
  ["右足首", "右かかと"], ["右かかと", "右爪先"],
];
const POSE_LABELED = ["鼻", "左肩", "右肩", "左腰", "右腰"];

function poseSvg(res) {
  const W = 240, H = 380;
  const svg = svEl("svg", {
    viewBox: `0 0 ${W} ${H}`, class: "pt-pose-svg",
    role: "img", "aria-label": "姿勢分析 33ポイント検出結果",
  });
  // 薄いグリッド背景
  for (let x = 0; x <= W; x += 24)
    svg.appendChild(svEl("line", { x1: x, y1: 0, x2: x, y2: H, class: "pt-pose-grid" }));
  for (let y = 0; y <= H; y += 24)
    svg.appendChild(svEl("line", { x1: 0, y1: y, x2: W, y2: y, class: "pt-pose-grid" }));

  const px = (v) => (v / 100) * W;
  const py = (v) => (v / 100) * H;
  const at = (name) => res.points.find((pt) => pt.label === name);

  for (const [a, b] of POSE_BONES) {
    const pa = at(a), pb = at(b);
    if (!pa || !pb) continue;
    svg.appendChild(svEl("line", {
      x1: px(pa.x), y1: py(pa.y), x2: px(pb.x), y2: py(pb.y), class: "pt-pose-bone",
    }));
  }
  for (const pt of res.points) {
    const key = POSE_LABELED.includes(pt.label);
    svg.appendChild(svEl("circle", {
      cx: px(pt.x), cy: py(pt.y), r: key ? 4.2 : 2.6,
      class: key ? "pt-pose-key" : "pt-pose-dot",
    }));
  }
  for (const name of POSE_LABELED) {
    const pt = at(name);
    if (!pt) continue;
    const leftSide = pt.x < 50;
    const t = svEl("text", {
      class: "pt-pose-label",
      x: name === "鼻" ? px(pt.x) : px(pt.x) + (leftSide ? -9 : 9),
      y: name === "鼻" ? py(pt.y) - 11 : py(pt.y) + 4,
      "text-anchor": name === "鼻" ? "middle" : leftSide ? "end" : "start",
    });
    t.textContent = name;
    svg.appendChild(t);
  }
  return el("div", { class: "pt-pose-box" }, svg,
    el("span", { class: "pt-pose-count" }, icon("gps", 12), `${res.detectedPoints}ポイント検出`));
}

function postureResult(res) {
  const tone = res.score >= 80 ? "good" : res.score >= 65 ? "brand" : "warn";
  const diffTxt = (v) =>
    Math.abs(v) < 0.15 ? "ほぼ左右対称" : `${Math.abs(v).toFixed(1)}cm(${v > 0 ? "右" : "左"}下がり)`;
  const metric = (label, val) => el("div", { class: "pt-metric" },
    el("span", { class: "pt-metric-label" }, label),
    el("span", { class: "pt-metric-val" }, val));

  return el("div", { class: "pt-pose-wrap" },
    poseSvg(res),
    el("div", { class: "pt-pose-side" },
      el("div", { class: `pt-pose-score ${tone}` },
        el("span", { class: "pt-pose-score-label" }, "姿勢スコア"),
        el("span", { class: "pt-pose-score-num" }, res.score),
        el("span", { class: "pt-pose-score-unit" }, "/ 100")),
      el("div", { class: "pt-metrics" },
        metric("肩の高さ差", diffTxt(res.shoulderDiff)),
        metric("骨盤傾き", diffTxt(res.pelvisTilt)),
        metric("頭部前方偏位", `${res.headForward.toFixed(1)}cm`)),
      el("ul", { class: "pt-pose-comments" }, res.comments.map((c) => el("li", {}, c)))));
}

function postureCard(p) {
  const seed = Number(p.id.replace(/\D/g, "")) || 1;
  const holder = el("div", {},
    el("div", { class: "pt-pose-empty" },
      el("span", { class: "pt-pose-empty-ic" }, "🧍"),
      el("span", {}, "解析結果はここに表示されます")));

  const btn = aiButton("写真から自動解析(33ポイント検出)", async () => {
    const res = await analyzePosture(seed);
    clear(holder).appendChild(postureResult(res));
    toast("33ポイントの検出が完了しました", "info");
  });

  return card({
    title: "姿勢分析", sub: "AI自動検出", class: "pt-posture",
    body: el("div", { class: "stack", style: { gap: "12px" } },
      el("div", { class: "pt-lead" }, icon("camera", 14),
        el("span", {}, el("strong", {}, "グリッド線合わせは不要。"),
          "最新の姿勢写真から33箇所のランドマークを自動検出します。")),
      btn, holder),
  });
}

/* ---- AI患者メッセージ(LINE送信) ---- */
function aiMessageCard(p, latest, draw) {
  if (!latest) {
    return card({
      title: "AI患者メッセージ", sub: "LINE連携", class: "pt-aimsg",
      body: el("div", { class: "small muted" },
        "カルテを作成すると、内容をもとに患者様向けのフォローメッセージを自動作成できます。"),
    });
  }
  if (!p.lineLinked) {
    return card({
      title: "AI患者メッセージ", sub: "LINE連携", class: "pt-aimsg",
      body: el("div", { class: "stack", style: { gap: "10px" } },
        el("div", { class: "flex wrap", style: { gap: "8px" } },
          badge("LINE未連携", "warn"),
          el("span", { class: "small muted" }, "メッセージの送信にはLINE連携が必要です")),
        el("div", { class: "small muted" },
          "店頭で連携用QRコードをご案内ください。連携が完了すると、施術内容のフォローメッセージをAIが自動作成し、このカードから送信できるようになります。")),
    });
  }

  const panel = aiPanel("患者様向けメッセージ");
  panel.el.style.display = "none";
  const btn = aiButton("AIで患者様向けメッセージを作成", async () => {
    panel.el.style.display = "";
    panel.thinking(`${fmtDate(latest.date)}のカルテを読み込んでいます`);
    const msg = await kartePatientMessage(p, latest);
    const send = el("button", { class: "btn primary block" }, icon("send", 15), "LINEで送信");
    send.addEventListener("click", () => {
      store.update("karte", latest.id, { sentToLine: true, aiPatientMessage: msg });
      toast("送信しました(シミュレーション)");
      draw();
    });
    panel.setNode(el("div", { class: "stack", style: { gap: "10px" } }, lineBubble(msg), send));
  });

  return card({
    title: "AI患者メッセージ", sub: `最新カルテ:${fmtDate(latest.date)}`, class: "pt-aimsg",
    body: el("div", { class: "stack", style: { gap: "12px" } },
      el("div", { class: "pt-lead" }, icon("line", 14),
        "最新カルテの内容から、施術サマリー・セルフケア・回数券残数をまとめたフォローメッセージを作成します。"),
      latest.sentToLine
        ? el("div", { class: "flex wrap", style: { gap: "8px" } },
            badge("送信済み", "good"),
            el("span", { class: "small muted" }, "このカルテは送信済みです。再作成もできます"))
        : null,
      btn, panel.el),
  });
}

function renderDetail(root, patientId, draw) {
  root.appendChild(el("a", { class: "pt-back", href: "#/patients" },
    icon("chevL", 15), "一覧へ戻る"));

  const p = store.byId("patients", patientId);
  if (!p) {
    root.appendChild(el("div", { class: "card" },
      emptyState({ icon: "🔍", title: "患者様が見つかりませんでした", hint: "一覧へ戻って選び直してください" })));
    return;
  }

  const list = karteOf(p.id);
  const latest = list[0] || null;

  root.appendChild(el("div", { class: "pt-detail-top" },
    profileCard(p, latest), ticketCard(p)));
  root.appendChild(el("div", { class: "pt-detail-grid" },
    el("div", { class: "stack", style: { gap: "16px" } },
      newKarteCard(p, draw), timelineCard(list)),
    el("div", { class: "stack", style: { gap: "16px" } },
      postureCard(p), aiMessageCard(p, latest, draw))));
}

/* ============================================================
   ページ本体
   ============================================================ */

export default {
  id: "patients",
  title: "顧客・カルテ",
  icon: "users",
  render(root, params) {
    const patientId = params?.[0] || null;
    const draw = () => {
      clear(root);
      if (patientId) renderDetail(root, patientId, draw);
      else renderList(root);
    };
    draw();
  },
};
