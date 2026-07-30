/* ============================================================
   予約管理(Salon One 代替)— 日/週ビューのタイムテーブル、
   空き枠クリックで新規予約、予約詳細でステータス変更+回数券消化、
   稼働率KPI と LINE予約比率ドーナツ
   ============================================================ */
import {
  el, icon, avatar, badge, card, kv, sectionHeader, segmented,
  modal, toast, statTile, meter, statusBadge, emptyState,
  fmtDate, fmtPct, clear,
} from "../ui.js";
import { store, todayStr, addDays, dow, mondayOf } from "../store.js";
import { donut } from "../charts.js";

const SLOTS = ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00"];
const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];
const CLOSED_DOW = 3; // 水曜定休
const SOURCES = ["LINE", "電話", "店頭", "Web"];
const SOURCE_KIND = { LINE: "accent", 電話: "brand", 店頭: "", Web: "" };

/** テーマ追従のチャート色(CSS変数を実値に解決) */
function cv(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function sourceColors() {
  return {
    LINE: cv("--accent", "#e86f2d"),
    電話: cv("--series-1", "#2a78d6"),
    店頭: cv("--series-3", "#1baf7a"),
    Web: cv("--series-7", "#4a3aa7"),
  };
}

const isActive = (r) => r.status === "confirmed" || r.status === "done";

export default {
  id: "reserve",
  title: "予約管理",
  icon: "book",
  render(root) {
    const state = {
      view: "day", // day | week
      date: todayStr(),
      storeId: store.me()?.storeId || store.get("stores")[0]?.id,
    };

    /* ---------------- helpers ---------------- */
    const practitionersOf = (storeId) =>
      store.get("staff").filter((s) => s.storeId === storeId && ["院長", "柔道整復師", "鍼灸師"].includes(s.role));
    const resFor = (date, storeId) =>
      store.get("reservations").filter((r) => r.date === date && r.storeId === storeId);
    const weekDates = () => {
      const ws = mondayOf(state.date);
      return Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    };
    const resName = (r) => (r.patientId ? store.patientName(r.patientId) : (r.guestName || "—"));
    const endTimeOf = (start, menu) => {
      const endH = Number(start.slice(0, 2)) + Math.ceil((menu?.minutes || 60) / 60);
      return `${String(Math.min(endH, 20)).padStart(2, "0")}:${start.slice(3)}`;
    };

    /* ---------------- 新規予約モーダル ---------------- */
    function openNewModal({ staffId, start } = {}) {
      if (dow(state.date) === CLOSED_DOW) { toast("水曜日は定休日のため予約を登録できません", "error"); return; }
      const staffList = practitionersOf(state.storeId);
      if (!staffList.length) { toast("この店舗には施術者が登録されていません", "error"); return; }
      const pats = store.get("patients").filter((p) => p.storeId === state.storeId);

      const patSel = el("select", { class: "select" },
        el("option", { value: "" }, "新規の方(お名前を入力)"),
        pats.map((p) => el("option", { value: p.id }, `${p.name}(${p.kana})`)));
      const guestInput = el("input", { class: "input", type: "text", placeholder: "例:新規:川口様" });
      const guestField = el("div", { class: "field" }, el("label", {}, "お名前(新規の方)"), guestInput);
      patSel.addEventListener("change", () => { guestField.style.display = patSel.value ? "none" : ""; });

      const menuSel = el("select", { class: "select" },
        store.get("menus").map((m) => el("option", { value: m.id }, m.name)));
      const staffSel = el("select", { class: "select" },
        staffList.map((s) => el("option", { value: s.id }, `${s.name}(${s.role})`)));
      if (staffId) staffSel.value = staffId;
      const timeSel = el("select", { class: "select" }, SLOTS.map((t) => el("option", { value: t }, t)));
      if (start) timeSel.value = start;

      const saveBtn = el("button", { class: "btn primary" }, icon("check", 16), "予約を登録");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");

      const body = el("div", { class: "page-reserve" },
        el("div", { class: "stack", style: { gap: "12px" } },
          el("div", { class: "rv-lead" }, icon("calendar", 15),
            `${fmtDate(state.date, { withYear: true })}・${store.storeName(state.storeId)} の予約を登録します`),
          el("div", { class: "field" }, el("label", {}, "患者様"), patSel),
          guestField,
          el("div", { class: "field" }, el("label", {}, "メニュー"), menuSel),
          el("div", { class: "form-row" },
            el("div", { class: "field" }, el("label", {}, "担当"), staffSel),
            el("div", { class: "field" }, el("label", {}, "開始時間"), timeSel))));

      const m = modal({ title: "新規予約", body, actions: [cancelBtn, saveBtn] });
      cancelBtn.addEventListener("click", () => m.close());
      saveBtn.addEventListener("click", () => {
        const patientId = patSel.value || null;
        const guestName = guestInput.value.trim();
        if (!patientId && !guestName) { toast("患者様を選択するか、お名前を入力してください", "error"); return; }
        const conflict = store.get("reservations").some((r) =>
          r.storeId === state.storeId && r.staffId === staffSel.value
          && r.date === state.date && r.start === timeSel.value && isActive(r));
        if (conflict) { toast("この時間帯は既に予約が入っています", "error"); return; }
        const menu = store.byId("menus", menuSel.value);
        store.add("reservations", {
          patientId,
          guestName: patientId ? null : guestName,
          storeId: state.storeId,
          staffId: staffSel.value,
          date: state.date,
          start: timeSel.value,
          end: endTimeOf(timeSel.value, menu),
          menuId: menuSel.value,
          status: "confirmed",
          source: "店頭",
          note: "",
        });
        m.close();
        toast(`予約を登録しました(${timeSel.value}〜・${store.staffName(staffSel.value)})`);
        draw();
      });
    }

    /* ---------------- 予約詳細モーダル ---------------- */
    function changeStatus(r, status, closeModal) {
      store.update("reservations", r.id, { status });
      closeModal();
      if (status === "done") {
        const p = r.patientId ? store.byId("patients", r.patientId) : null;
        const t = p?.tickets?.[0];
        if (t && t.used < t.total) {
          store.update("patients", p.id, (pt) => { pt.tickets[0].used += 1; return {}; });
          toast(`回数券を1回消化しました(残り${t.total - t.used}回)`);
        } else {
          toast("ステータスを「来院済」に変更しました");
        }
      } else {
        toast(`ステータスを「${status === "cancelled" ? "キャンセル" : "無断キャンセル"}」に変更しました`);
      }
      draw();
    }

    function openDetail(r) {
      const patient = r.patientId ? store.byId("patients", r.patientId) : null;
      const ticket = patient?.tickets?.[0];
      const staffMember = store.byId("staff", r.staffId);

      const doneBtn = el("button", { class: "btn primary", disabled: r.status === "done" }, icon("check", 15), "来院済");
      const cancelStBtn = el("button", { class: "btn ghost", disabled: r.status === "cancelled" }, "キャンセル");
      const noshowBtn = el("button", { class: "btn danger", disabled: r.status === "noshow" }, "無断キャンセル");
      const closeBtn = el("button", { class: "btn ghost" }, "閉じる");

      const nameEl = patient
        ? el("a", { href: `#/patients/${patient.id}`, class: "rv-plink", onclick: () => m.close() },
            patient.name, icon("chevR", 14))
        : el("span", { class: "rv-guestname" }, r.guestName || "—", badge("新規", "accent"));

      const body = el("div", { class: "page-reserve" },
        el("div", { class: "rv-detail-top" },
          avatar({ name: resName(r) }, 40),
          el("div", { class: "rv-detail-who" },
            el("div", { class: "rv-detail-name" }, nameEl),
            el("div", { class: "flex wrap", style: { gap: "6px" } },
              badge(r.source, SOURCE_KIND[r.source] ?? ""),
              statusBadge(r.status),
              ticket ? badge(`回数券 残り${Math.max(ticket.total - ticket.used, 0)}回`, "brand") : null))),
        el("div", { class: "rv-detail-kv" },
          kv("日時", `${fmtDate(r.date, { withYear: true })} ${r.start}〜${r.end}`),
          kv("メニュー", store.menuName(r.menuId)),
          kv("担当", `${store.staffName(r.staffId)}(${staffMember?.role || "—"})`),
          kv("店舗", store.storeName(r.storeId))),
        el("div", { class: "field", style: { marginTop: "10px" } },
          el("label", {}, "ステータス変更"),
          el("div", { class: "flex wrap", style: { gap: "8px" } }, doneBtn, cancelStBtn, noshowBtn),
          ticket && r.status !== "done"
            ? el("span", { class: "hint" }, "「来院済」にすると回数券が自動で1回消化されます")
            : null));

      const m = modal({ title: "予約の詳細", body, actions: [closeBtn] });
      closeBtn.addEventListener("click", () => m.close());
      doneBtn.addEventListener("click", () => changeStatus(r, "done", m.close));
      cancelStBtn.addEventListener("click", () => changeStatus(r, "cancelled", m.close));
      noshowBtn.addEventListener("click", () => changeStatus(r, "noshow", m.close));
    }

    /* ---------------- KPI ---------------- */
    function buildKpis() {
      const list = resFor(state.date, state.storeId);
      const total = list.length;
      const done = list.filter((r) => r.status === "done").length;
      const cancelled = list.filter((r) => r.status === "cancelled" || r.status === "noshow").length;
      const active = list.filter(isActive).length;
      const slots = practitionersOf(state.storeId).length * SLOTS.length;
      const isToday = state.date === todayStr();
      const occTile = el("div", { class: "stat-tile" },
        el("div", { class: "stat-top" },
          el("span", { class: "stat-label" }, "稼働率"),
          el("span", { class: "stat-ic", style: { background: "var(--brand-soft)", color: "var(--brand-ink)" } }, icon("target", 18))),
        el("div", { style: { marginTop: "6px" } },
          meter({
            label: `${active}/${slots}枠`,
            value: active, max: slots,
            fmt: (v, mx) => fmtPct(mx ? (v / mx) * 100 : 0),
          })));
      return el("div", { class: "kpi-row" },
        statTile({ label: isToday ? "本日の予約数" : `${fmtDate(state.date)}の予約数`, value: `${total}件`, icon: "book", tone: "brand", sub: store.storeName(state.storeId) }),
        statTile({ label: "来院済", value: `${done}件`, icon: "check", tone: "good", sub: `全${total}件中` }),
        statTile({ label: "キャンセル率", value: fmtPct(total ? (cancelled / total) * 100 : 0), icon: "alert", tone: "warn", sub: `キャンセル・無断 ${cancelled}件` }),
        occTile);
    }

    /* ---------------- ツールバー ---------------- */
    function buildToolbar() {
      const step = state.view === "day" ? 1 : 7;
      const isToday = state.date === todayStr();
      let label;
      if (state.view === "day") {
        label = el("span", { class: "rv-datelabel" },
          fmtDate(state.date, { withYear: true }),
          isToday ? badge("今日", "brand") : null,
          dow(state.date) === CLOSED_DOW ? badge("定休日") : null);
      } else {
        const ds = weekDates();
        label = el("span", { class: "rv-datelabel" }, `${fmtDate(ds[0], { withYear: true })} 〜 ${fmtDate(ds[6])}`);
      }
      return el("div", { class: "rv-toolbar" },
        el("div", { class: "rv-nav" },
          segmented(
            [{ id: "day", label: "日" }, { id: "week", label: "週" }],
            state.view,
            (id) => { state.view = id; draw(); }),
          el("div", { class: "rv-datenav" },
            el("button", { class: "icon-btn", "aria-label": "前へ", onclick: () => { state.date = addDays(state.date, -step); draw(); } }, icon("chevL", 18)),
            el("button", { class: "btn ghost sm", onclick: () => { state.date = todayStr(); draw(); } }, "今日"),
            el("button", { class: "icon-btn", "aria-label": "次へ", onclick: () => { state.date = addDays(state.date, step); draw(); } }, icon("chevR", 18)),
            label)),
        segmented(
          store.get("stores").map((s) => ({ id: s.id, label: s.short })),
          state.storeId,
          (id) => { state.storeId = id; draw(); }));
    }

    /* ---------------- 日ビュー:タイムテーブル ---------------- */
    function resCardNode(r) {
      return el("button", {
        class: `rv-card st-${r.status}`,
        onclick: () => openDetail(r),
        "aria-label": `${resName(r)} ${r.start}の予約詳細`,
      },
        el("span", { class: "rv-menu" }, store.menuName(r.menuId)),
        el("span", { class: "rv-name" }, resName(r)),
        el("span", { class: "rv-badges" },
          badge(r.source, SOURCE_KIND[r.source] ?? ""),
          statusBadge(r.status)));
    }

    function buildDayGrid() {
      const staffList = practitionersOf(state.storeId);
      const sub = `${store.storeName(state.storeId)}・空き枠をクリックすると新規予約を登録できます`;
      if (dow(state.date) === CLOSED_DOW) {
        return card({
          title: "タイムテーブル", sub,
          body: emptyState({ icon: "🌙", title: "水曜日は定休日です", hint: "日付ナビで前後の日に移動できます" }),
        });
      }
      const dateRes = resFor(state.date, state.storeId);
      const grid = el("div", {
        class: "rv-grid",
        style: { gridTemplateColumns: `54px repeat(${staffList.length}, minmax(150px, 1fr))` },
      });
      grid.appendChild(el("div", { class: "rv-cell rv-time rv-corner" }));
      for (const s of staffList) {
        grid.appendChild(el("div", { class: "rv-cell rv-h" },
          avatar(s, 26),
          el("span", { class: "rv-hname" },
            el("span", { class: "rv-hn" }, s.name),
            el("span", { class: "rv-hr" }, s.role))));
      }
      for (const t of SLOTS) {
        grid.appendChild(el("div", { class: "rv-cell rv-time" }, t));
        for (const s of staffList) {
          const cellRes = dateRes.filter((r) => r.staffId === s.id && r.start === t);
          const cell = el("div", { class: "rv-cell rv-slot" });
          for (const r of cellRes) cell.appendChild(resCardNode(r));
          if (!cellRes.some(isActive)) {
            cell.appendChild(el("button", {
              class: "rv-add",
              "aria-label": `${s.name} ${t} に新規予約を登録`,
              onclick: () => openNewModal({ staffId: s.id, start: t }),
            }, icon("plus", 15)));
          }
          grid.appendChild(cell);
        }
      }
      return card({ title: "タイムテーブル", sub, body: el("div", { class: "rv-scroll" }, grid) });
    }

    /* ---------------- 週ビュー:予約数サマリー ---------------- */
    function heatLevel(c) { return c <= 0 ? 0 : c >= 4 ? 4 : c; }

    function buildWeekGrid() {
      const staffList = practitionersOf(state.storeId);
      const dates = weekDates();
      const all = store.get("reservations");
      const countOf = (staffId, d) =>
        all.filter((r) => r.storeId === state.storeId && r.staffId === staffId && r.date === d).length;
      const gotoDay = (d) => { state.date = d; state.view = "day"; draw(); };

      const grid = el("div", {
        class: "rv-grid rv-week",
        style: { gridTemplateColumns: `minmax(136px, 1.3fr) repeat(7, minmax(66px, 1fr))` },
      });
      grid.appendChild(el("div", { class: "rv-cell rv-wname rv-corner" }, "施術者"));
      for (const d of dates) {
        const w = dow(d);
        const isToday = d === todayStr();
        grid.appendChild(el("button", {
          class: `rv-cell rv-wh ${isToday ? "is-today" : ""}`,
          onclick: () => gotoDay(d),
          "aria-label": `${fmtDate(d)}の日ビューを表示`,
        },
          el("span", { class: `rv-wd ${isToday ? "pill" : ""}` }, `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`),
          el("span", { class: `rv-wdow ${w === 0 ? "sun" : w === 6 ? "sat" : ""}` }, w === CLOSED_DOW ? "定休" : DOW_JA[w])));
      }
      for (const s of staffList) {
        grid.appendChild(el("div", { class: "rv-cell rv-wname" },
          avatar(s, 26),
          el("span", { class: "rv-hname" },
            el("span", { class: "rv-hn" }, s.name),
            el("span", { class: "rv-hr" }, s.role))));
        for (const d of dates) {
          if (dow(d) === CLOSED_DOW) {
            grid.appendChild(el("div", { class: "rv-cell rv-wcell" },
              el("span", { class: "rv-heat closed" }, "—")));
            continue;
          }
          const c = countOf(s.id, d);
          grid.appendChild(el("button", {
            class: "rv-cell rv-wcell",
            onclick: () => gotoDay(d),
            title: `${s.name} ${fmtDate(d)}:${c}件`,
            "aria-label": `${s.name} ${fmtDate(d)} 予約${c}件。クリックで日ビューへ`,
          }, el("span", { class: `rv-heat lv${heatLevel(c)}` }, c || "")));
        }
      }
      const legendItems = [1, 2, 3, 4].map((l) => el("span", { class: `rv-heat mini lv${l}` }));
      return card({
        title: "週間サマリー",
        sub: `${store.storeName(state.storeId)}・セルをクリックすると日ビューに移動します`,
        body: el("div", {},
          el("div", { class: "rv-scroll" }, grid),
          el("div", { class: "rv-heatlegend" },
            el("span", { class: "small muted" }, "予約数"),
            el("span", { class: "small muted" }, "少"), legendItems, el("span", { class: "small muted" }, "多"))),
      });
    }

    /* ---------------- LINE予約比率 + ステータス内訳 ---------------- */
    function buildBottom() {
      const list = resFor(state.date, state.storeId);
      const colors = sourceColors();
      const items = SOURCES
        .map((src) => ({ label: src, value: list.filter((r) => r.source === src).length, color: colors[src] }))
        .filter((it) => it.value > 0);
      const lineCount = list.filter((r) => r.source === "LINE").length;
      const linePct = list.length ? Math.round((lineCount / list.length) * 100) : 0;

      const donutCard = card({
        title: "LINE予約比率",
        sub: `${fmtDate(state.date)}・経路別の予約数`,
        body: items.length
          ? donut({ items, size: 168, centerLabel: "LINE経由", centerValue: `${linePct}%`, fmt: (v) => `${v}件` })
          : emptyState({ icon: "📊", title: "この日の予約はありません" }),
      });

      const byStatus = (st) => list.filter((r) => r.status === st).length;
      const free = Math.max(practitionersOf(state.storeId).length * SLOTS.length - list.filter(isActive).length, 0);
      const statusCard = card({
        title: "この日の内訳",
        sub: store.storeName(state.storeId),
        body: el("div", {},
          kv("確定", `${byStatus("confirmed")}件`),
          kv("来院済", `${byStatus("done")}件`),
          kv("キャンセル", `${byStatus("cancelled")}件`),
          kv("無断キャンセル", `${byStatus("noshow")}件`),
          kv("空き枠", dow(state.date) === CLOSED_DOW ? badge("定休日") : `${free}枠`)),
      });
      return el("div", { class: "grid cols-2 mt-16" }, donutCard, statusCard);
    }

    /* ---------------- 画面の組み立て ---------------- */
    function draw() {
      const prevScroll = root.querySelector(".rv-scroll")?.scrollLeft || 0;
      clear(root);
      root.append(
        sectionHeader("予約管理",
          "紙の来患ノートの代わりに、予約・来院・回数券消化をこの画面で完結します",
          [el("button", { class: "btn primary", onclick: () => openNewModal() }, icon("plus", 16), "新規予約")]),
        buildKpis(),
        buildToolbar(),
        state.view === "day" ? buildDayGrid() : buildWeekGrid(),
        buildBottom(),
      );
      const sc = root.querySelector(".rv-scroll");
      if (sc) sc.scrollLeft = prevScroll;
    }

    draw();
  },
};
