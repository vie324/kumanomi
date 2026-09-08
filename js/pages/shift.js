/* ============================================================
   シフト管理 — 週間 / 月間(カレンダー型・スタッフ×日 一覧型)
   セルタップで種別変更 / AIによる翌週シフト自動作成 /
   希望休の月単位申請(希望休・有給・特別・誕生日休暇) /
   必要人数と充足判定(責任者のみ) / 全店舗閲覧 / 権限による編集ロック
   ============================================================ */
import {
  el, icon, avatar, badge, card, kv, sectionHeader, segmented,
  modal, toast, aiButton, fmtDate, clear, emptyState,
} from "../ui.js";
import { store, todayStr, addDays, dow, mondayOf, monthOf, SHIFT_TYPES, LEAVE_TYPES } from "../store.js";
import { can, rankLabel, scopeLabel } from "../auth.js";
import { generateShift, shiftRationale } from "../ai.js";

const CYCLE = ["early", "late", "full", "off"];          // セルタップの循環順
const TYPE_ORDER = ["early", "late", "full", "training", "off", "paid", "special", "birthday"]; // 凡例の表示順
const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];
const SHORT = { early: "早", late: "遅", full: "通", training: "研", off: "休", paid: "有", special: "特", birthday: "誕" };
const LEAVE_CYCLE = ["", "off", "paid", "special", "birthday"]; // 希望休申請のタップ循環順
const ALL = "__all__";   // 店舗フィルタ「全店」

export default {
  id: "shift",
  title: "シフト管理",
  icon: "calendar",

  // このページが必要とするデータ。ルーターがそろえてから render() を呼ぶ
  needs: ["shiftRequests", "shifts", "staff", "staffingRules", "stores"],
  render(root) {
    const state = {
      view: "week",          // week | month
      monthMode: "cal",      // cal(カレンダー型) | list(スタッフ×日 一覧型)
      weekStart: mondayOf(todayStr()),
      month: monthOf(todayStr()),
      storeId: store.me()?.storeId || store.get("stores")[0]?.id,
    };

    /* ---------------- 日付ヘルパー ---------------- */
    const weekDates = (ws) => Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const pad2 = (n) => String(n).padStart(2, "0");
    function monthDates(ym) {
      const [y, m] = ym.split("-").map(Number);
      const n = new Date(y, m, 0).getDate();
      return Array.from({ length: n }, (_, i) => `${ym}-${pad2(i + 1)}`);
    }
    function addMonths(ym, delta) {
      const [y, m] = ym.split("-").map(Number);
      const d = new Date(y, m - 1 + delta, 1);
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    }
    const monthLabel = (ym) => `${ym.slice(0, 4)}年${Number(ym.slice(5, 7))}月`;
    const nextMonday = () => addDays(mondayOf(todayStr()), 7);

    /* ---------------- データヘルパー ---------------- */
    let sIndex = new Map();   // draw() ごとに作り直す "staffId|date" → shift
    function reindex() {
      sIndex = new Map();
      for (const sh of store.get("shifts")) sIndex.set(`${sh.staffId}|${sh.date}`, sh);
    }
    const shiftRec = (staffId, date) => sIndex.get(`${staffId}|${date}`) || null;
    const typeOfRec = (staffId, date) => shiftRec(staffId, date)?.type;

    const allStores = () => store.get("stores");
    const staffOf = (storeId) =>
      storeId === ALL ? store.get("staff") : store.get("staff").filter((s) => s.storeId === storeId);
    const rulesFor = (storeId) =>
      store.get("staffingRules").find((r) => r.storeId === storeId)
      || { weekday: { early: 2, late: 2 }, weekend: { early: 3, late: 2 }, closedDow: 3 };

    /* ---------------- 権限ヘルパー ---------------- */
    const me = () => store.me();
    const canEdit = (storeId) => storeId !== ALL && can("shift.edit", { storeId });
    const canAI = (storeId) => storeId !== ALL && can("shift.generateAI", { storeId });
    // 必要人数ルール・充足判定・他スタッフの希望休は責任者(院長以上)と本部人事のみ
    const canStaffing = () => can("shift.viewStaffing");
    const isMyStore = (storeId) => me()?.storeId === storeId;
    const editableStores = () => allStores().filter((s) => canEdit(s.id));
    /** 表示対象の店舗一覧(全店なら全部) */
    const shownStores = () =>
      state.storeId === ALL ? allStores() : allStores().filter((s) => s.id === state.storeId);

    /* ---------------- 期間ラベル ---------------- */
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
    function monthTag(ym) {
      const cur = monthOf(todayStr());
      if (ym === cur) return badge("今月", "brand");
      if (ym === addMonths(cur, 1)) return badge("翌月", "accent");
      if (ym === addMonths(cur, -1)) return badge("先月");
      return null;
    }

    /* ---------------- セル種別の循環変更 ---------------- */
    /** store を更新するだけ(再描画は呼び出し側) */
    function applyCycle(s, date) {
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
      return next;
    }
    function cycleCell(s, date) {
      applyCycle(s, date);
      draw({ keepY: true });
    }

    /* ---------------- 充足判定の計算 ---------------- */
    /** その店舗・その日の状況 → {closed, planned, early, late, need, ok, training} */
    function dayStatus(storeId, date, staffList) {
      const rules = rulesFor(storeId);
      const w = dow(date);
      const closed = w === (rules.closedDow ?? 3);
      let early = 0, late = 0, training = 0, planned = 0;
      for (const s of staffList) {
        const t = typeOfRec(s.id, date);
        if (!t) continue;
        planned++;
        if (t === "early" || t === "full") early++;
        if (t === "late" || t === "full") late++;
        if (t === "training") training++;
      }
      const need = (w === 0 || w === 6) ? rules.weekend : rules.weekday;
      return { closed, planned, early, late, training, need, ok: early >= need.early && late >= need.late };
    }

    /* ---------------- 週グリッド(表示/プレビュー共用) ---------------- */
    function gridNode({ staffList, dates, typeOf, onCell = null, compact = false, storeId }) {
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

      // 充足判定行(早番・遅番の人数 vs 必要人数)— 責任者のみ表示
      if (canStaffing()) {
        const rules = rulesFor(storeId || state.storeId);
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
      }

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

    function calLegendNode(editable) {
      const staffing = canStaffing();
      return el("div", { class: "shift-legend" },
        staffing ? el("span", { class: "shift-legend-item" }, el("span", { class: "sc-cov ok" }, "充足"), el("span", { class: "small muted" }, "必要人数を満たしています")) : null,
        staffing ? el("span", { class: "shift-legend-item" }, el("span", { class: "sc-cov ng" }, "不足"), el("span", { class: "small muted" }, "早番/遅番が足りません")) : null,
        el("span", { class: "shift-legend-item" }, el("span", { class: "sc-cov" }, "未作成"), el("span", { class: "small muted" }, "まだシフト未登録")),
        el("span", { class: "shift-legend-item" }, el("span", { class: "sc-train" }, "研 1"), el("span", { class: "small muted" }, "研修予定あり")),
        el("span", { class: "shift-legend-item small muted" },
          editable ? "日付をタップすると、その日の内訳を開いて種別を変更できます"
                   : "日付をタップすると、その日の内訳を確認できます"));
    }

    /* ---------------- 月:カレンダー型 ---------------- */
    function monthCalendarNode(storeId) {
      const staffList = staffOf(storeId);
      const dates = monthDates(state.month);
      const editable = canEdit(storeId);
      const wrap = el("div", { class: "shift-cal" });

      for (let w = 0; w < 7; w++) {
        wrap.appendChild(el("div", { class: `sc-h ${w === 0 ? "sun" : w === 6 ? "sat" : ""}` }, DOW_JA[w]));
      }
      const lead = dow(dates[0]);
      for (let i = 0; i < lead; i++) wrap.appendChild(el("div", { class: "sc-cell blank" }));

      const staffing = canStaffing();
      for (const d of dates) {
        const w = dow(d);
        const isToday = d === todayStr();
        const st = dayStatus(storeId, d, staffList);
        const cls = [
          "sc-cell",
          w === 0 ? "sun" : w === 6 ? "sat" : "",
          st.closed ? "closed" : "",
          isToday ? "today" : "",
        ].filter(Boolean).join(" ");

        // 充足/不足の判定は責任者のみ。一般スタッフには出勤人数だけを見せる
        const covEl = st.closed
          ? el("span", { class: "sc-cov" }, "定休")
          : st.planned === 0
            ? el("span", { class: "sc-cov" }, "未作成")
            : staffing
              ? el("span", { class: `sc-cov ${st.ok ? "ok" : "ng"}` }, st.ok ? "充足" : "不足")
              : null;

        // 出勤するスタッフのアバター(広い画面のみ表示)
        const working = staffList.filter((s) => {
          const t = typeOfRec(s.id, d);
          return t && !["off", "paid", "special", "birthday"].includes(t);
        });
        const stack = working.length
          ? el("span", { class: "sc-people avatar-stack" },
              working.slice(0, 4).map((s) => avatar(s, 18)),
              working.length > 4 ? el("span", { class: "sc-more" }, `+${working.length - 4}`) : null)
          : null;

        const inner = [
          el("div", { class: "sc-top" },
            el("span", { class: `sc-day ${isToday ? "pill" : ""}` }, Number(d.slice(8, 10))),
            st.training ? el("span", { class: "sc-train" }, `研${st.training}`) : null),
          st.closed || st.planned === 0
            ? null
            : staffing
              ? el("div", { class: "sc-counts" },
                  el("span", { class: `sc-cnt e ${st.early < st.need.early ? "low" : ""}` }, `早${st.early}`),
                  el("span", { class: `sc-cnt l ${st.late < st.need.late ? "low" : ""}` }, `遅${st.late}`))
              : el("div", { class: "sc-counts" },
                  el("span", { class: "sc-cnt e" }, `出${working.length}`)),
          el("div", { class: "sc-foot" }, covEl, stack),
        ];

        wrap.appendChild(el("button", {
          class: cls,
          "aria-label": `${fmtDate(d, { withYear: true })} の内訳を開く`,
          onclick: () => openDayModal(storeId, d),
        }, inner));
      }

      const tail = (7 - ((lead + dates.length) % 7)) % 7;
      for (let i = 0; i < tail; i++) wrap.appendChild(el("div", { class: "sc-cell blank" }));

      return el("div", {}, wrap, calLegendNode(editable));
    }

    /* ---------------- 月:日別の内訳ポップオーバー ---------------- */
    function openDayModal(storeId, date) {
      const staffList = staffOf(storeId);
      const editable = canEdit(storeId);
      const rows = el("div", { class: "row-list" });
      const summary = el("div", { class: "shift-daysum" });

      function paint() {
        clear(rows);
        for (const s of staffList) {
          const t = typeOfRec(s.id, date);
          const chipEl = t
            ? el("span", { class: `sh-chip t-${t}` }, SHIFT_TYPES[t].label)
            : el("span", { class: "sh-chip t-none" }, "—");
          const inner = [
            avatar(s, 30),
            el("span", { class: "row-main" },
              el("span", { class: "row-title" }, s.name),
              el("span", { class: "row-sub" },
                storeId === ALL ? `${store.storeName(s.storeId)}・${s.role}` : s.role)),
            chipEl,
          ];
          rows.appendChild(editable
            ? el("button", {
                class: "row-item clickable shift-dayrow",
                "aria-label": `${s.name} のシフトを変更`,
                onclick: () => { applyCycle(s, date); paint(); draw({ keepY: true }); },
              }, inner)
            : el("div", { class: "row-item" }, inner));
        }
        const st = dayStatus(storeId, date, staffList);
        clear(summary);
        const staffing = canStaffing();
        const workingN = staffList.filter((s) => {
          const t = typeOfRec(s.id, date);
          return t && !["off", "paid", "special", "birthday"].includes(t);
        }).length;
        summary.append(...[
          st.closed ? badge("定休日")
            : staffing
              ? badge(st.planned === 0 ? "未作成" : st.ok ? "充足" : "不足",
                  st.planned === 0 ? "" : st.ok ? "good" : "critical")
              : badge(st.planned === 0 ? "未作成" : `出勤 ${workingN}名`, st.planned === 0 ? "" : "brand"),
          el("span", { class: "small muted" },
            st.closed ? "水曜日は定休日です"
              : staffing
                ? `早番 ${st.early}/${st.need.early}名・遅番 ${st.late}/${st.need.late}名`
                : "この日の割当メンバーです"),
          st.training ? badge(`研修 ${st.training}名`, "accent") : null,
        ].filter(Boolean));
      }
      paint();

      const openWeek = el("button", { class: "btn ghost" }, icon("calendar", 15), "この週を週表示で開く");
      const closeBtn = el("button", { class: "btn primary" }, "閉じる");

      const body = el("div", { class: "page-shift" },
        el("div", { class: "stack", style: { gap: "12px" } },
          summary,
          editable
            ? el("div", { class: "shift-deadline" }, icon("edit", 15), "スタッフ行をタップすると 早番→遅番→通し→休み の順に切り替わります")
            : el("div", { class: "shift-deadline" }, icon("eye", 15), `閲覧のみ(編集は院長以上)・現在の権限:${rankLabel(me())}`),
          rows));

      const m = modal({
        title: `${store.storeName(storeId) || "全店"} ${fmtDate(date, { withYear: true })} の内訳`,
        body, actions: [openWeek, closeBtn],
      });
      closeBtn.addEventListener("click", () => m.close());
      openWeek.addEventListener("click", () => {
        m.close();
        state.view = "week";
        state.weekStart = mondayOf(date);
        draw();
      });
    }

    /* ---------------- 月:スタッフ×日 一覧型 ---------------- */
    function monthListNode(storeId) {
      const staffList = staffOf(storeId);
      const dates = monthDates(state.month);
      const editable = canEdit(storeId);
      const today = todayStr();

      const wrap = el("div", { class: "shift-scroll month-scroll" });
      const g = el("div", { class: "month-grid" });
      g.style.setProperty("--mdays", String(dates.length));

      const dayCls = (d) => {
        const w = dow(d);
        return [w === 0 ? "sun" : w === 6 ? "sat" : "", d === today ? "is-today" : ""].filter(Boolean).join(" ");
      };

      // ヘッダ
      const head = el("div", { class: "mg-row mg-head" },
        el("div", { class: "mg-cell mg-name" }, "スタッフ"));
      for (const d of dates) {
        head.appendChild(el("div", { class: `mg-cell mg-h ${dayCls(d)}` },
          el("span", { class: "mg-d" }, Number(d.slice(8, 10))),
          el("span", { class: "mg-w" }, DOW_JA[dow(d)])));
      }
      head.appendChild(el("div", { class: "mg-cell mg-sum" },
        el("span", { class: "mg-sumh" }, "当月の"), el("span", { class: "mg-sumh" }, "出勤/休")));
      g.appendChild(head);

      // スタッフ行
      for (const s of staffList) {
        const row = el("div", { class: "mg-row" });
        row.appendChild(el("div", { class: "mg-cell mg-name" },
          avatar(s, 22),
          el("span", { class: "mg-sname" },
            el("span", { class: "mg-n" }, s.name),
            el("span", { class: "mg-r" }, storeId === ALL ? store.storeName(s.storeId) : s.role))));
        let work = 0, off = 0;
        for (const d of dates) {
          const t = typeOfRec(s.id, d);
          if (t === "off") off++;
          else if (t) work++;
          const chipEl = t
            ? el("span", { class: `sh-chip mini t-${t}` }, SHORT[t] || "?")
            : el("span", { class: "sh-chip mini t-none" }, "·");
          const cls = `mg-cell ${dayCls(d)}`;
          row.appendChild(editable
            ? el("button", {
                class: `${cls} mg-btn`,
                "aria-label": `${s.name} ${fmtDate(d)} のシフトを変更`,
                onclick: () => cycleCell(s, d),
              }, chipEl)
            : el("div", { class: cls }, chipEl));
        }
        row.appendChild(el("div", { class: "mg-cell mg-sum" },
          el("span", { class: "mg-sumv" }, `出 ${work}日`),
          el("span", { class: "mg-sumv off" }, `休 ${off}日`)));
        g.appendChild(row);
      }

      // 充足判定行(責任者のみ)
      if (canStaffing()) {
        const covRow = el("div", { class: "mg-row mg-covrow" },
          el("div", { class: "mg-cell mg-name mg-covlabel" }, "充足判定"));
        let short = 0;
        for (const d of dates) {
          const st = dayStatus(storeId, d, staffList);
          let mark, kind;
          if (st.closed) { mark = "休"; kind = "closed"; }
          else if (st.planned === 0) { mark = "·"; kind = "none"; }
          else if (st.ok) { mark = "○"; kind = "ok"; }
          else { mark = "!"; kind = "ng"; short++; }
          covRow.appendChild(el("div", { class: `mg-cell ${dayCls(d)}`, title: st.closed ? "定休日" : `早${st.early}/${st.need.early}・遅${st.late}/${st.need.late}` },
            el("span", { class: `mg-mark ${kind}` }, mark)));
        }
        covRow.appendChild(el("div", { class: "mg-cell mg-sum" },
          el("span", { class: "mg-sumv" }, "不足"), el("span", { class: "mg-sumv off" }, `${short}日`)));
        g.appendChild(covRow);
      }

      wrap.appendChild(g);
      return el("div", {}, wrap,
        el("div", { class: "shift-legend" },
          TYPE_ORDER.map((t) => el("span", { class: "shift-legend-item" },
            el("span", { class: `sh-chip mini t-${t}` }, SHORT[t]),
            el("span", { class: "small muted" }, SHIFT_TYPES[t].label))),
          canStaffing() ? el("span", { class: "shift-legend-item" },
            el("span", { class: "mg-mark ok" }, "○"), el("span", { class: "small muted" }, "充足"),
            el("span", { class: "mg-mark ng" }, "!"), el("span", { class: "small muted" }, "不足")) : null));
    }

    /* ---------------- AIシフト作成(プレビュー→確定) ---------------- */
    function openPreview(plan, weekStart, storeId) {
      const staffList = staffOf(storeId);
      const dates = weekDates(weekStart);
      const byKey = new Map(plan.map((p) => [`${p.staffId}|${p.date}`, p.type]));
      const typeOf = (sid, d) => byKey.get(`${sid}|${d}`);

      const confirmBtn = el("button", { class: "btn primary" }, icon("check", 16), "この内容で確定");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");

      const body = el("div", { class: "page-shift" },
        el("div", { class: "stack", style: { gap: "12px" } },
          el("div", { class: "ai-panel" },
            el("div", { class: "ai-head" }, icon("sparkle", 16), "AIによる割当の説明"),
            el("div", { class: "ai-body" }, shiftRationale(storeId))),
          gridNode({ staffList, dates, typeOf, compact: true, storeId }),
          el("div", { class: "small muted" },
            "「確定」すると、この週・この店舗の既存シフトは上書きされます。確定後もセルタップで個別調整できます。")));

      const m = modal({
        title: `AIシフト案:${store.storeName(storeId)}(${fmtDate(weekStart)}〜${fmtDate(addDays(weekStart, 6))})`,
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
        state.view = "week";
        state.weekStart = weekStart;
        toast(`${store.storeName(storeId)}の翌週シフトを確定しました(${plan.length}件)`);
        draw();
      });
    }

    function makeAiButton(storeId, { small = false } = {}) {
      const btn = aiButton("AIで翌週シフトを作成", async () => {
        const weekStart = nextMonday();
        const plan = await generateShift({ weekStart, storeId });
        openPreview(plan, weekStart, storeId);
      }, { small });
      if (canAI(storeId)) return btn;
      // 権限がないときは押せない状態にし、理由をツールチップで伝える
      // (.btn:disabled は pointer-events:none のため、ラッパー側に title を付ける)
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
      return el("span", {
        class: "shift-ailock",
        title: `シフトの作成・編集は院長以上の権限が必要です(現在の権限:${rankLabel(me())})`,
      }, btn, el("span", { class: "shift-ailock-ic" }, icon("eye", 13)));
    }

    /* ---------------- 希望休の申請(月単位) ---------------- */
    /** 対象月=翌月。日付をタップすると 希望休→有給→特休→誕生日休→解除 の順に切り替わる。
        選んだ日ごとに「理由」も一緒に提出できる */
    function openRequestModal() {
      const meNow = me();
      const minMonth = addMonths(monthOf(todayStr()), 1);
      const maxMonth = addMonths(monthOf(todayStr()), 3);
      let month = minMonth;
      let wishes = {};
      let reasons = {};   // { "YYYY-MM-DD": "理由" }

      const noteEl = el("textarea", { class: "textarea", rows: "2", placeholder: "備考(月全体の補足があれば)" });
      const submitBtn = el("button", { class: "btn primary" }, icon("send", 15), "希望休を申請する");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const countEl = el("span", { class: "wish-count" });
      const monthLabelEl = el("span", { class: "shift-range" });
      const calWrap = el("div", { class: "wish-cal" });
      const reasonWrap = el("div", { class: "wish-reasons" });

      const loadExisting = () => {
        const ex = store.get("shiftRequests").find((r) => r.staffId === meNow.id && r.month === month);
        wishes = { ...(ex?.wishes || {}) };
        reasons = { ...(ex?.reasons || {}) };
        noteEl.value = ex?.note || "";
        clear(submitBtn).append(icon("send", 15), ex ? "希望休を更新する" : "希望休を申請する");
      };

      const cycleDay = (d) => {
        const cur = wishes[d] || "";
        const next = LEAVE_CYCLE[(LEAVE_CYCLE.indexOf(cur) + 1) % LEAVE_CYCLE.length];
        if (next) wishes[d] = next; else { delete wishes[d]; delete reasons[d]; }
        paintCal();
      };

      /* 選択した日ごとの理由入力欄 */
      const paintReasons = () => {
        clear(reasonWrap);
        const days = Object.keys(wishes).sort();
        if (!days.length) {
          reasonWrap.appendChild(el("p", { class: "small muted", style: { margin: "0" } },
            "カレンダーで日付を選ぶと、日ごとの理由(任意)を入力できます"));
          return;
        }
        for (const d of days) {
          const lt = LEAVE_TYPES[wishes[d]];
          const input = el("input", {
            class: "input", type: "text",
            placeholder: "理由(任意・例:子どもの行事のため)",
            "aria-label": `${fmtDate(d)} の理由(任意)`,
            oninput: (e) => {
              const v = e.target.value;
              if (v.trim()) reasons[d] = v; else delete reasons[d];
            },
          });
          input.value = reasons[d] || "";
          reasonWrap.appendChild(el("div", { class: "wish-reason-row" },
            el("span", { class: "wish-reason-day" },
              el("span", { class: "wish-lg-emoji" }, lt?.emoji || "🙌"),
              el("span", {},
                el("b", {}, fmtDate(d)),
                el("span", { class: "small muted", style: { display: "block" } }, lt?.label || ""))),
            input));
        }
      };

      const paintCal = () => {
        clear(calWrap);
        for (let w = 0; w < 7; w++) {
          calWrap.appendChild(el("div", { class: `wc-h ${w === 0 ? "sun" : w === 6 ? "sat" : ""}` }, DOW_JA[w]));
        }
        const dates = monthDates(month);
        const lead = dow(dates[0]);
        for (let i = 0; i < lead; i++) calWrap.appendChild(el("div", { class: "wc-cell blank" }));
        for (const d of dates) {
          const w = dow(d);
          const closed = w === 3; // 水曜定休
          const wish = wishes[d];
          const lt = wish ? LEAVE_TYPES[wish] : null;
          calWrap.appendChild(el("button", {
            class: `wc-cell ${w === 0 ? "sun" : w === 6 ? "sat" : ""} ${closed ? "closed" : ""} ${wish ? `on t-${wish}` : ""}`,
            disabled: closed,
            onclick: () => cycleDay(d),
            "aria-label": `${fmtDate(d)} の希望を変更`,
            title: closed ? "定休日" : (lt ? lt.label : "タップで希望休を選択"),
          },
            el("span", { class: "wc-day" }, Number(d.slice(8, 10))),
            el("span", { class: "wc-mark" }, closed ? "定休" : (lt ? `${lt.emoji} ${lt.short}` : ""))));
        }
        const tail = (7 - ((lead + dates.length) % 7)) % 7;
        for (let i = 0; i < tail; i++) calWrap.appendChild(el("div", { class: "wc-cell blank" }));

        const n = Object.keys(wishes).length;
        countEl.textContent = n ? `${n}日分の希望を選択中` : "日付をタップして休みたい日を選びます";
        clear(monthLabelEl).append(monthLabel(month), monthTag(month));
        paintReasons();
      };

      const goMonth = (delta) => {
        const next = addMonths(month, delta);
        if (next < minMonth || next > maxMonth) return;
        month = next;
        loadExisting();
        paintCal();
      };

      const legend = el("div", { class: "wish-legend" },
        LEAVE_CYCLE.slice(1).map((t) => el("span", { class: `wish-lg t-${t}` },
          el("span", { class: "wish-lg-emoji" }, LEAVE_TYPES[t].emoji), LEAVE_TYPES[t].label)),
        el("span", { class: "small muted" }, "タップするたびに切り替わります(もう一度で解除)"));

      const body = el("div", { class: "page-shift" },
        el("div", { class: "stack", style: { gap: "12px" } },
          el("div", { class: "shift-deadline" }, icon("clock", 15),
            "希望休は月単位でまとめて申請します。締切は前月20日 21:00です"),
          el("div", { class: "wish-monthnav" },
            el("button", { class: "icon-btn", "aria-label": "前月", onclick: () => goMonth(-1) }, icon("chevL", 18)),
            monthLabelEl,
            el("button", { class: "icon-btn", "aria-label": "翌月", onclick: () => goMonth(1) }, icon("chevR", 18)),
            countEl),
          legend,
          calWrap,
          el("div", { class: "field" },
            el("label", {}, "日ごとの理由", el("span", { class: "wish-optional" }, "任意")),
            reasonWrap,
            el("span", { class: "hint" },
              "空欄のままでも提出できます。書いておくと、責任者がシフトを組むときに配慮しやすくなります")),
          el("div", { class: "field" }, el("label", {}, "備考"), noteEl)));

      const m = modal({ title: "希望休の申請(月単位)", body, wide: true, actions: [cancelBtn, submitBtn] });
      cancelBtn.addEventListener("click", () => m.close());
      submitBtn.addEventListener("click", () => {
        // 理由は選択中の日付分だけを保存する(解除した日の残骸を持ち込まない)
        const cleanReasons = {};
        for (const d of Object.keys(wishes)) {
          const r = (reasons[d] || "").trim();
          if (r) cleanReasons[d] = r;
        }
        const payload = { wishes: { ...wishes }, reasons: cleanReasons, note: noteEl.value.trim(), submittedAt: todayStr() };
        const existing = store.get("shiftRequests").find((r) => r.staffId === meNow.id && r.month === month);
        if (existing) {
          store.update("shiftRequests", existing.id, payload);
        } else {
          store.add("shiftRequests", { staffId: meNow.id, month, ...payload });
        }
        m.close();
        toast(`${monthLabel(month)}の希望休を申請しました。シフト作成時に反映されます`);
        draw();
      });

      loadExisting();
      paintCal();
    }

    /* ---------------- 画面の組み立て ---------------- */
    function buildHead() {
      const desc = state.view === "week"
        ? "希望休(月単位)と研修予定をもとに、AIが翌週のシフト案を作成します"
        : "1ヶ月分をまとめて確認できます。全店舗のシフトはどなたでも閲覧できます";
      const actions = [
        el("button", { class: "btn ghost", onclick: openRequestModal }, icon("edit", 16), "希望休を申請(月単位)"),
      ];
      if (state.storeId !== ALL) actions.push(makeAiButton(state.storeId));
      return sectionHeader("シフト管理", desc, actions);
    }

    /** 権限の案内バー */
    function buildPermBar() {
      const rank = rankLabel(me());
      const sub = el("span", { class: "shift-perm-sub" },
        icon("eye", 13), `権限:${rank} / 閲覧範囲:${scopeLabel(me())}`);

      if (state.storeId === ALL) {
        const ed = editableStores();
        const ro = allStores().filter((s) => !canEdit(s.id));
        const rw = ed.length > 0;
        return el("div", { class: `shift-perm ${rw ? "rw" : "ro"}` },
          el("span", { class: "shift-perm-ic" }, icon(rw ? "edit" : "eye", 17)),
          el("span", { class: "shift-perm-txt" },
            rw ? `編集できる店舗:${ed.map((s) => s.short).join("・")}` : "全店舗のシフトを閲覧できます",
            el("span", { class: "shift-perm-note" },
              rw
                ? (ro.length ? `閲覧のみ:${ro.map((s) => s.short).join("・")}` : "すべての店舗を編集できます")
                : "編集は院長以上の権限が必要です")),
          rw ? badge("編集できます", "good") : badge("閲覧のみ(編集は院長以上)"),
          sub);
      }

      const name = store.storeName(state.storeId);
      if (canEdit(state.storeId)) {
        return el("div", { class: "shift-perm rw" },
          el("span", { class: "shift-perm-ic" }, icon("edit", 17)),
          el("span", { class: "shift-perm-txt" }, `${name}のシフトを編集できます`,
            isMyStore(state.storeId) ? el("span", { class: "shift-perm-note" }, "自店舗") : null),
          badge("編集できます", "good"),
          sub);
      }
      return el("div", { class: "shift-perm ro" },
        el("span", { class: "shift-perm-ic" }, icon("eye", 17)),
        el("span", { class: "shift-perm-txt" }, `${name}のシフトを閲覧しています`,
          el("span", { class: "shift-perm-note" },
            isMyStore(state.storeId) ? "自店舗・希望の提出はどなたでもできます" : "希望の提出はどなたでもできます")),
        badge("閲覧のみ(編集は院長以上)"),
        sub);
    }

    function buildToolbar() {
      const bar = el("div", { class: "shift-toolbar" });

      // --- 1行目:表示切替 + 期間ナビ ---
      const viewSeg = segmented(
        [{ id: "week", label: "週" }, { id: "month", label: "月" }],
        state.view,
        (v) => { state.view = v; draw(); });

      const nav = state.view === "week"
        ? el("div", { class: "shift-weeknav" },
            el("button", { class: "icon-btn", "aria-label": "前週", onclick: () => { state.weekStart = addDays(state.weekStart, -7); draw({ keepY: true }); } }, icon("chevL", 18)),
            el("button", { class: "btn ghost sm", onclick: () => { state.weekStart = mondayOf(todayStr()); draw({ keepY: true }); } }, "今週"),
            el("button", { class: "icon-btn", "aria-label": "翌週", onclick: () => { state.weekStart = addDays(state.weekStart, 7); draw({ keepY: true }); } }, icon("chevR", 18)),
            el("span", { class: "shift-range" }, rangeLabel(state.weekStart), weekTag(state.weekStart)))
        : el("div", { class: "shift-weeknav" },
            el("button", { class: "icon-btn", "aria-label": "前月", onclick: () => { state.month = addMonths(state.month, -1); draw({ keepY: true }); } }, icon("chevL", 18)),
            el("button", { class: "btn ghost sm", onclick: () => { state.month = monthOf(todayStr()); draw({ keepY: true }); } }, "今月"),
            el("button", { class: "icon-btn", "aria-label": "翌月", onclick: () => { state.month = addMonths(state.month, 1); draw({ keepY: true }); } }, icon("chevR", 18)),
            el("span", { class: "shift-range" }, monthLabel(state.month), monthTag(state.month)));

      bar.appendChild(el("div", { class: "stb-row" }, viewSeg, nav,
        state.view === "month"
          ? el("div", { class: "stb-right" },
              segmented(
                [{ id: "cal", label: "カレンダー型" }, { id: "list", label: "スタッフ×日" }],
                state.monthMode,
                (v) => { state.monthMode = v; draw(); }))
          : null));

      // --- 2行目:店舗フィルタ(全社員が全店舗を閲覧できる) ---
      const items = [{ id: ALL, label: el("span", { class: "sf-lab" }, "全店") }].concat(
        allStores().map((s) => ({
          id: s.id,
          label: el("span", { class: "sf-lab" }, s.short,
            isMyStore(s.id) ? el("span", { class: "sf-mine", title: "自店舗" }, "自") : null),
        })));
      bar.appendChild(el("div", { class: "stb-row" },
        el("span", { class: "stb-lab" }, icon("pin", 14), "店舗"),
        el("div", { class: "stb-scroll" },
          segmented(items, state.storeId, (id) => { state.storeId = id; draw(); }))));

      return bar;
    }

    /** 店舗セクションのサブタイトル(店舗名+自店舗+編集可否) */
    function storeSub(storeId, hint) {
      return el("span", { class: "shift-cardsub" },
        el("b", {}, store.storeName(storeId)),
        isMyStore(storeId) ? badge("自店舗", "brand") : null,
        canEdit(storeId) ? badge("編集可", "good") : badge("閲覧のみ", ""),
        hint ? el("span", { class: "small muted" }, hint) : null);
    }

    function buildStoreCard(storeId) {
      const editable = canEdit(storeId);
      const staffList = staffOf(storeId);

      // 全店表示のときは、店舗ごとにAIボタンを添える
      const actions = state.storeId === ALL && canAI(storeId)
        ? makeAiButton(storeId, { small: true })
        : null;

      if (state.view === "week") {
        return card({
          title: "週間シフト表",
          sub: storeSub(storeId, editable
            ? "セルをタップすると 早番→遅番→通し→休み の順に切り替わります"
            : "閲覧のみです(編集は院長以上)"),
          actions,
          body: el("div", {},
            gridNode({
              staffList,
              dates: weekDates(state.weekStart),
              typeOf: typeOfRec,
              onCell: editable ? cycleCell : null,
              storeId,
            }),
            legendNode()),
        });
      }

      // 月ビュー
      const dates = monthDates(state.month);
      let shortDays = 0, blankDays = 0;
      for (const d of dates) {
        const st = dayStatus(storeId, d, staffList);
        if (st.closed) continue;
        if (st.planned === 0) blankDays++;
        else if (!st.ok) shortDays++;
      }
      const hint = canStaffing()
        ? `${monthLabel(state.month)}・不足 ${shortDays}日 / 未作成 ${blankDays}日`
        : monthLabel(state.month);

      return card({
        title: state.monthMode === "cal" ? "月間カレンダー" : "月間シフト表(スタッフ×日)",
        sub: storeSub(storeId, hint),
        actions,
        body: state.monthMode === "cal" ? monthCalendarNode(storeId) : monthListNode(storeId),
      });
    }

    /** 全店表示のときだけ出す、店舗別サマリー */
    function buildAllSummaryCard() {
      const dates = state.view === "week" ? weekDates(state.weekStart) : monthDates(state.month);
      const periodLabel = state.view === "week" ? rangeLabel(state.weekStart) : monthLabel(state.month);

      const rows = el("div", { class: "row-list" });
      for (const st of allStores()) {
        const list = staffOf(st.id);
        let shortDays = 0, blankDays = 0, manDays = 0;
        for (const d of dates) {
          const s = dayStatus(st.id, d, list);
          for (const p of list) {
            const t = typeOfRec(p.id, d);
            if (t && t !== "off") manDays++;
          }
          if (s.closed) continue;
          if (s.planned === 0) blankDays++;
          else if (!s.ok) shortDays++;
        }
        rows.appendChild(el("div", { class: "row-item shift-sumrow" },
          el("span", { class: "shift-sumdot", style: { background: st.color } }),
          el("span", { class: "row-main" },
            el("span", { class: "row-title" }, st.name),
            el("span", { class: "row-sub" }, `${list.length}名・延べ出勤 ${manDays}人日`)),
          isMyStore(st.id) ? badge("自店舗", "brand") : null,
          canEdit(st.id) ? badge("編集可", "good") : badge("閲覧のみ"),
          canStaffing() ? badge(shortDays ? `不足 ${shortDays}日` : "不足なし", shortDays ? "critical" : "good") : null,
          canStaffing() && blankDays ? badge(`未作成 ${blankDays}日`, "warn") : null));
      }

      return card({
        title: "全店サマリー",
        sub: el("span", { class: "shift-cardsub" }, el("b", {}, periodLabel),
          el("span", { class: "small muted" }, "店舗タブを選ぶと1店舗だけを大きく表示できます")),
        body: rows,
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
      if (state.storeId === ALL) {
        return card({
          title: "必要人数ルール",
          sub: "全店舗",
          body: el("div", {},
            allStores().map((s) => {
              const r = rulesFor(s.id);
              return kv(s.name, `平日 早${r.weekday.early}・遅${r.weekday.late} / 土日 早${r.weekend.early}・遅${r.weekend.late} / 水曜定休`);
            }),
            el("p", { class: "small muted", style: { marginTop: "10px", lineHeight: "1.7" } },
              "AIシフト作成は、この必要人数・提出された希望・研修予定を制約条件として自動割当します。")),
        });
      }
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

    /** 申請内容の詳細モーダル(責任者が日付・種別・理由を確認できる) */
    function openRequestDetail(rq, s) {
      const entries = Object.entries(rq.wishes || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const reasons = rq.reasons || {};

      const rows = entries.length
        ? el("div", { class: "row-list" }, entries.map(([d, t]) => {
            const lt = LEAVE_TYPES[t];
            return el("div", { class: "row-item" },
              el("span", { class: "wish-lg-emoji", style: { fontSize: "18px" } }, lt?.emoji || "🙌"),
              el("span", { class: "row-main" },
                el("span", { class: "row-title" }, fmtDate(d, { withYear: true }),
                  el("span", { class: `wish-lg t-${t}`, style: { marginLeft: "8px" } }, lt?.label || t)),
                el("span", { class: "row-sub", style: { whiteSpace: "normal" } },
                  reasons[d] ? `理由:${reasons[d]}` : "理由の記入なし")));
          }))
        : emptyState({ icon: "🗓", title: "希望日はありません" });

      const closeBtn = el("button", { class: "btn primary" }, "閉じる");
      const m = modal({
        title: `希望休の申請内容 — ${s.name}`,
        body: el("div", { class: "page-shift" },
          el("div", { class: "stack", style: { gap: "12px" } },
            el("div", { class: "flex", style: { gap: "10px", alignItems: "center" } },
              avatar(s, 38),
              el("span", {},
                el("span", { style: { display: "block", fontWeight: "800", fontSize: "var(--fs-md)" } }, s.name),
                el("span", { class: "small muted" }, `${store.storeName(s.storeId)}・${s.role}`)),
              el("span", { class: "spacer" }),
              badge(`対象 ${monthLabel(rq.month)}`, "brand")),
            el("div", { class: "small muted" }, `提出日:${fmtDate(rq.submittedAt, { withYear: true })}・${entries.length}日分の希望`),
            rows,
            rq.note ? el("div", { class: "shift-deadline" }, icon("info", 15), `備考:${rq.note}`) : null)),
        actions: [closeBtn],
      });
      closeBtn.addEventListener("click", () => m.close());
    }

    /** 対象月(翌月)の希望休 提出状況 — 責任者・本部人事のみ */
    function buildRequestsCard() {
      const targetMonth = addMonths(monthOf(todayStr()), 1);
      const reqs = store.get("shiftRequests").filter((r) => r.month === targetMonth);
      const staffList = staffOf(state.storeId);
      const submitted = staffList.filter((s) => reqs.some((r) => r.staffId === s.id)).length;

      const wishSummary = (rq) => {
        const counts = {};
        for (const t of Object.values(rq.wishes || {})) counts[t] = (counts[t] || 0) + 1;
        const parts = Object.entries(counts).map(([t, n]) => `${LEAVE_TYPES[t]?.label || t} ${n}日`);
        return parts.join("・") || "希望日なし";
      };

      const rows = el("div", { class: "row-list" });
      for (const s of staffList) {
        const rq = reqs.find((r) => r.staffId === s.id);
        const reasonN = rq ? Object.keys(rq.reasons || {}).length : 0;
        const inner = [
          avatar(s, 30),
          el("span", { class: "row-main" },
            el("span", { class: "row-title" }, s.name),
            el("span", { class: "row-sub" },
              (state.storeId === ALL ? `${store.storeName(s.storeId)}・` : "")
              + (rq ? `${wishSummary(rq)}${reasonN ? `・理由 ${reasonN}件` : ""}${rq.note ? `/${rq.note}` : ""}` : "提出待ち"))),
          rq ? badge("提出済", "good") : badge("未提出", "warn"),
        ];
        // 提出済みの行はタップで申請内容(日付・種別・理由)を確認できる
        rows.appendChild(rq
          ? el("button", {
              class: "row-item clickable",
              "aria-label": `${s.name}さんの希望休の内容を確認`,
              onclick: () => openRequestDetail(rq, s),
            }, ...inner, icon("chevR", 15))
          : el("div", { class: "row-item" }, ...inner));
      }

      return card({
        title: "希望休の提出状況(月単位)",
        sub: `${state.storeId === ALL ? "全店舗" : store.storeName(state.storeId)}・対象 ${monthLabel(targetMonth)}・${submitted}/${staffList.length}名 提出済`,
        body: el("div", {},
          el("div", { class: "shift-deadline mb-12" }, icon("clock", 15), "提出済みの行をタップすると、申請内容(日付・種別・理由)を確認できます"),
          rows),
      });
    }

    /** 一般スタッフ向け:自分の希望休だけを表示するカード */
    function buildMyRequestCard() {
      const targetMonth = addMonths(monthOf(todayStr()), 1);
      const rq = store.get("shiftRequests").find((r) => r.staffId === me()?.id && r.month === targetMonth);
      const entries = rq ? Object.entries(rq.wishes || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)) : [];

      const body = el("div", {},
        el("div", { class: "shift-deadline mb-12" }, icon("clock", 15),
          `対象 ${monthLabel(targetMonth)}・締切は前月20日 21:00です`),
        entries.length
          ? el("div", { class: "row-list" }, entries.map(([d, t]) => el("div", { class: "row-item" },
              el("span", { class: "wish-lg-emoji" }, LEAVE_TYPES[t]?.emoji || "🙌"),
              el("span", { class: "row-main" },
                el("span", { class: "row-title" }, fmtDate(d, { withYear: true })),
                el("span", { class: "row-sub", style: { whiteSpace: "normal" } },
                  (LEAVE_TYPES[t]?.label || t)
                  + ((rq?.reasons || {})[d] ? `・理由:${rq.reasons[d]}` : ""))),
              badge("申請済", "good"))))
          : emptyState({ icon: "🗓", title: "まだ希望休を申請していません", hint: "「希望休を申請(月単位)」から提出できます" }),
        rq?.note ? el("p", { class: "small muted", style: { marginTop: "8px" } }, `備考:${rq.note}`) : null,
        el("div", { class: "mt-12" },
          el("button", { class: "btn primary", onclick: openRequestModal }, icon("edit", 15),
            rq ? "希望休を修正する" : "希望休を申請する")));

      return card({
        title: "自分の希望休(月単位)",
        sub: `${me()?.name}・他のスタッフの提出状況は表示されません`,
        body,
      });
    }

    /* ---------------- 描画 ---------------- */
    function draw({ keepY = false } = {}) {
      reindex();
      const scrolls = [...root.querySelectorAll(".shift-scroll")].map((n) => n.scrollLeft);
      const y = window.scrollY;

      clear(root);
      root.append(buildHead(), buildPermBar(), buildToolbar());
      if (state.storeId === ALL) root.append(buildAllSummaryCard());
      for (const s of shownStores()) root.append(buildStoreCard(s.id));
      // 必要人数ルール・全員の希望休提出状況は責任者と本部人事のみ。
      // 一般スタッフには自分の希望休カードだけを表示する。
      root.append(
        buildLinkCard(),
        canStaffing()
          ? el("div", { class: "grid cols-2 mt-16" }, buildRulesCard(), buildRequestsCard())
          : el("div", { class: "mt-16" }, buildMyRequestCard()),
      );

      root.querySelectorAll(".shift-scroll").forEach((n, i) => {
        if (scrolls[i] != null) n.scrollLeft = scrolls[i];
      });
      if (keepY) window.scrollTo({ top: y });
    }

    draw();
  },
};
