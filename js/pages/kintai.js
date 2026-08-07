/* ============================================================
   勤怠管理 ページ — ジンジャー代替
   GPS打刻(店舗200m圏内のみ有効)/責任者は最終確認のみ
   ============================================================ */
import { store, todayStr, addDays, monthOf, SHIFT_TYPES } from "../store.js";
import {
  el, clear, icon, card, sectionHeader, statTile, badge, statusBadge,
  avatar, table, chip, toast, modal, fmtDate,
} from "../ui.js";
import { can } from "../auth.js";

/* ---------------- helpers ---------------- */
const SVGNS = "http://www.w3.org/2000/svg";
function sv(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
}
const pad2 = (n) => String(n).padStart(2, "0");
const nowHM = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const toMin = (hm) => (hm ? Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)) : null);
const workedH = (a) => (a?.clockIn && a?.clockOut)
  ? Math.max(0, (toMin(a.clockOut) - toMin(a.clockIn) - (a.breakMin || 0)) / 60)
  : 0;
const shiftLabel = (type) => SHIFT_TYPES[type]?.label || "—";
const shiftRange = (type) => {
  const t = SHIFT_TYPES[type];
  return t?.start ? `${t.start}〜${t.end}` : "";
};

const GEOFENCE_M = 200;

export default {
  id: "kintai",
  title: "勤怠管理",
  icon: "clock",

  render(root) {
    const me = store.me();
    const today = todayStr();
    const myStoreName = store.storeName(me.storeId);
    // 承認キューは責任者(院長以上・本部人事)のみ。一般社員には表示しない
    const canApprove = can("kintai.approve", { storeId: me.storeId });

    /* ---- GPSシミュレーター状態(このページ表示中のみ) ---- */
    const sim = { dist: 140, located: false };

    const att = () => store.get("attendance");
    const myToday = () => att().find((a) => a.staffId === me.id && a.date === today);
    const myShiftToday = () => store.get("shifts").find((s) => s.staffId === me.id && s.date === today);
    const inRange = () => sim.dist <= GEOFENCE_M;

    /* ============================================================
       1. 本日の打刻(GPSシミュレーター付きメインカード)
       ============================================================ */

    // --- レーダーSVG ---
    const SIZE = 260, C = SIZE / 2, RMAX = 118;
    const rOf = (d) => RMAX * Math.sqrt(Math.max(0, Math.min(d, 500)) / 500);
    const ANG = -0.95; // 現在地の方角(固定)

    const svg = sv("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, class: "radar-svg", role: "img", "aria-label": "GPS距離レーダー" });
    for (const d of [100, 300, 400, 500]) svg.appendChild(sv("circle", { cx: C, cy: C, r: rOf(d), class: "ring" }));
    svg.appendChild(sv("circle", { cx: C, cy: C, r: rOf(200), class: "zone" }));
    svg.appendChild(sv("circle", { cx: C, cy: C, r: rOf(200), class: "ring r200" }));
    const ringLabel = sv("text", { x: C, y: C + rOf(200) + 13, "text-anchor": "middle", class: "ring-label" });
    ringLabel.textContent = "200m 打刻可能ライン";
    svg.appendChild(ringLabel);
    const userLine = sv("line", { x1: C, y1: C, x2: C, y2: C, class: "user-line" });
    svg.appendChild(userLine);
    svg.appendChild(sv("circle", { cx: C, cy: C, r: 8, class: "store-dot" }));
    svg.appendChild(sv("circle", { cx: C, cy: C, r: 3, class: "store-core" }));
    const storeLabel = sv("text", { x: C, y: C + 22, "text-anchor": "middle", class: "store-label" });
    storeLabel.textContent = myStoreName;
    svg.appendChild(storeLabel);
    const userG = sv("g", { class: "user-g", opacity: 0 });
    userG.appendChild(sv("circle", { cx: 0, cy: 0, r: 13, class: "user-pulse" }));
    userG.appendChild(sv("circle", { cx: 0, cy: 0, r: 6, class: "user-dot" }));
    svg.appendChild(userG);

    const sweep = el("div", { class: "gps-sweep" });
    const radarBox = el("div", { class: "gps-radar" }, svg, sweep);

    const distLabel = el("div", { class: "gps-dist" },
      el("span", { class: "th-dots-wrap" }, "現在地を取得中…"));

    const slider = el("input", {
      class: "gps-slider", type: "range", min: "0", max: "500", step: "5",
      value: String(sim.dist), disabled: true, "aria-label": "店舗からの距離(デモ用)",
    });
    slider.addEventListener("input", () => { sim.dist = Number(slider.value); updateGps(); });

    const nearBtn = el("button", { class: "btn ghost sm", disabled: true, onclick: () => {
      sim.dist = Math.max(0, sim.dist - 80); slider.value = String(sim.dist); updateGps();
    } }, icon("arrowDown", 13), "店舗に近づく");
    const farBtn = el("button", { class: "btn ghost sm", disabled: true, onclick: () => {
      sim.dist = Math.min(500, sim.dist + 80); slider.value = String(sim.dist); updateGps();
    } }, icon("arrowUp", 13), "店舗から離れる");

    const gpsCol = el("div", { class: "gps-box" },
      radarBox,
      distLabel,
      el("div", { class: "gps-sim" },
        el("div", { class: "gps-sim-head" }, icon("gps", 14), "GPSシミュレーター(デモ用に距離を動かせます)"),
        slider,
        el("div", { class: "gps-sim-btns" }, nearBtn, farBtn)),
    );

    // --- 右カラム(打刻状態・ボタン) ---
    const punchRight = el("div", { class: "punch-right" });

    function clockIn() {
      const hm = nowHM();
      const sh = myShiftToday();
      const start = sh && SHIFT_TYPES[sh.type]?.start;
      const status = start && toMin(hm) > toMin(start) ? "late" : "normal";
      const rec = myToday();
      if (rec) {
        store.update("attendance", rec.id, { clockIn: hm, status, gpsOk: true, approved: false, note: rec.status === "missing" ? "" : rec.note });
      } else {
        store.add("attendance", {
          staffId: me.id, date: today,
          shiftType: sh && sh.type !== "off" ? sh.type : "full",
          clockIn: hm, clockOut: null, breakMin: 60,
          status, gpsOk: true, approved: false, note: "",
        });
      }
      toast(`出勤打刻しました(${hm})${status === "late" ? " — 遅刻扱いです" : ""}`, status === "late" ? "info" : "success");
      refreshAll();
    }

    function clockOut() {
      const rec = myToday();
      if (!rec?.clockIn) return;
      const hm = nowHM();
      store.update("attendance", rec.id, { clockOut: hm });
      toast(`退勤打刻しました(${hm})お疲れさまでした!`);
      refreshAll();
    }

    function requestManual() {
      const rec = myToday();
      if (rec?.clockIn) { toast("本日はすでに打刻済みです", "info"); return; }
      if (rec && rec.status === "missing") { toast("申請済みです。責任者の承認をお待ちください", "info"); return; }
      const sh = myShiftToday();
      store.add("attendance", {
        staffId: me.id, date: today,
        shiftType: sh && sh.type !== "off" ? sh.type : "full",
        clockIn: null, clockOut: null, breakMin: 60,
        status: "missing", gpsOk: false, approved: false,
        note: "GPS圏外のため手動打刻を申請(責任者承認待ち)",
      });
      toast("責任者承認付きの手動打刻を申請しました");
      refreshAll();
    }

    function renderPunchRight() {
      clear(punchRight);
      const rec = myToday();
      const sh = myShiftToday();
      const ok = sim.located && inRange();
      const pending = rec && rec.status === "missing" && !rec.clockIn;

      // 状態バッジ
      let stateBadge;
      if (!sim.located) stateBadge = badge("測位中…", "", true);
      else if (inRange()) stateBadge = badge(`圏内(${myStoreName}から約${sim.dist}m)`, "good", true);
      else stateBadge = badge(`圏外(約${sim.dist}m)`, "critical", true);

      // 打刻時刻の大型表示
      const timeCell = (label, val) => el("div", { class: "pt" },
        el("div", { class: "pt-label" }, label),
        el("div", { class: `pt-time ${val ? "" : "empty"}` }, val || "--:--"));

      const inBtn = el("button", {
        class: "btn primary lg punch-btn",
        disabled: !ok || !!rec?.clockIn,
        onclick: clockIn,
      }, icon("clock", 18), rec?.clockIn ? "出勤済" : "出勤打刻");
      const outBtn = el("button", {
        class: "btn accent lg punch-btn",
        disabled: !ok || !rec?.clockIn || !!rec?.clockOut,
        onclick: clockOut,
      }, icon("check", 18), rec?.clockOut ? "退勤済" : "退勤打刻");

      punchRight.append(
        el("div", { class: "flex wrap", style: { gap: "8px" } },
          stateBadge,
          sh ? badge(`本日のシフト:${shiftLabel(sh.type)} ${shiftRange(sh.type)}`, "brand") : null,
          pending ? badge("手動打刻 申請中", "warn") : null),
        el("div", { class: "punch-times" },
          timeCell("出勤", rec?.clockIn),
          timeCell("退勤", rec?.clockOut)),
        el("div", { class: "punch-actions" }, inBtn, outBtn),
      );

      if (rec?.clockIn && rec?.clockOut) {
        punchRight.appendChild(el("div", { class: "punch-note good" },
          icon("check", 15),
          `本日の打刻は完了しています(実働 ${workedH(rec).toFixed(1)}h/休憩${rec.breakMin}分控除)`));
      } else if (sim.located && !inRange()) {
        punchRight.appendChild(el("div", { class: "punch-reason" },
          el("div", { class: "flex", style: { alignItems: "flex-start" } },
            icon("alert", 16),
            el("span", {}, `店舗から${GEOFENCE_M}mを超えているため打刻ボタンは無効です(現在 約${sim.dist}m)。店舗に近づいて再度お試しください。`)),
          el("button", { class: "btn danger sm", onclick: requestManual, disabled: !!pending },
            icon("edit", 14), pending ? "申請済み(承認待ち)" : "責任者承認付き手動打刻を申請")));
      } else if (sim.located && inRange() && !rec?.clockOut) {
        punchRight.appendChild(el("div", { class: "punch-note good" },
          icon("gps", 15), `打刻可能圏内です(${GEOFENCE_M}m以内)。位置情報は打刻時のみ記録されます。`));
      }
    }

    function updateGps() {
      radarBox.classList.toggle("in", inRange());
      radarBox.classList.toggle("out", !inRange());
      radarBox.classList.toggle("located", sim.located);
      if (sim.located) {
        const r = rOf(sim.dist);
        const x = C + r * Math.cos(ANG), y = C + r * Math.sin(ANG);
        userG.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`);
        userG.setAttribute("opacity", "1");
        userLine.setAttribute("x2", x.toFixed(1));
        userLine.setAttribute("y2", y.toFixed(1));
        clear(distLabel).append(
          `${myStoreName}から `, el("b", {}, `約${sim.dist}m`),
          el("span", { class: `gps-verdict ${inRange() ? "ok" : "ng"}` },
            inRange() ? "打刻できます" : "圏外です"));
      }
      renderPunchRight();
    }

    const punchCard = card({
      title: "本日の打刻",
      sub: `${fmtDate(today)}・GPS判定は${myStoreName}基準`,
      class: "punch-card",
      body: el("div", { class: "punch-wrap" }, gpsCol, punchRight),
    });

    // 測位アニメーション → 完了
    renderPunchRight();
    setTimeout(() => {
      sim.located = true;
      slider.disabled = false; nearBtn.disabled = false; farBtn.disabled = false;
      updateGps();
    }, 900);

    /* ============================================================
       2. 今日のチーム状況
       ============================================================ */
    const teamBody = el("div", { class: "row-list" });

    function renderTeam() {
      clear(teamBody);
      const members = store.get("staff").filter((s) => s.storeId === me.storeId);
      for (const s of members) {
        const sh = store.get("shifts").find((x) => x.staffId === s.id && x.date === today);
        const a = att().find((x) => x.staffId === s.id && x.date === today);
        let right, sub;
        if (sh?.type === "off" && !a) {
          right = badge("休み");
          sub = "本日は公休です";
        } else if (a?.clockOut) {
          right = badge(`退勤済 ${a.clockOut}`, "brand");
          sub = `${shiftLabel(a.shiftType)} ${shiftRange(a.shiftType)}・出勤 ${a.clockIn}`;
        } else if (a?.clockIn) {
          right = badge(`出勤済 ${a.clockIn}`, "good", true);
          sub = `${shiftLabel(a.shiftType)} ${shiftRange(a.shiftType)}`;
        } else if (a && a.status === "missing") {
          right = badge("手動申請中", "warn", true);
          sub = a.note || "責任者の承認待ち";
        } else {
          right = badge("未出勤", "warn");
          sub = sh ? `${shiftLabel(sh.type)} ${shiftRange(sh.type)} 予定` : "シフト未登録";
        }
        teamBody.appendChild(el("div", { class: "row-item" },
          avatar(s, 32),
          el("span", { class: "row-main" },
            el("span", { class: "row-title" }, s.name, s.id === me.id ? el("span", { class: "muted small", style: { marginLeft: "5px", fontWeight: "500" } }, "(自分)") : null),
            el("span", { class: "row-sub" }, `${s.role}・${sub}`)),
          right));
      }
    }

    const teamCard = card({
      title: "今日のチーム状況",
      sub: myStoreName,
      body: teamBody,
    });

    /* ============================================================
       3. 承認キュー(責任者向け)
       ============================================================ */
    const queueBody = el("div", {});

    const queueItems = () => att()
      .filter((a) => a.status === "missing" || !a.approved)
      .filter((a) => store.byId("staff", a.staffId)?.storeId === me.storeId)
      .sort((a, b) => {
        const pa = a.status === "missing" ? 0 : 1, pb = b.status === "missing" ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.date < b.date ? 1 : -1;
      });

    function openFixModal(a) {
      const t = SHIFT_TYPES[a.shiftType];
      const inI = el("input", { class: "input", type: "time", value: a.clockIn || t?.start || "09:30" });
      const outI = el("input", { class: "input", type: "time", value: a.clockOut || t?.end || "19:00" });
      const saveBtn = el("button", { class: "btn primary" }, icon("check", 15), "修正して承認");
      const cancelBtn = el("button", { class: "btn ghost" }, "キャンセル");
      const m = modal({
        title: `打刻修正 — ${store.staffName(a.staffId)}`,
        body: el("div", { class: "stack", style: { gap: "12px" } },
          el("p", { class: "muted", style: { fontSize: "var(--fs-sm)" } },
            `${fmtDate(a.date)}・${shiftLabel(a.shiftType)}(${shiftRange(a.shiftType) || "時間未定"})の打刻を修正します。修正内容は承認済みとして記録されます。`),
          el("div", { class: "form-row" },
            el("div", { class: "field" }, el("label", {}, "出勤時刻"), inI),
            el("div", { class: "field" }, el("label", {}, "退勤時刻"), outI))),
        actions: [cancelBtn, saveBtn],
      });
      cancelBtn.addEventListener("click", m.close);
      saveBtn.addEventListener("click", () => {
        const ci = inI.value, co = outI.value;
        if (!ci || !co) { toast("出勤・退勤の両方を入力してください", "error"); return; }
        if (toMin(co) <= toMin(ci)) { toast("退勤時刻は出勤時刻より後にしてください", "error"); return; }
        const start = SHIFT_TYPES[a.shiftType]?.start;
        const status = start && toMin(ci) > toMin(start) ? "late" : "normal";
        store.update("attendance", a.id, { clockIn: ci, clockOut: co, status, approved: true, note: "責任者が修正して承認" });
        m.close();
        toast(`${store.staffName(a.staffId)}さんの勤怠を修正して承認しました`);
        refreshAll();
      });
    }

    function approveOne(a) {
      store.update("attendance", a.id, { approved: true });
      toast(`${store.staffName(a.staffId)}さん(${fmtDate(a.date)})を承認しました`);
      refreshAll();
    }

    function approveAllNormal() {
      const targets = queueItems().filter((a) => a.status === "normal" && a.clockIn && a.clockOut);
      if (!targets.length) return;
      for (const a of targets) store.update("attendance", a.id, { approved: true });
      toast(`正常打刻 ${targets.length}件をまとめて承認しました`);
      refreshAll();
    }

    const bulkBtn = el("button", { class: "btn soft sm", onclick: approveAllNormal }, icon("check", 14), "正常分を一括承認");

    function renderQueue() {
      clear(queueBody);
      const items = queueItems();
      const normals = items.filter((a) => a.status === "normal" && a.clockIn && a.clockOut).length;
      bulkBtn.disabled = normals === 0;
      clear(bulkBtn).append(icon("check", 14), `正常分を一括承認(${normals}件)`);

      queueBody.appendChild(el("div", { class: "queue-copy" },
        icon("sparkle", 16),
        el("span", {}, "ジンジャーでの二重作業はなくなり、責任者は最終確認のみ。GPS打刻が正しい記録を自動で残します。")));

      if (!items.length) {
        queueBody.appendChild(el("div", { class: "punch-note good", style: { marginTop: "0" } },
          icon("check", 15), "承認待ちはありません。すべて確認済みです。"));
        return;
      }
      const list = el("div", { class: "queue-list" });
      for (const a of items) {
        const s = store.byId("staff", a.staffId);
        const canPlainApprove = !!(a.clockIn && a.clockOut);
        list.appendChild(el("div", { class: "queue-item" },
          el("div", { class: "q-top" },
            avatar(s, 30),
            el("span", { class: "row-main" },
              el("span", { class: "row-title" }, s?.name || "—"),
              el("span", { class: "row-sub" },
                `${fmtDate(a.date)}・${shiftLabel(a.shiftType)}・${a.clockIn || "--:--"} 〜 ${a.clockOut || "--:--"}`,
                a.note ? `・${a.note}` : "")),
            statusBadge(a.status)),
          el("div", { class: "q-actions" },
            el("button", { class: "btn primary sm", disabled: !canPlainApprove, onclick: () => approveOne(a) },
              icon("check", 13), "承認"),
            el("button", { class: "btn ghost sm", onclick: () => openFixModal(a) },
              icon("edit", 13), "修正して承認"))));
      }
      queueBody.appendChild(list);
    }

    const queueCard = card({
      title: "承認キュー",
      sub: `責任者向け・${myStoreName}`,
      actions: bulkBtn,
      body: queueBody,
    });

    /* ============================================================
       4. 月次サマリー(自分)
       ※ 総労働時間・平均稼働・直近の労働時間グラフは表示しない(現場要望)
       ============================================================ */
    const monthlyWrap = el("div", {});

    function renderMonthly() {
      clear(monthlyWrap);
      const month = monthOf(today);
      const mNum = Number(month.slice(5));
      const mine = att().filter((a) => a.staffId === me.id && monthOf(a.date) === month);
      const days = mine.filter((a) => a.clockIn).length;
      const lateN = mine.filter((a) => a.status === "late").length;

      monthlyWrap.appendChild(el("div", { class: "kpi-row kintai-kpi2" },
        statTile({ label: "出勤日数", value: `${days}日`, icon: "calendar", sub: `${mNum}月実績`, tone: "brand" }),
        statTile({ label: "遅刻回数", value: `${lateN}回`, icon: "alert", sub: lateN ? "気をつけましょう" : "順調です", tone: lateN ? "warn" : "good" }),
      ));
    }

    /* ============================================================
       5. 全員の勤怠テーブル(店舗フィルタ+直近7日)
       ============================================================ */
    const tblState = { storeId: me.storeId };
    const tblBody = el("div", {});

    function renderTable() {
      clear(tblBody);
      const chips = el("div", { class: "flex wrap", style: { marginBottom: "12px" } },
        chip("全店", { on: tblState.storeId === "all", onClick: () => { tblState.storeId = "all"; renderTable(); } }),
        store.get("stores").map((st) => chip(st.name, {
          on: tblState.storeId === st.id,
          onClick: () => { tblState.storeId = st.id; renderTable(); },
        })));

      const days = [];
      for (let i = 6; i >= 0; i--) days.push(addDays(today, -i));
      const staffRows = store.get("staff").filter((s) => tblState.storeId === "all" || s.storeId === tblState.storeId);

      const attMap = new Map();
      for (const a of att()) attMap.set(`${a.staffId}|${a.date}`, a);
      const shiftMap = new Map();
      for (const sh of store.get("shifts")) if (days.includes(sh.date)) shiftMap.set(`${sh.staffId}|${sh.date}`, sh);

      const columns = [
        {
          key: "name", label: "スタッフ",
          render: (s) => el("span", { class: "flex", style: { gap: "8px", whiteSpace: "nowrap" } },
            avatar(s, 26),
            el("span", {},
              el("span", { style: { display: "block", fontSize: "var(--fs-sm)", fontWeight: "700" } }, s.name),
              tblState.storeId === "all" ? el("span", { class: "small muted" }, store.storeName(s.storeId)) : null)),
        },
        ...days.map((d) => ({
          key: d, label: fmtDate(d), align: "center",
          render: (s) => {
            const a = attMap.get(`${s.id}|${d}`);
            if (a) return statusBadge(a.status);
            const sh = shiftMap.get(`${s.id}|${d}`);
            if (sh?.type === "off") return el("span", { class: "muted small" }, "休");
            return el("span", { class: "muted small" }, "—");
          },
        })),
      ];
      tblBody.append(chips, table({ columns, rows: staffRows }));
    }

    const tableCard = card({
      title: "全員の勤怠(直近7日)",
      sub: "正常/遅刻/打刻漏れをひと目で確認",
      body: tblBody,
    });

    /* ---------------- 一括リフレッシュ ---------------- */
    function refreshAll() {
      renderPunchRight();
      renderTeam();
      if (canApprove) renderQueue();
      renderMonthly();
      renderTable();
    }

    /* ---------------- レイアウト ---------------- */
    root.append(
      sectionHeader(
        "勤怠管理",
        "GPSで店舗200m圏内にいるときだけ打刻できます。打刻漏れは責任者の承認フローで処理されます。",
        badge("ジンジャー代替・成増店 先行導入", "accent"),
      ),
      punchCard,
      canApprove
        ? el("div", { class: "grid cols-2 mt-16" }, teamCard, queueCard)
        : el("div", { class: "mt-16" }, teamCard),
      el("h2", { class: "kintai-sec" }, "月次サマリー(自分)"),
      monthlyWrap,
      el("div", { class: "mt-16" }, tableCard),
    );

    renderTeam();
    if (canApprove) renderQueue();
    renderMonthly();
    renderTable();
  },
};
