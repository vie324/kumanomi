/* ============================================================
   予約管理(Salon One 代替)— ベッド基軸のタイムテーブル。
   予約枠は「ベッド×時間」で管理し、予約カードをドラッグして
   別のベッド・時間帯へ移動できる(クリックで詳細から変更も可)。
   空き枠クリックで新規予約、来院処理で回数券を自動消化、
   稼働率KPI と LINE予約比率ドーナツ
   ============================================================ */
import {
  el, icon, avatar, badge, card, kv, sectionHeader, segmented,
  modal, toast, statTile, meter, statusBadge, emptyState, table,
  fmtDate, fmtPct, clear, staffChip,
} from "../ui.js";
import { store, todayStr, addDays, dow, mondayOf, bedsOf } from "../store.js";
import { donut, hBars } from "../charts.js";

const SLOTS = ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00"];
const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];
const CLOSED_DOW = 3; // 水曜定休
const SOURCES = ["LINE", "電話", "店頭", "Web"];
const SOURCE_KIND = { LINE: "accent", 電話: "brand", 店頭: "", Web: "" };
/** キャンセル理由は離反分析に使うため、必ず選んでもらう */
const CANCEL_REASONS = ["体調不良", "仕事の都合", "家族の予定", "症状が改善したため", "他院・他店へ", "天候・交通", "その他"];
/** キャンセル待ちの希望時間帯 */
const PREFER_SLOTS = { 終日: SLOTS, 午前: ["10:00", "11:00", "12:00"], 午後: ["13:00", "14:00", "15:00", "16:00"], 夕方以降: ["17:00", "18:00", "19:00"] };

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
      view: "day", // day | week | list
      date: todayStr(),
      storeId: store.me()?.storeId || store.get("stores")[0]?.id,
      q: "",       // 一覧ビューの検索語
    };

    /* ---------------- helpers ---------------- */
    const practitionersOf = (storeId) =>
      store.get("staff").filter((s) => s.storeId === storeId && ["院長", "柔道整復師", "鍼灸師", "エステティシャン", "店長"].includes(s.role));
    const bedsFor = (storeId) => bedsOf(store.byId("stores", storeId));
    const bedName = (bedId, storeId = state.storeId) =>
      bedsFor(storeId).find((b) => b.id === bedId)?.name || "ベッド1";
    /** 旧データなど bedId 未設定の予約は先頭ベッド扱いにする */
    const bedIdOf = (r) => r.bedId || bedsFor(r.storeId)[0]?.id;
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
    /** 指定枠(ベッド×時間)に有効な予約があるか */
    const slotTaken = (storeId, date, bedId, start, exceptId = null) =>
      store.get("reservations").some((x) =>
        x.id !== exceptId && x.storeId === storeId && x.date === date
        && bedIdOf(x) === bedId && x.start === start && isActive(x));
    /** その担当者が同じ時間に別の予約を持っていないか(施術者のダブルブッキング防止) */
    const staffTaken = (storeId, date, staffId, start, exceptId = null) =>
      store.get("reservations").find((x) =>
        x.id !== exceptId && x.storeId === storeId && x.date === date
        && x.staffId === staffId && x.start === start && isActive(x)) || null;

    /* ---------------- 予約枠の移動(ドラッグ&詳細から共用) ---------------- */
    function moveReservation(id, bedId, start) {
      const r = store.byId("reservations", id);
      if (!r) return false;
      if (bedIdOf(r) === bedId && r.start === start) return false;
      if (slotTaken(r.storeId, r.date, bedId, start, id)) {
        toast("移動先の枠にはすでに予約が入っています", "error");
        return false;
      }
      // ベッドが空いていても、担当者が同時刻に別の患者様を持っていたら移動できない
      const conflict = staffTaken(r.storeId, r.date, r.staffId, start, id);
      if (conflict) {
        toast(`${store.staffName(r.staffId)}は${start}に${resName(conflict)}様を担当予定です。担当を変えるか別の時間にしてください`, "error");
        return false;
      }
      const menu = store.byId("menus", r.menuId);
      store.update("reservations", id, { bedId, start, end: endTimeOf(start, menu) });
      toast(`${resName(r)}様の予約を「${bedName(bedId, r.storeId)}・${start}〜」に移動しました`);
      draw();
      return true;
    }

    /* ---------------- 新規予約モーダル ---------------- */
    /** @param {{bedId?:string, start?:string, patientId?:string, fromWaitlistId?:string}} opts */
    function openNewModal({ bedId, start, patientId: presetPatient, fromWaitlistId } = {}) {
      if (dow(state.date) === CLOSED_DOW) { toast("水曜日は定休日のため予約を登録できません", "error"); return; }
      const staffList = practitionersOf(state.storeId);
      if (!staffList.length) { toast("この店舗には施術者が登録されていません", "error"); return; }
      const beds = bedsFor(state.storeId);
      const pats = store.get("patients").filter((p) => p.storeId === state.storeId);

      /* --- 患者様の検索(人数が増えても探せるように) --- */
      const patSearch = el("input", {
        class: "input", type: "search", placeholder: "お名前・かな・タグで検索(例:岡田/おかだ/腰痛)",
        "aria-label": "患者様を検索",
      });
      const patSel = el("select", { class: "select", size: "6", "aria-label": "患者様" });
      const patHint = el("span", { class: "hint" });
      const paintPatients = () => {
        const q = patSearch.value.trim();
        const hits = q
          ? pats.filter((p) => p.name.includes(q) || p.kana.includes(q) || (p.tags || []).some((t) => t.includes(q)))
          : pats;
        clear(patSel);
        patSel.appendChild(el("option", { value: "" }, "新規の方(お名前を入力)"));
        for (const p of hits) {
          const t = p.tickets?.[0];
          patSel.appendChild(el("option", { value: p.id },
            `${p.name}(${p.kana})${t ? ` — 回数券 残${Math.max(t.total - t.used, 0)}回` : ""}`));
        }
        if (presetPatient && hits.some((p) => p.id === presetPatient)) patSel.value = presetPatient;
        patHint.textContent = q
          ? `「${q}」に一致:${hits.length}名 / 全${pats.length}名`
          : `${store.storeName(state.storeId)}の患者様 ${pats.length}名`;
        syncGuestField();
      };
      const guestInput = el("input", { class: "input", type: "text", placeholder: "例:新規:川口様" });
      const guestField = el("div", { class: "field" }, el("label", {}, "お名前(新規の方)"), guestInput);
      const syncGuestField = () => { guestField.style.display = patSel.value ? "none" : ""; };
      patSearch.addEventListener("input", paintPatients);
      patSel.addEventListener("change", syncGuestField);

      const menuSel = el("select", { class: "select" },
        store.get("menus").map((m) => el("option", { value: m.id }, m.name)));
      const staffSel = el("select", { class: "select" },
        staffList.map((s) => el("option", { value: s.id }, `${s.name}(${s.role})`)));
      const bedSel = el("select", { class: "select" },
        beds.map((b) => el("option", { value: b.id }, b.name)));
      if (bedId) bedSel.value = bedId;
      const timeSel = el("select", { class: "select" }, SLOTS.map((t) => el("option", { value: t }, t)));
      if (start) timeSel.value = start;
      const sourceSel = el("select", { class: "select" },
        SOURCES.map((s) => el("option", { value: s, selected: s === "店頭" }, s)));
      const noteIn = el("input", { class: "input", type: "text", placeholder: "申し送り(例:駐車場の場所を案内済み)" });

      /* --- 担当×時間の重複を即時に知らせる --- */
      const conflictEl = el("div", { class: "rv-conflict", style: { display: "none" } });
      const checkConflict = () => {
        const c = staffTaken(state.storeId, state.date, staffSel.value, timeSel.value);
        const bedBusy = slotTaken(state.storeId, state.date, bedSel.value, timeSel.value);
        const msgs = [];
        if (bedBusy) msgs.push(`${bedName(bedSel.value)}の${timeSel.value}はすでに埋まっています`);
        if (c) msgs.push(`${store.staffName(staffSel.value)}は${timeSel.value}に${resName(c)}様を担当予定です`);
        conflictEl.style.display = msgs.length ? "" : "none";
        clear(conflictEl);
        if (msgs.length) conflictEl.append(icon("alert", 15), el("span", {}, msgs.join(" / ")));
      };
      [staffSel, timeSel, bedSel].forEach((s) => s.addEventListener("change", checkConflict));

      const saveBtn = el("button", { class: "btn primary" }, icon("check", 16), "予約を登録");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");

      const body = el("div", { class: "page-reserve" },
        el("div", { class: "stack", style: { gap: "12px" } },
          el("div", { class: "rv-lead" }, icon("calendar", 15),
            `${fmtDate(state.date, { withYear: true })}・${store.storeName(state.storeId)} の予約を登録します(枠はベッド単位)`),
          fromWaitlistId
            ? el("div", { class: "rv-fromwait" }, icon("bell", 15), "キャンセル待ちからの登録です。登録すると待ちリストから外れます")
            : null,
          el("div", { class: "field" },
            el("label", {}, "患者様"),
            patSearch,
            el("div", { style: { marginTop: "6px" } }, patSel),
            patHint),
          guestField,
          el("div", { class: "field" }, el("label", {}, "メニュー"), menuSel),
          el("div", { class: "form-row" },
            el("div", { class: "field" }, el("label", {}, "ベッド(予約枠)"), bedSel),
            el("div", { class: "field" }, el("label", {}, "開始時間"), timeSel)),
          el("div", { class: "form-row" },
            el("div", { class: "field" }, el("label", {}, "担当"), staffSel),
            el("div", { class: "field" }, el("label", {}, "予約経路"), sourceSel)),
          conflictEl,
          el("div", { class: "field" }, el("label", {}, "メモ・申し送り"), noteIn)));

      const m = modal({ title: "新規予約", body, actions: [cancelBtn, saveBtn] });
      paintPatients();
      checkConflict();
      cancelBtn.addEventListener("click", () => m.close());
      saveBtn.addEventListener("click", () => {
        const patientId = patSel.value || null;
        const guestName = guestInput.value.trim();
        if (!patientId && !guestName) { toast("患者様を選択するか、お名前を入力してください", "error"); return; }
        if (slotTaken(state.storeId, state.date, bedSel.value, timeSel.value)) {
          toast("このベッド・時間帯には既に予約が入っています", "error"); return;
        }
        const conflict = staffTaken(state.storeId, state.date, staffSel.value, timeSel.value);
        if (conflict) {
          toast(`${store.staffName(staffSel.value)}は${timeSel.value}に${resName(conflict)}様を担当予定です。担当か時間を変えてください`, "error");
          return;
        }
        const menu = store.byId("menus", menuSel.value);
        store.add("reservations", {
          patientId,
          guestName: patientId ? null : guestName,
          storeId: state.storeId,
          staffId: staffSel.value,
          bedId: bedSel.value,
          date: state.date,
          start: timeSel.value,
          end: endTimeOf(timeSel.value, menu),
          menuId: menuSel.value,
          status: "confirmed",
          source: sourceSel.value,
          cancelReason: null,
          note: noteIn.value.trim(),
        });
        if (fromWaitlistId) {
          store.update("waitlist", fromWaitlistId, { status: "booked", bookedAt: todayStr() });
        }
        m.close();
        toast(`予約を登録しました(${bedName(bedSel.value)}・${timeSel.value}〜・担当 ${store.staffName(staffSel.value)})`);
        draw();
      });
    }

    /* ---------------- 予約詳細モーダル ---------------- */
    /** キャンセル理由の記録。理由は離反リスクの分析に使うため必ず残す */
    function openCancelModal(r, status, onDone) {
      const isNoshow = status === "noshow";
      const reasonSel = el("select", { class: "select" },
        CANCEL_REASONS.map((x) => el("option", { value: x }, x)));
      const detailIn = el("input", { class: "input", type: "text", placeholder: "補足(任意)。例)来週あらためて予約希望" });
      const rebook = el("input", { type: "checkbox", id: "rv-rebook" });
      const okBtn = el("button", { class: `btn ${isNoshow ? "danger" : "primary"}` },
        icon("check", 15), isNoshow ? "無断キャンセルとして記録" : "キャンセルを記録");
      const cancelBtn = el("button", { class: "btn ghost" }, "やめる");

      const m2 = modal({
        title: isNoshow ? "無断キャンセルの記録" : "キャンセルの記録",
        body: el("div", { class: "page-reserve" },
          el("div", { class: "stack", style: { gap: "12px" } },
            el("div", { class: "rv-lead" }, icon("info", 15),
              `${resName(r)}様・${fmtDate(r.date)} ${r.start}〜 の予約を${isNoshow ? "無断キャンセル" : "キャンセル"}にします。理由は分析に使うため必ず記録します。`),
            el("div", { class: "field" }, el("label", {}, "理由"), isNoshow
              ? el("input", { class: "input", type: "text", value: "無断キャンセル(連絡なし)", disabled: true })
              : reasonSel),
            el("div", { class: "field" }, el("label", {}, "補足"), detailIn),
            el("label", { class: "rv-check" }, rebook,
              el("span", {}, "キャンセル待ちリストに登録して、空きが出たらご案内する")))),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", () => m2.close());
      okBtn.addEventListener("click", () => {
        const reason = isNoshow ? "無断キャンセル(連絡なし)" : reasonSel.value;
        const detail = detailIn.value.trim();
        store.update("reservations", r.id, {
          status,
          cancelReason: detail ? `${reason}(${detail})` : reason,
          cancelledAt: todayStr(),
        });
        if (rebook.checked && r.patientId) {
          store.add("waitlist", {
            patientId: r.patientId, storeId: r.storeId,
            date: addDays(r.date, 7), prefer: "終日", menuId: r.menuId,
            note: `${fmtDate(r.date)}のキャンセル(${reason})から登録`,
            createdBy: store.me().id, createdAt: todayStr(), status: "waiting",
          });
        }
        m2.close();
        onDone?.();
        toast(`「${isNoshow ? "無断キャンセル" : "キャンセル"}」として記録しました(理由:${reason})`);
        draw();
      });
    }

    function changeStatus(r, status, closeModal) {
      if (status === "cancelled" || status === "noshow") {
        closeModal();
        openCancelModal(r, status);
        return;
      }
      store.update("reservations", r.id, { status });
      closeModal();
      const p = r.patientId ? store.byId("patients", r.patientId) : null;
      const t = p?.tickets?.[0];
      if (t && t.used < t.total) {
        store.update("patients", p.id, (pt) => { pt.tickets[0].used += 1; return {}; });
        toast(`回数券を1回消化しました(残り${t.total - t.used}回)`);
      } else {
        toast("ステータスを「来院済」に変更しました");
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

      /* 枠(ベッド×時間)の変更 — ドラッグできない端末でもここから移動できる */
      const bedSel = el("select", { class: "select" },
        bedsFor(r.storeId).map((b) => el("option", { value: b.id, selected: b.id === bedIdOf(r) }, b.name)));
      const timeSel = el("select", { class: "select" },
        SLOTS.map((t) => el("option", { value: t, selected: t === r.start }, t)));
      const moveBtn = el("button", {
        class: "btn soft",
        disabled: !isActive(r),
        onclick: () => { if (moveReservation(r.id, bedSel.value, timeSel.value)) m.close(); },
      }, icon("edit", 14), "枠を変更");

      /* メモ・申し送り(受付から施術者への引き継ぎに使う) */
      const noteIn = el("input", { class: "input", type: "text", value: r.note || "", placeholder: "例)駐車場の場所を案内済み" });
      const noteBtn = el("button", {
        class: "btn soft",
        onclick: () => {
          store.update("reservations", r.id, { note: noteIn.value.trim() });
          toast("メモを保存しました");
          draw();
        },
      }, icon("check", 14), "メモを保存");

      const body = el("div", { class: "page-reserve" },
        el("div", { class: "rv-detail-top" },
          avatar({ name: resName(r) }, 40),
          el("div", { class: "rv-detail-who" },
            el("div", { class: "rv-detail-name" }, nameEl),
            el("div", { class: "flex wrap", style: { gap: "6px" } },
              badge(r.source, SOURCE_KIND[r.source] ?? ""),
              statusBadge(r.status),
              badge(bedName(bedIdOf(r), r.storeId), "brand"),
              ticket ? badge(`回数券 残り${Math.max(ticket.total - ticket.used, 0)}回`, "brand") : null))),
        el("div", { class: "rv-detail-kv" },
          kv("日時", `${fmtDate(r.date, { withYear: true })} ${r.start}〜${r.end}`),
          kv("予約枠", bedName(bedIdOf(r), r.storeId)),
          kv("メニュー", store.menuName(r.menuId)),
          kv("担当", `${store.staffName(r.staffId)}(${staffMember?.role || "—"})`),
          kv("店舗", store.storeName(r.storeId)),
          r.cancelReason ? kv("キャンセル理由", el("span", { class: "rv-cancelreason" }, r.cancelReason)) : null),
        el("div", { class: "field", style: { marginTop: "10px" } },
          el("label", {}, "予約枠の変更(ベッド・開始時間)"),
          el("div", { class: "flex wrap", style: { gap: "8px", alignItems: "center" } }, bedSel, timeSel, moveBtn),
          el("span", { class: "hint" }, "タイムテーブル上で予約カードをドラッグしても移動できます")),
        el("div", { class: "field", style: { marginTop: "10px" } },
          el("label", {}, "メモ・申し送り"),
          el("div", { class: "flex wrap", style: { gap: "8px", alignItems: "center" } }, noteIn, noteBtn)),
        el("div", { class: "field", style: { marginTop: "10px" } },
          el("label", {}, "ステータス変更"),
          el("div", { class: "flex wrap", style: { gap: "8px" } }, doneBtn, cancelStBtn, noshowBtn),
          ticket && r.status !== "done"
            ? el("span", { class: "hint" }, "「来院済」にすると回数券が自動で1回消化されます")
            : el("span", { class: "hint" }, "キャンセルにすると理由の記録画面が開きます(分析に使うため必須です)")));

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
      const slots = bedsFor(state.storeId).length * SLOTS.length; // ベッド基軸の総枠数
      const isToday = state.date === todayStr();
      const occTile = el("div", { class: "stat-tile" },
        el("div", { class: "stat-top" },
          el("span", { class: "stat-label" }, "ベッド稼働率"),
          el("span", { class: "stat-ic", style: { background: "var(--brand-soft)", color: "var(--brand-ink)" } }, icon("target", 18))),
        el("div", { style: { marginTop: "6px" } },
          meter({
            label: `${active}/${slots}枠(${bedsFor(state.storeId).length}ベッド)`,
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
      // 週ビューだけ1週間単位で動かす(日・一覧は1日ずつ)
      const step = state.view === "week" ? 7 : 1;
      const isToday = state.date === todayStr();
      let label;
      if (state.view === "week") {
        const ds = weekDates();
        label = el("span", { class: "rv-datelabel" }, `${fmtDate(ds[0], { withYear: true })} 〜 ${fmtDate(ds[6])}`);
      } else {
        label = el("span", { class: "rv-datelabel" },
          fmtDate(state.date, { withYear: true }),
          isToday ? badge("今日", "brand") : null,
          dow(state.date) === CLOSED_DOW ? badge("定休日") : null);
      }
      return el("div", { class: "rv-toolbar" },
        el("div", { class: "rv-nav" },
          segmented(
            [{ id: "day", label: "日" }, { id: "week", label: "週" }, { id: "list", label: "一覧" }],
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

    /* ---------------- 日ビュー:ベッド×時間のタイムテーブル ---------------- */
    let draggingId = null; // ドラッグ中の予約ID

    function resCardNode(r) {
      const node = el("button", {
        class: `rv-card st-${r.status}`,
        onclick: () => openDetail(r),
        "aria-label": `${resName(r)} ${r.start}の予約詳細`,
        title: isActive(r) ? "ドラッグで別の枠へ移動できます" : null,
      },
        el("span", { class: "rv-menu" }, store.menuName(r.menuId)),
        el("span", { class: "rv-name" }, resName(r)),
        el("span", { class: "rv-staffline" },
          avatar(store.byId("staff", r.staffId), 16),
          el("span", { class: "rv-staffname" }, store.staffName(r.staffId))),
        el("span", { class: "rv-badges" },
          badge(r.source, SOURCE_KIND[r.source] ?? ""),
          statusBadge(r.status)));

      if (isActive(r)) {
        node.setAttribute("draggable", "true");
        node.addEventListener("dragstart", (e) => {
          draggingId = r.id;
          node.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          try { e.dataTransfer.setData("text/plain", r.id); } catch (err) { /* noop */ }
        });
        node.addEventListener("dragend", () => {
          draggingId = null;
          node.classList.remove("dragging");
          root.querySelectorAll(".rv-slot.drop-ok").forEach((c) => c.classList.remove("drop-ok"));
        });
      }
      return node;
    }

    function buildDayGrid() {
      const beds = bedsFor(state.storeId);
      const sub = `${store.storeName(state.storeId)}・${beds.length}ベッド。空き枠クリックで新規予約/予約カードはドラッグで枠移動`;
      if (dow(state.date) === CLOSED_DOW) {
        return card({
          title: "タイムテーブル(ベッド基軸)", sub,
          body: emptyState({ icon: "🌙", title: "水曜日は定休日です", hint: "日付ナビで前後の日に移動できます" }),
        });
      }
      const dateRes = resFor(state.date, state.storeId);
      const grid = el("div", {
        class: "rv-grid",
        style: { gridTemplateColumns: `54px repeat(${beds.length}, minmax(150px, 1fr))` },
      });
      grid.appendChild(el("div", { class: "rv-cell rv-time rv-corner" }));
      for (const b of beds) {
        grid.appendChild(el("div", { class: "rv-cell rv-h" },
          el("span", { class: "rv-bedic" }, "🛏"),
          el("span", { class: "rv-hname" },
            el("span", { class: "rv-hn" }, b.name),
            el("span", { class: "rv-hr" }, "予約枠"))));
      }
      for (const t of SLOTS) {
        grid.appendChild(el("div", { class: "rv-cell rv-time" }, t));
        for (const b of beds) {
          const cellRes = dateRes.filter((r) => bedIdOf(r) === b.id && r.start === t);
          const cell = el("div", { class: "rv-cell rv-slot" });

          /* --- ドロップ先(ベッド×時間) --- */
          cell.addEventListener("dragover", (e) => {
            if (!draggingId) return;
            if (slotTaken(state.storeId, state.date, b.id, t, draggingId)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            cell.classList.add("drop-ok");
          });
          cell.addEventListener("dragleave", () => cell.classList.remove("drop-ok"));
          cell.addEventListener("drop", (e) => {
            e.preventDefault();
            cell.classList.remove("drop-ok");
            const id = draggingId || e.dataTransfer.getData("text/plain");
            draggingId = null;
            if (id) moveReservation(id, b.id, t);
          });

          for (const r of cellRes) cell.appendChild(resCardNode(r));
          if (!cellRes.some(isActive)) {
            cell.appendChild(el("button", {
              class: "rv-add",
              "aria-label": `${b.name} ${t} に新規予約を登録`,
              onclick: () => openNewModal({ bedId: b.id, start: t }),
            }, icon("plus", 15)));
          }
          grid.appendChild(cell);
        }
      }
      return card({ title: "タイムテーブル(ベッド基軸)", sub, body: el("div", { class: "rv-scroll" }, grid) });
    }

    /* ---------------- 週ビュー:ベッド別の予約数サマリー ---------------- */
    function heatLevel(c) { return c <= 0 ? 0 : c >= 4 ? 4 : c; }

    function buildWeekGrid() {
      const beds = bedsFor(state.storeId);
      const dates = weekDates();
      const all = store.get("reservations");
      const countOf = (bedId, d) =>
        all.filter((r) => r.storeId === state.storeId && bedIdOf(r) === bedId && r.date === d).length;
      const gotoDay = (d) => { state.date = d; state.view = "day"; draw(); };

      const grid = el("div", {
        class: "rv-grid rv-week",
        style: { gridTemplateColumns: `minmax(136px, 1.3fr) repeat(7, minmax(66px, 1fr))` },
      });
      grid.appendChild(el("div", { class: "rv-cell rv-wname rv-corner" }, "ベッド"));
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
      for (const b of beds) {
        grid.appendChild(el("div", { class: "rv-cell rv-wname" },
          el("span", { class: "rv-bedic" }, "🛏"),
          el("span", { class: "rv-hname" },
            el("span", { class: "rv-hn" }, b.name),
            el("span", { class: "rv-hr" }, "予約枠"))));
        for (const d of dates) {
          if (dow(d) === CLOSED_DOW) {
            grid.appendChild(el("div", { class: "rv-cell rv-wcell" },
              el("span", { class: "rv-heat closed" }, "—")));
            continue;
          }
          const c = countOf(b.id, d);
          grid.appendChild(el("button", {
            class: "rv-cell rv-wcell",
            onclick: () => gotoDay(d),
            title: `${b.name} ${fmtDate(d)}:${c}件`,
            "aria-label": `${b.name} ${fmtDate(d)} 予約${c}件。クリックで日ビューへ`,
          }, el("span", { class: `rv-heat lv${heatLevel(c)}` }, c || "")));
        }
      }
      const legendItems = [1, 2, 3, 4].map((l) => el("span", { class: `rv-heat mini lv${l}` }));
      return card({
        title: "週間サマリー(ベッド別)",
        sub: `${store.storeName(state.storeId)}・セルをクリックすると日ビューに移動します`,
        body: el("div", {},
          el("div", { class: "rv-scroll" }, grid),
          el("div", { class: "rv-heatlegend" },
            el("span", { class: "small muted" }, "予約数"),
            el("span", { class: "small muted" }, "少"), legendItems, el("span", { class: "small muted" }, "多"))),
      });
    }

    /* ---------------- 一覧(リスト)ビュー ---------------- */
    /** 検索語があるときは前後2週間から探す(「あの患者様の予約いつだっけ」に応える) */
    function listRows() {
      const q = state.q.trim();
      const all = store.get("reservations").filter((r) => r.storeId === state.storeId);
      const rows = q
        ? all.filter((r) => {
            const name = resName(r);
            const staffName = store.staffName(r.staffId);
            return (name.includes(q) || staffName.includes(q) || store.menuName(r.menuId).includes(q))
              && r.date >= addDays(todayStr(), -14) && r.date <= addDays(todayStr(), 14);
          })
        : all.filter((r) => r.date === state.date);
      return rows.sort((a, b) => (a.date === b.date ? (a.start < b.start ? -1 : 1) : (a.date < b.date ? -1 : 1)));
    }

    function buildListView() {
      const rows = listRows();
      const q = state.q.trim();
      const search = el("input", {
        class: "input rv-search", type: "search", value: state.q,
        placeholder: "患者様・担当・メニューで検索(前後2週間から探します)",
        "aria-label": "予約を検索",
      });
      let timer = null;
      search.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.q = search.value; draw({ keepFocus: true }); }, 200);
      });

      const columns = [
        { key: "date", label: "日付", render: (r) => el("span", { class: r.date === todayStr() ? "rv-today" : "" }, fmtDate(r.date)) },
        { key: "time", label: "時間", render: (r) => el("span", { class: "mono-num" }, `${r.start}〜${r.end}`) },
        {
          key: "name", label: "患者様",
          render: (r) => r.patientId
            ? el("a", { class: "rv-plink", href: `#/patients/${r.patientId}` }, resName(r))
            : el("span", {}, resName(r), badge("新規", "accent")),
        },
        { key: "menu", label: "メニュー", render: (r) => el("span", { class: "rv-listmenu" }, store.menuName(r.menuId)) },
        { key: "staff", label: "担当", render: (r) => staffChip(r.staffId, { size: 24, withRole: false }) },
        { key: "bed", label: "ベッド", render: (r) => bedName(bedIdOf(r), r.storeId) },
        { key: "source", label: "経路", align: "center", render: (r) => badge(r.source, SOURCE_KIND[r.source] ?? "") },
        { key: "status", label: "状態", align: "center", render: (r) => statusBadge(r.status) },
        {
          key: "reason", label: "メモ・キャンセル理由",
          render: (r) => el("span", { class: "rv-listnote" }, r.cancelReason || r.note || "—"),
        },
      ];

      return card({
        title: "予約一覧",
        sub: q
          ? `「${q}」の検索結果 ${rows.length}件(前後2週間)`
          : `${fmtDate(state.date, { withYear: true })}・${store.storeName(state.storeId)}・${rows.length}件`,
        actions: search,
        body: rows.length
          ? table({ columns, rows, onRowClick: openDetail })
          : emptyState({ icon: "🔍", title: q ? "該当する予約が見つかりません" : "この日の予約はありません", hint: q ? "別のキーワードで探してみてください" : "「新規予約」から登録できます" }),
      });
    }

    /* ---------------- 未来院アラート(時間を過ぎても確定のままの予約) ---------------- */
    function buildOverdueCard() {
      if (state.date !== todayStr()) return null;
      const now = new Date();
      const nowHM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const overdue = resFor(state.date, state.storeId)
        .filter((r) => r.status === "confirmed" && r.end <= nowHM)
        .sort((a, b) => (a.start < b.start ? -1 : 1));
      if (!overdue.length) return null;

      return el("div", { class: "card rv-overdue" },
        el("div", { class: "rv-overdue-head" },
          icon("alert", 17),
          el("span", {}, el("b", {}, `対応待ちの予約が ${overdue.length}件 あります`),
            el("span", { class: "small muted" }, " 予約時間を過ぎましたが「確定」のままです。来院済みかキャンセルかを記録してください"))),
        el("div", { class: "rv-overdue-list" },
          overdue.map((r) => el("div", { class: "rv-overdue-item" },
            el("span", { class: "rv-od-time mono-num" }, `${r.start}〜${r.end}`),
            el("span", { class: "rv-od-name" }, resName(r)),
            el("span", { class: "small muted" }, `${store.staffName(r.staffId)}・${store.menuName(r.menuId)}`),
            el("span", { class: "spacer" }),
            el("button", { class: "btn primary sm", onclick: () => changeStatus(r, "done", () => {}) }, icon("check", 13), "来院済"),
            el("button", { class: "btn ghost sm", onclick: () => openCancelModal(r, "cancelled") }, "キャンセル"),
            el("button", { class: "btn danger sm", onclick: () => openCancelModal(r, "noshow") }, "無断")))));
    }

    /* ---------------- キャンセル待ち ---------------- */
    function openWaitlistModal() {
      const pats = store.get("patients").filter((p) => p.storeId === state.storeId);
      const patSel = el("select", { class: "select" },
        pats.map((p) => el("option", { value: p.id }, `${p.name}(${p.kana})`)));
      const dateIn = el("input", { class: "input", type: "date", value: state.date, min: todayStr() });
      const preferSel = el("select", { class: "select" },
        Object.keys(PREFER_SLOTS).map((k) => el("option", { value: k }, k)));
      const menuSel = el("select", { class: "select" },
        store.get("menus").map((m) => el("option", { value: m.id }, m.name)));
      const noteIn = el("input", { class: "input", type: "text", placeholder: "例)16時以降だと助かるとのこと" });

      const okBtn = el("button", { class: "btn primary" }, icon("plus", 15), "キャンセル待ちに追加");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: "キャンセル待ちに登録",
        body: el("div", { class: "page-reserve" },
          el("div", { class: "stack", style: { gap: "12px" } },
            el("div", { class: "rv-lead" }, icon("bell", 15),
              "満枠のときに希望を預かっておくと、キャンセルが出たときにすぐご案内できます"),
            el("div", { class: "field" }, el("label", {}, "患者様"), patSel),
            el("div", { class: "form-row" },
              el("div", { class: "field" }, el("label", {}, "希望日"), dateIn),
              el("div", { class: "field" }, el("label", {}, "希望時間帯"), preferSel)),
            el("div", { class: "field" }, el("label", {}, "希望メニュー"), menuSel),
            el("div", { class: "field" }, el("label", {}, "メモ"), noteIn))),
        actions: [cancelBtn, okBtn],
      });
      cancelBtn.addEventListener("click", () => m.close());
      okBtn.addEventListener("click", () => {
        if (!pats.length) { toast("この店舗に患者様が登録されていません", "error"); return; }
        store.add("waitlist", {
          patientId: patSel.value, storeId: state.storeId,
          date: dateIn.value, prefer: preferSel.value, menuId: menuSel.value,
          note: noteIn.value.trim(), createdBy: store.me().id, createdAt: todayStr(), status: "waiting",
        });
        m.close();
        toast(`${store.patientName(patSel.value)}様をキャンセル待ちに登録しました`);
        draw();
      });
    }

    /** その希望に合う空き枠を探す(ベッド×時間で、担当者も空いているもの) */
    function openSlotsFor(w) {
      if (dow(w.date) === CLOSED_DOW) return [];
      const beds = bedsFor(w.storeId);
      const slots = PREFER_SLOTS[w.prefer] || SLOTS;
      const out = [];
      for (const t of slots) {
        for (const b of beds) {
          if (!slotTaken(w.storeId, w.date, b.id, t)) out.push({ bedId: b.id, start: t });
        }
      }
      return out;
    }

    function buildWaitlistCard() {
      const items = (store.get("waitlist") || [])
        .filter((w) => w.storeId === state.storeId && w.status === "waiting")
        .sort((a, b) => (a.date < b.date ? -1 : 1));

      const rows = el("div", { class: "row-list" });
      for (const w of items) {
        const open = openSlotsFor(w);
        const first = open[0];
        rows.appendChild(el("div", { class: "row-item rv-waititem" },
          avatar({ name: store.patientName(w.patientId) }, 30),
          el("span", { class: "row-main" },
            el("span", { class: "row-title" }, `${store.patientName(w.patientId)}様`),
            el("span", { class: "row-sub" },
              `${fmtDate(w.date)}・${w.prefer}・${store.menuName(w.menuId)}`,
              w.note ? `・${w.note}` : "")),
          open.length
            ? badge(`空き ${open.length}枠`, "good")
            : badge("空きなし", "warn"),
          first
            ? el("button", {
                class: "btn primary sm",
                onclick: () => {
                  state.date = w.date;
                  openNewModal({ bedId: first.bedId, start: first.start, patientId: w.patientId, fromWaitlistId: w.id });
                },
              }, icon("plus", 13), `${first.start}に登録`)
            : null,
          el("button", {
            class: "icon-btn sm", title: "キャンセル待ちから外す", "aria-label": "キャンセル待ちから外す",
            onclick: () => {
              store.update("waitlist", w.id, { status: "closed" });
              toast("キャンセル待ちから外しました", "info");
              draw();
            },
          }, icon("x", 14))));
      }

      return card({
        title: "キャンセル待ち",
        sub: `${store.storeName(state.storeId)}・${items.length}件`,
        actions: el("button", { class: "btn ghost sm", onclick: openWaitlistModal }, icon("plus", 14), "追加"),
        body: items.length
          ? el("div", {}, rows,
              el("p", { class: "small muted", style: { marginTop: "10px", lineHeight: "1.7" } },
                "希望日・希望時間帯に空きがあると「◯◯に登録」ボタンが出ます。キャンセル記録時に「キャンセル待ちに登録」を選ぶと、ここに自動で追加されます。"))
          : emptyState({ icon: "🔔", title: "キャンセル待ちはありません", hint: "満枠のときは「追加」から希望を預かっておけます" }),
      });
    }

    /* ---------------- キャンセル理由の分析(直近30日) ---------------- */
    function buildCancelReasonCard() {
      const from = addDays(todayStr(), -30);
      const cancels = store.get("reservations").filter((r) =>
        r.storeId === state.storeId && r.date >= from && r.date <= todayStr()
        && (r.status === "cancelled" || r.status === "noshow"));

      // 「体調不良(補足)」の形で保存されるため、括弧の前までを集計キーにする
      const counts = new Map();
      for (const r of cancels) {
        const key = (r.cancelReason || "理由の記録なし").split("(")[0];
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const items = [...counts.entries()]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value);

      return card({
        title: "キャンセル理由の内訳",
        sub: `${store.storeName(state.storeId)}・直近30日・${cancels.length}件`,
        body: items.length
          ? el("div", {},
              hBars({
                items: items.map((it) => ({
                  label: it.label,
                  value: it.value,
                  color: it.label.startsWith("無断") ? "var(--critical)" : "var(--accent)",
                })),
                fmt: (v) => `${v}件`,
              }),
              el("p", { class: "small muted", style: { marginTop: "10px", lineHeight: "1.7" } },
                "キャンセル時に記録した理由を集計しています。「症状が改善したため」以外が多い場合は、日程調整やリマインドの見直しで防げる可能性があります。"))
          : emptyState({ icon: "🎉", title: "直近30日のキャンセルはありません" }),
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
      const free = Math.max(bedsFor(state.storeId).length * SLOTS.length - list.filter(isActive).length, 0);
      const statusCard = card({
        title: "この日の内訳",
        sub: store.storeName(state.storeId),
        body: el("div", {},
          kv("確定", `${byStatus("confirmed")}件`),
          kv("来院済", `${byStatus("done")}件`),
          kv("キャンセル", `${byStatus("cancelled")}件`),
          kv("無断キャンセル", `${byStatus("noshow")}件`),
          kv("空き枠(ベッド×時間)", dow(state.date) === CLOSED_DOW ? badge("定休日") : `${free}枠`)),
      });
      return el("div", { class: "grid cols-2 mt-16" }, donutCard, statusCard);
    }

    /* ---------------- 画面の組み立て ---------------- */
    function draw({ keepFocus = false } = {}) {
      const prevScroll = root.querySelector(".rv-scroll")?.scrollLeft || 0;
      const selStart = keepFocus ? root.querySelector(".rv-search")?.selectionStart : null;
      clear(root);
      root.append(
        sectionHeader("予約管理",
          "予約枠はベッド基軸。ドラッグで枠を移動でき、担当者の重複や時間切れの予約も自動で知らせます",
          [
            el("button", { class: "btn ghost", onclick: openWaitlistModal }, icon("bell", 16), "キャンセル待ち"),
            el("button", { class: "btn primary", onclick: () => openNewModal() }, icon("plus", 16), "新規予約"),
          ]),
        buildKpis(),
        buildToolbar(),
        buildOverdueCard(),
        state.view === "day" ? buildDayGrid()
          : state.view === "week" ? buildWeekGrid()
          : buildListView(),
        el("div", { class: "grid cols-2 mt-16" }, buildWaitlistCard(), buildCancelReasonCard()),
        buildBottom(),
      );
      const sc = root.querySelector(".rv-scroll");
      if (sc) sc.scrollLeft = prevScroll;
      if (keepFocus) {
        const s = root.querySelector(".rv-search");
        if (s) { s.focus(); if (selStart != null) s.setSelectionRange(selStart, selStart); }
      }
    }

    draw();
  },
};
