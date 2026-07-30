/* ============================================================
   シフト管理 — 週間シフト表(セルタップで種別変更)/
   AIによる翌週シフト自動作成 / 希望提出 / 必要人数と充足判定
   ============================================================ */
import {
  el, icon, avatar, badge, card, kv, sectionHeader, segmented,
  modal, toast, aiButton, fmtDate, clear,
} from "../ui.js";
import { store, todayStr, addDays, dow, mondayOf, SHIFT_TYPES } from "../store.js";
import { generateShift, shiftRationale } from "../ai.js";

const CYCLE = ["early", "late", "full", "off"];          // セルタップの循環順
const TYPE_ORDER = ["early", "late", "full", "training", "off"]; // 凡例の表示順
const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];

export default {
  id: "shift",
  title: "シフト管理",
  icon: "calendar",
  render(root) {
    const state = {
      weekStart: mondayOf(todayStr()),
      storeId: store.me()?.storeId || store.get("stores")[0]?.id,
    };

    /* ---------------- helpers ---------------- */
    const weekDates = (ws) => Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const staffOf = (storeId) => store.get("staff").filter((s) => s.storeId === storeId);
    const rulesFor = (storeId) =>
      store.get("staffingRules").find((r) => r.storeId === storeId)
      || { weekday: { early: 2, late: 2 }, weekend: { early: 3, late: 2 }, closedDow: 3 };
    const shiftRec = (staffId, date) =>
      store.get("shifts").find((x) => x.staffId === staffId && x.date === date) || null;
    const nextMonday = () => addDays(mondayOf(todayStr()), 7);

    function rangeLabel(ws) {
      return `${fmtDate(ws, { withYear: true })} 〜 ${fmtDate(addDays(ws, 6))}`;
    }
    function weekTag(ws) {
      const diff = Math.round((Date.parse(ws) - Date.parse(mondayOf(todayStr()))) / 604800000);
      if (diff === 0) return badge("今週", "brand");
      if (diff === 1) return badge("翌週", "accent");
      if (diff === -1) return badge("先週");
      return null;
    }

    /* ---------------- セル種別の循環変更 ---------------- */
    function cycleCell(s, date) {
      const rec = shiftRec(s.id, date);
      let next;
      if (!rec) next = "early";
      else {
        const i = CYCLE.indexOf(rec.type);
        next = i < 0 ? "early" : CYCLE[(i + 1) % CYCLE.length]; // 研修などは早番から
      }
      if (rec) store.update("shifts", rec.id, { type: next });
      else store.add("shifts", { staffId: s.id, date, type: next });
      toast(`${s.name} ${fmtDate(date)} を「${SHIFT_TYPES[next].label}」に変更しました`);
      draw();
    }

    /* ---------------- 週グリッド(表示/プレビュー共用) ---------------- */
    function gridNode({ staffList, dates, typeOf, onCell = null, compact = false }) {
      const wrap = el("div", { class: "shift-scroll" });
      const g = el("div", { class: `shift-grid ${compact ? "compact" : ""}` });

      // ヘッダ行(日付+曜日、今日をハイライト)
      const head = el("div", { class: "sg-row sg-head" },
        el("div", { class: "sg-cell sg-name sg-h" }, "スタッフ"));
      for (const d of dates) {
        const w = dow(d);
        const isToday = d === todayStr();
        head.appendChild(el("div", { class: `sg-cell sg-h ${isToday ? "is-today" : ""}` },
          el("span", { class: `sg-date ${isToday ? "pill" : ""}` }, `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`),
          el("span", { class: `sg-dow ${w === 0 ? "sun" : w === 6 ? "sat" : ""}` }, DOW_JA[w])));
      }
      g.appendChild(head);

      // スタッフ行
      for (const s of staffList) {
        const row = el("div", { class: "sg-row" });
        row.appendChild(el("div", { class: "sg-cell sg-name" },
          avatar(s, compact ? 22 : 27),
          el("span", { class: "sg-sname" },
            el("span", { class: "sg-n" }, s.name),
            compact ? null : el("span", { class: "sg-r" }, s.role))));
        for (const d of dates) {
          const type = typeOf(s.id, d);
          const chipEl = type
            ? el("span", { class: `sh-chip t-${type}` }, SHIFT_TYPES[type]?.label || type)
            : el("span", { class: "sh-chip t-none" }, "—");
          const today = d === todayStr() ? "is-today" : "";
          row.appendChild(onCell
            ? el("button", {
                class: `sg-cell sg-btn ${today}`,
                "aria-label": `${s.name} ${fmtDate(d)} のシフトを変更`,
                onclick: () => onCell(s, d),
              }, chipEl)
            : el("div", { class: `sg-cell ${today}` }, chipEl));
        }
        g.appendChild(row);
      }

      // 充足判定行(早番・遅番の人数 vs 必要人数)
      const rules = rulesFor(state.storeId);
      const cov = el("div", { class: "sg-row sg-cov" },
        el("div", { class: "sg-cell sg-name sg-covlabel" }, "充足判定"));
      for (const d of dates) {
        const w = dow(d);
        const today = d === todayStr() ? "is-today" : "";
        if (w === (rules.closedDow ?? 3)) {
          cov.appendChild(el("div", { class: `sg-cell sg-covcell ${today}` }, badge("定休")));
          continue;
        }
        const need = (w === 0 || w === 6) ? rules.weekend : rules.weekday;
        let early = 0, late = 0;
        for (const s of staffList) {
          const t = typeOf(s.id, d);
          if (t === "early" || t === "full") early++;
          if (t === "late" || t === "full") late++;
        }
        const ok = early >= need.early && late >= need.late;
        cov.appendChild(el("div", { class: `sg-cell sg-covcell ${today}` },
          badge(ok ? "充足" : "不足", ok ? "good" : "critical"),
          el("span", { class: "sg-covnum" }, `早${early}/${need.early}・遅${late}/${need.late}`)));
      }
      g.appendChild(cov);

      wrap.appendChild(g);
      return wrap;
    }

    function legendNode() {
      return el("div", { class: "shift-legend" },
        TYPE_ORDER.map((t) => el("span", { class: "shift-legend-item" },
          el("span", { class: `sh-chip t-${t}` }, SHIFT_TYPES[t].label),
          SHIFT_TYPES[t].start
            ? el("span", { class: "small muted" }, `${SHIFT_TYPES[t].start}〜${SHIFT_TYPES[t].end}`)
            : null)));
    }

    /* ---------------- AIシフト作成(プレビュー→確定) ---------------- */
    function openPreview(plan, weekStart) {
      const staffList = staffOf(state.storeId);
      const dates = weekDates(weekStart);
      const byKey = new Map(plan.map((p) => [`${p.staffId}|${p.date}`, p.type]));
      const typeOf = (sid, d) => byKey.get(`${sid}|${d}`);

      const confirmBtn = el("button", { class: "btn primary" }, icon("check", 16), "この内容で確定");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");

      const body = el("div", { class: "page-shift" },
        el("div", { class: "stack", style: { gap: "12px" } },
          el("div", { class: "ai-panel" },
            el("div", { class: "ai-head" }, icon("sparkle", 16), "AIによる割当の説明"),
            el("div", { class: "ai-body" }, shiftRationale(state.storeId))),
          gridNode({ staffList, dates, typeOf, compact: true }),
          el("div", { class: "small muted" },
            "「確定」すると、この週・この店舗の既存シフトは上書きされます。確定後もセルタップで個別調整できます。")));

      const m = modal({
        title: `AIシフト案:${store.storeName(state.storeId)}(${fmtDate(weekStart)}〜${fmtDate(addDays(weekStart, 6))})`,
        body, wide: true, actions: [cancelBtn, confirmBtn],
      });
      cancelBtn.addEventListener("click", () => m.close());
      confirmBtn.addEventListener("click", () => {
        // 該当週・該当店舗スタッフの既存シフトを削除 → AI案を追加
        const end = addDays(weekStart, 6);
        const ids = store.get("shifts")
          .filter((sh) => sh.date >= weekStart && sh.date <= end && staffList.some((s) => s.id === sh.staffId))
          .map((sh) => sh.id);
        ids.forEach((id) => store.remove("shifts", id));
        plan.forEach((p) => store.add("shifts", { staffId: p.staffId, date: p.date, type: p.type }));
        m.close();
        state.weekStart = weekStart;
        toast(`${store.storeName(state.storeId)}の翌週シフトを確定しました(${plan.length}件)`);
        draw();
      });
    }

    /* ---------------- 希望提出モーダル ---------------- */
    function openRequestModal() {
      const me = store.me();
      const weekOf = nextMonday();
      const existing = store.get("shiftRequests").find((r) => r.staffId === me.id && r.weekOf === weekOf);

      const selects = [];
      const dayRows = [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(weekOf, i);
        const w = dow(d);
        const sel = el("select", { class: "select" },
          el("option", { value: "" }, "指定なし"),
          el("option", { value: "off" }, "休み"),
          el("option", { value: "early" }, "早番"),
          el("option", { value: "late" }, "遅番"));
        const cur = existing?.wishes?.[d];
        if (cur && ["off", "early", "late"].includes(cur)) sel.value = cur;
        selects.push([d, sel]);
        dayRows.push(el("div", { class: "shift-wish-row" },
          el("span", { class: `shift-wish-day ${w === 0 ? "sun" : w === 6 ? "sat" : ""}` }, fmtDate(d)),
          sel));
      }
      const noteEl = el("textarea", { class: "textarea", rows: "2", placeholder: "備考(例:土曜は早番希望です)" });
      noteEl.value = existing?.note || "";

      const submitBtn = el("button", { class: "btn primary" }, icon("send", 15), existing ? "希望を更新する" : "希望を提出する");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");

      const body = el("div", { class: "page-shift" },
        el("div", { class: "stack", style: { gap: "12px" } },
          el("div", { class: "shift-deadline" }, icon("clock", 15),
            `対象週:${fmtDate(weekOf, { withYear: true })}〜${fmtDate(addDays(weekOf, 6))}/締切は毎週金曜21時です`),
          el("div", { class: "stack", style: { gap: "7px" } }, dayRows),
          el("div", { class: "field" }, el("label", {}, "備考"), noteEl)));

      const m = modal({ title: "シフト希望の提出", body, actions: [cancelBtn, submitBtn] });
      cancelBtn.addEventListener("click", () => m.close());
      submitBtn.addEventListener("click", () => {
        const wishes = {};
        for (const [d, sel] of selects) if (sel.value) wishes[d] = sel.value;
        if (existing) {
          store.update("shiftRequests", existing.id, { wishes, note: noteEl.value.trim(), submittedAt: todayStr() });
        } else {
          store.add("shiftRequests", { staffId: me.id, weekOf, wishes, note: noteEl.value.trim(), submittedAt: todayStr() });
        }
        m.close();
        toast("シフト希望を提出しました。AI作成時に反映されます");
        draw();
      });
    }

    /* ---------------- 画面の組み立て ---------------- */
    function buildHead() {
      const reqBtn = el("button", { class: "btn ghost", onclick: openRequestModal }, icon("edit", 16), "希望を提出");
      const aiBtn = aiButton("AIで翌週シフトを作成", async () => {
        const weekStart = nextMonday();
        const plan = await generateShift({ weekStart, storeId: state.storeId });
        openPreview(plan, weekStart);
      });
      return sectionHeader("シフト管理",
        "必要人数と希望を入れるだけで、AIが翌週のシフト案を作成します",
        [reqBtn, aiBtn]);
    }

    function buildToolbar() {
      const stores = store.get("stores");
      return el("div", { class: "shift-toolbar" },
        el("div", { class: "shift-weeknav" },
          el("button", { class: "icon-btn", "aria-label": "前週", onclick: () => { state.weekStart = addDays(state.weekStart, -7); draw(); } }, icon("chevL", 18)),
          el("button", { class: "btn ghost sm", onclick: () => { state.weekStart = mondayOf(todayStr()); draw(); } }, "今週"),
          el("button", { class: "icon-btn", "aria-label": "翌週", onclick: () => { state.weekStart = addDays(state.weekStart, 7); draw(); } }, icon("chevR", 18)),
          el("span", { class: "shift-range" }, rangeLabel(state.weekStart), weekTag(state.weekStart))),
        segmented(
          stores.map((s) => ({ id: s.id, label: s.short })),
          state.storeId,
          (id) => { state.storeId = id; draw(); }));
    }

    function buildGridCard() {
      const staffList = staffOf(state.storeId);
      return card({
        title: "週間シフト表",
        sub: `${store.storeName(state.storeId)}・セルをタップすると 早番→遅番→通し→休み の順に切り替わります`,
        body: el("div", {},
          gridNode({
            staffList,
            dates: weekDates(state.weekStart),
            typeOf: (sid, d) => shiftRec(sid, d)?.type,
            onCell: cycleCell,
          }),
          legendNode()),
      });
    }

    function buildLinkCard() {
      return el("div", { class: "card shift-link" },
        el("span", { class: "shift-link-ic" }, icon("gps", 20)),
        el("span", { class: "shift-link-txt" },
          el("b", {}, "シフトと勤怠・GPS打刻は同一データで連動しています"),
          el("span", { class: "small muted" }, "ジンジャーへの転記作業は不要です。確定したシフトは勤怠管理・GPS打刻にそのまま反映されます。")));
    }

    function buildRulesCard() {
      const rules = rulesFor(state.storeId);
      return card({
        title: "必要人数ルール",
        sub: store.storeName(state.storeId),
        body: el("div", {},
          kv("平日(月・火・木・金)", `早番 ${rules.weekday.early}名・遅番 ${rules.weekday.late}名`),
          kv("土日", `早番 ${rules.weekend.early}名・遅番 ${rules.weekend.late}名`),
          kv("水曜日", badge("定休日")),
          el("p", { class: "small muted", style: { marginTop: "10px", lineHeight: "1.7" } },
            "AIシフト作成は、この必要人数・提出された希望・研修予定を制約条件として自動割当します。グリッド最下段の「充足判定」で日毎の過不足を確認できます。")),
      });
    }

    function buildRequestsCard() {
      const weekOf = nextMonday();
      const reqs = store.get("shiftRequests").filter((r) => r.weekOf === weekOf);
      const staffList = staffOf(state.storeId);
      const submitted = staffList.filter((s) => reqs.some((r) => r.staffId === s.id)).length;

      const rows = el("div", { class: "row-list" });
      for (const s of staffList) {
        const rq = reqs.find((r) => r.staffId === s.id);
        const wishCount = rq ? Object.keys(rq.wishes || {}).length : 0;
        rows.appendChild(el("div", { class: "row-item" },
          avatar(s, 30),
          el("span", { class: "row-main" },
            el("span", { class: "row-title" }, s.name),
            el("span", { class: "row-sub" },
              rq ? (rq.note || `${wishCount}件の希望を提出`) : "提出待ち")),
          rq ? badge("提出済", "good") : badge("未提出", "warn")));
      }

      return card({
        title: "来週の希望提出状況",
        sub: `${fmtDate(weekOf)}週・${submitted}/${staffList.length}名 提出済`,
        body: el("div", {},
          el("div", { class: "shift-deadline mb-12" }, icon("clock", 15), "締切は毎週金曜21時です"),
          rows),
      });
    }

    function draw() {
      const prevScroll = root.querySelector(".shift-scroll")?.scrollLeft || 0;
      clear(root);
      root.append(
        buildHead(),
        buildToolbar(),
        buildGridCard(),
        buildLinkCard(),
        el("div", { class: "grid cols-2 mt-16" }, buildRulesCard(), buildRequestsCard()),
      );
      const sc = root.querySelector(".shift-scroll");
      if (sc) sc.scrollLeft = prevScroll;
    }

    draw();
  },
};
