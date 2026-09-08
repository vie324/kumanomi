/* ============================================================
   日報 — 数字を入れるだけ。集計と評価連携は自動。
   入力項目:個人売上 / 施術数(新患込み) / 新患数 / 成約数 / コメント(振り返り)
   ※ 報告文のAI処理・AI下書きは行わない(現場の言葉をそのまま残す方針)
   タブ:提出する / みんなの日報 / メンティーの日報 / 自分の推移

   閲覧範囲はすべて auth.visibleStaff() に従う。
   統括=全社 / エリア=担当店舗 / 院長=自店舗 / メンター=自分+メンティー / 一般=自分のみ
   ============================================================ */

import {
  el, clear, icon, card, sectionHeader, tabs, segmented, table,
  statTile, badge, statusBadge, toast, modal,
  avatar, staffChip, emptyState, fmtYen, fmtNum, fmtDate,
} from "../ui.js";
import { store, todayStr, addDays, monthOf, dow, SHIFT_TYPES } from "../store.js";
import { lineChart, sparkline } from "../charts.js";
import {
  can, visibleStaff, canSeeStaff, visibilityReason, scopeLabel,
  myMentor, myMentees, rankLabel, rankLevel,
} from "../auth.js";

/* ---------------- ページ状態(再描画をまたいで保持) ---------------- */
const state = {
  tab: "submit",       // submit | all | mentee | me
  date: todayStr(),    // みんなの日報の表示日
  dateTouched: false,  // ユーザーが日付を動かしたか(初期表示日の自動選択に使う)
  storeFilter: "all",
};

/** 「未確認」として扱う日数(直近◯日以内の提出分) */
const UNREAD_DAYS = 7;

/** 催促を送った相手(デモ用・セッション内のみ保持) */
const reminded = new Set();

const PRACTITIONER_ROLES = ["院長", "柔道整復師", "鍼灸師"];

/* ---------------- 共通ヘルパー ---------------- */

const p2 = (n) => String(n).padStart(2, "0");

/** 閲覧できるスタッフID(auth の判定をそのまま使う) */
function visibleIds() {
  return new Set(visibleStaff().map((s) => s.id));
}

/** 閲覧できるスタッフが所属する店舗だけ */
function visibleStores() {
  const ids = new Set(visibleStaff().map((s) => s.storeId));
  return store.get("stores").filter((s) => ids.has(s.id));
}

/** 提出対象者(閲覧範囲内の施術者) */
function targetStaff(storeId = "all") {
  return visibleStaff().filter((s) =>
    PRACTITIONER_ROLES.includes(s.role) && (storeId === "all" || s.storeId === storeId));
}

/** その日の日報(閲覧範囲内のみ) */
function reportsOn(date, storeId = "all") {
  const ids = visibleIds();
  return store.get("dailyReports").filter((r) =>
    r.date === date && ids.has(r.staffId) && (storeId === "all" || r.storeId === storeId));
}

function myReportOn(date) {
  const me = store.me();
  return store.get("dailyReports").find((r) => r.staffId === me.id && r.date === date) || null;
}

/** その人の日報を新しい順に */
function reportsOfStaff(staffId) {
  return store.get("dailyReports")
    .filter((r) => r.staffId === staffId)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 今月の営業日(水曜定休を除く。upto までで打ち切り) */
function monthBusinessDays(month, upto) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  const days = [];
  for (let d = 1; d <= last; d++) {
    const ds = `${y}-${p2(m)}-${p2(d)}`;
    if (upto && ds > upto) break;
    if (dow(ds) === 3) continue;
    days.push(ds);
  }
  return days;
}

/** 当月の自分(または指定者)の提出率 */
function monthSubmissionRate(staffId = null) {
  const id = staffId || store.me().id;
  const month = monthOf(todayStr());
  const days = monthBusinessDays(month, todayStr());
  const subs = store.get("dailyReports").filter((r) =>
    r.staffId === id && monthOf(r.date) === month && r.status === "submitted");
  return {
    month,
    submitted: subs.length,
    days: days.length,
    rate: days.length ? Math.round((subs.length / days.length) * 100) : 0,
  };
}

/** 日報の提出対象者(施術者)かどうか */
function isPractitioner(staff) { return PRACTITIONER_ROLES.includes(staff?.role); }

/** メンターコメントを返せるか(責任者以上 or その人のメンター) */
function canComment(targetStaffId) {
  const me = store.me();
  if (!me || me.id === targetStaffId) return false;
  if (!canSeeStaff(targetStaffId)) return false;
  return rankLevel(me) >= 3 || (me.menteeIds || []).includes(targetStaffId);
}

/** 「まだ確認していない日報」= 直近7日で提出済み・メンターコメント未記入 */
function isUnread(r) {
  return r.status === "submitted" && !r.mentorComment
    && r.date >= addDays(todayStr(), -(UNREAD_DAYS - 1));
}

/** 「なぜ見えるのか」バッジ */
function reasonBadge(staffId) {
  const reason = visibilityReason(staffId);
  if (!reason) return null;
  const kind = reason === "自分" ? "brand" : reason === "メンティー" ? "accent" : "";
  return el("span", { class: `badge nippo-reason ${kind}` }, icon("eye", 11), reason);
}

/* ---------------- 提出状況 ---------------- */

function submissionStats(date, storeId = "all") {
  const members = targetStaff(storeId);
  const reports = reportsOn(date, storeId);
  const byStaff = new Map(reports.map((r) => [r.staffId, r]));
  const submitted = members.filter((s) => byStaff.get(s.id)?.status === "submitted");
  const drafts = members.filter((s) => byStaff.get(s.id)?.status === "draft");
  const missing = members.filter((s) => !byStaff.has(s.id));
  return {
    members, submitted, drafts, missing,
    holiday: dow(date) === 3,
    rate: members.length ? Math.round((submitted.length / members.length) * 100) : 0,
  };
}

/**
 * 「みんなの日報」の初期表示日。
 * 当日はまだ締切前で提出0件のことがあるため、提出のある直近の営業日を選ぶ。
 */
function defaultDate() {
  const t = todayStr();
  const meId = store.me().id;
  let fallback = null;
  for (let off = 0; off >= -10; off--) {
    const d = addDays(t, off);
    if (dow(d) === 3) continue;
    const st = submissionStats(d, "all");
    if (!st.submitted.length) continue;
    if (fallback == null) fallback = d;
    // 自分の日報も並ぶ日を優先(比較しやすいため)
    if (st.submitted.some((s) => s.id === meId)) return d;
  }
  return fallback || t;
}

/** 催促チップ(クリックで催促) */
function remindChip(s, date, goSubmit) {
  if (s.id === store.me().id) {
    return el("button", { class: "nippo-remind self", onclick: goSubmit },
      avatar(s, 22),
      el("span", { class: "nippo-remind-name" }, "あなた"),
      el("span", { class: "nippo-remind-act" }, icon("edit", 13), "いま提出する"));
  }
  const key = `${date}:${s.id}`;
  const done = reminded.has(key);
  const label = el("span", { class: "nippo-remind-name" }, s.name);
  const btn = el("button", {
    class: `nippo-remind ${done ? "done" : ""}`,
    title: `${store.storeName(s.storeId)}・${s.role}`,
  }, avatar(s, 22), label,
    el("span", { class: "nippo-remind-act" }, icon(done ? "check" : "bell", 13), done ? "催促済" : "催促する"));
  btn.addEventListener("click", () => {
    if (reminded.has(key)) return;
    reminded.add(key);
    btn.classList.add("done");
    const act = btn.querySelector(".nippo-remind-act");
    clear(act).append(icon("check", 13), "催促済");
    toast(`${s.name}さんに催促を送りました`);
  });
  return btn;
}

/**
 * 提出率リング(依存ゼロの SVG)。
 * charts.js の donut は 100%(単一セグメント)で円弧が縮退するため専用に描く。
 */
function submissionRing(st) {
  const NS = "http://www.w3.org/2000/svg";
  const size = 132, sw = 13;
  const r = (size - sw) / 2;
  const C = 2 * Math.PI * r;
  const n = st.members.length || 1;

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");

  const arc = (color, frac, offsetFrac) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", size / 2);
    c.setAttribute("cy", size / 2);
    c.setAttribute("r", r);
    c.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
    Object.assign(c.style, {
      fill: "none",
      stroke: color,
      strokeWidth: `${sw}px`,
      strokeLinecap: frac > 0 && frac < 1 ? "round" : "butt",
      strokeDasharray: `${C * Math.min(frac, 1)} ${C}`,
      strokeDashoffset: `${-C * offsetFrac}`,
    });
    return c;
  };

  const sF = st.submitted.length / n;
  const dF = st.drafts.length / n;
  svg.appendChild(arc("var(--hairline-strong)", 1, 0));
  if (dF > 0) svg.appendChild(arc("var(--warn)", dF, sF));
  if (sF > 0) svg.appendChild(arc("var(--good)", sF, 0));

  const lg = (color, label, value) => el("span", { class: "nippo-ring-lgitem" },
    el("span", { class: "nippo-ring-sw", style: { background: color } }),
    el("span", { class: "nippo-ring-lglabel" }, label),
    el("strong", {}, `${value}名`));

  return el("div", { class: "nippo-ringwrap" },
    el("div", { class: "nippo-ring" }, svg,
      el("div", { class: "nippo-ring-center" },
        el("span", { class: "nippo-ring-val" }, `${st.rate}%`),
        el("span", { class: "nippo-ring-lbl" }, "提出率"))),
    el("div", { class: "nippo-ring-legend" },
      lg("var(--good)", "提出済", st.submitted.length),
      st.drafts.length ? lg("var(--warn)", "下書き", st.drafts.length) : null,
      st.missing.length ? lg("var(--hairline-strong)", "未提出", st.missing.length) : null));
}

/** 提出状況カード(みんなの日報タブの主役) */
function submissionCard(date, storeId, goSubmit) {
  const st = submissionStats(date, storeId);
  const isToday = date >= todayStr();

  if (st.holiday) {
    return el("div", { class: "nippo-subcard holiday" },
      el("div", { class: "nippo-subcard-note" },
        icon("info", 16),
        el("span", {}, el("strong", {}, "この日は定休日(水曜)です。"), "日報の提出対象はありません。")));
  }
  if (!st.members.length) {
    return el("div", { class: "nippo-subcard" },
      el("div", { class: "nippo-subcard-note" },
        icon("info", 16),
        el("span", {}, "この条件で表示できる提出対象者はいません。")));
  }

  const ring = submissionRing(st);

  const chips = el("div", { class: "nippo-missing" });
  if (st.missing.length) {
    chips.append(el("span", { class: "nippo-missing-label" }, icon("alert", 13), `未提出 ${st.missing.length}名`));
    st.missing.forEach((s) => chips.appendChild(remindChip(s, date, goSubmit)));
  } else {
    chips.append(el("span", { class: "nippo-allin" }, icon("check", 14), "全員提出済みです。おつかれさまでした!"));
  }

  return el("div", { class: `nippo-subcard ${st.rate >= 100 ? "full" : ""}` },
    el("div", { class: "nippo-subgrid" },
      el("div", { class: "nippo-subring" }, ring),
      el("div", { class: "nippo-subinfo" },
        el("div", { class: "nippo-subtitle" }, icon("clipboard", 15), `${fmtDate(date)} の提出状況`),
        el("div", { class: "nippo-subbig" },
          el("strong", {}, fmtNum(st.submitted.length)),
          el("span", { class: "nippo-subbig-unit" }, "提出"),
          el("span", { class: "nippo-subbig-sep" }, "/"),
          el("span", { class: "nippo-subbig-total" }, `対象 ${st.members.length}名`)),
        el("div", { class: "nippo-subbar" },
          el("span", { class: "nippo-subbar-fill good", style: { width: `${(st.submitted.length / st.members.length) * 100}%` } }),
          el("span", { class: "nippo-subbar-fill warn", style: { width: `${(st.drafts.length / st.members.length) * 100}%` } })),
        el("div", { class: "nippo-subtags" },
          st.drafts.length
            ? badge(`下書きのまま ${st.drafts.length}名`, "warn", true)
            : badge("下書きの取り残しなし", "good", true),
          badge(isToday ? "締切:退勤打刻の前まで" : "締切:当日の退勤打刻まで", "accent"),
          isToday ? badge("本日は集計中", "") : null),
        chips,
        el("div", { class: "nippo-subhint" },
          icon("info", 13),
          "未提出の方には退勤打刻時に自動リマインドが表示されます。催促はチャットにも届きます。"))));
}

/** 提出状況(サイドカード用の小さな表示) */
function submissionStatusEl(date, storeId = "all") {
  const wrap = el("div", { class: "nippo-substatus" });
  if (dow(date) === 3) {
    wrap.append(icon("info", 14), el("span", {}, "この日は定休日(水曜)のため提出対象はありません。"));
    return wrap;
  }
  const st = submissionStats(date, storeId);
  wrap.append(
    el("span", { class: "nippo-subcount" },
      icon("clipboard", 14), `提出済 ${st.submitted.length}/${st.members.length}名`),
    st.drafts.length ? badge(`下書き ${st.drafts.length}名`, "warn") : null,
  );
  if (st.missing.length) {
    wrap.appendChild(el("span", { class: "nippo-sublabel" }, "未提出:"));
    for (const s of st.missing) {
      wrap.appendChild(el("span", { class: "nippo-subchip", title: `${store.storeName(s.storeId)}・${s.role}` },
        avatar(s, 17), s.name.split(" ")[0]));
    }
  } else if (st.members.length) {
    wrap.appendChild(badge("全員提出済み", "good", true));
  }
  return wrap;
}

/** 評価自動連携の案内バッジ */
function evalNote() {
  return el("div", { class: "nippo-evalnote" },
    icon("check", 16),
    el("span", {},
      el("strong", {}, "この数値は人事評価に自動連携されます"),
      "(手作業の集計は不要です)"));
}

/* ---------------- 日報の詳細モーダル ---------------- */

const numTile = (label, value, tone = "") => el("div", { class: `nippo-dnum ${tone}` },
  el("span", { class: "nippo-dnum-l" }, label),
  el("span", { class: "nippo-dnum-v" }, value));

/** その日のシフト・勤怠(あれば) */
function attendanceBlock(r) {
  const sh = store.get("shifts").find((s) => s.staffId === r.staffId && s.date === r.date);
  const at = store.get("attendance").find((a) => a.staffId === r.staffId && a.date === r.date);
  if (!sh && !at) {
    return el("div", { class: "nippo-dnote muted" }, "この日のシフト・勤怠記録はありません。");
  }
  const rows = el("div", { class: "nippo-datt" });
  if (sh) {
    const t = SHIFT_TYPES[sh.type];
    rows.appendChild(el("span", { class: "nippo-dattitem" },
      icon("calendar", 14),
      el("span", { class: "l" }, "シフト"),
      el("strong", {}, t ? `${t.label}${t.start ? ` ${t.start}〜${t.end}` : ""}` : sh.type)));
  }
  if (at) {
    rows.appendChild(el("span", { class: "nippo-dattitem" },
      icon("clock", 14),
      el("span", { class: "l" }, "打刻"),
      el("strong", {}, `${at.clockIn || "—"} 〜 ${at.clockOut || "—"}`),
      statusBadge(at.status)));
    if (at.note) {
      rows.appendChild(el("span", { class: "nippo-dattitem" },
        icon("info", 14), el("span", { class: "l" }, "備考"), el("strong", {}, at.note)));
    }
  }
  return rows;
}

/** 直近7日の売上ミニ推移 */
function recentTrend(r) {
  const mine = store.get("dailyReports").filter((x) => x.staffId === r.staffId);
  const byDate = new Map(mine.map((x) => [x.date, x]));
  const labels = [];
  const values = [];
  for (let off = -6; off <= 0; off++) {
    const d = addDays(r.date, off);
    const [, m, dd] = d.split("-").map(Number);
    labels.push(`${m}/${dd}`);
    values.push(byDate.get(d)?.revenue || 0);
  }
  return lineChart({
    series: [{ name: "売上", values }],
    labels,
    fillFirst: true,
    showDots: true,
    height: 160,
    yFmt: (v) => (v >= 1000 ? `¥${Math.round(v / 1000)}k` : `¥${Math.round(v)}`),
  });
}

/**
 * 日報詳細モーダル。list 内を ← → で移動できる。
 * openReport(list, index, onChanged)
 */
function openReport(list, index, onChanged) {
  if (!list.length) return;
  let i = Math.max(0, Math.min(index, list.length - 1));

  const body = el("div", { class: "nippo-detail" });
  const prevBtn = el("button", { class: "btn ghost sm" }, icon("chevL", 15), "前の日報");
  const nextBtn = el("button", { class: "btn ghost sm" }, "次の日報", icon("chevR", 15));
  const pos = el("span", { class: "nippo-dpos" });

  const m = modal({
    title: "日報の詳細",
    wide: true,
    body,
    actions: [prevBtn, pos, nextBtn],
  });
  m.el.classList.add("nippo-modal");

  const paint = () => {
    const r = list[i];
    const s = store.byId("staff", r.staffId);
    clear(body);

    /* --- ヘッダー --- */
    body.appendChild(el("div", { class: "nippo-dhead" },
      staffChip(r.staffId, { size: 42 }),
      el("div", { class: "nippo-dhead-meta" },
        el("span", { class: "nippo-ddate" }, fmtDate(r.date, { withYear: true })),
        el("span", { class: "nippo-dtags" },
          statusBadge(r.status),
          reasonBadge(r.staffId)))));

    /* --- 数字(個人売上・施術数(新患込み)・新患数・成約数) --- */
    body.appendChild(el("div", { class: "nippo-dnums solo" },
      numTile("個人売上", fmtYen(r.revenue), "wide"),
      numTile("施術数(新患込み)", `${fmtNum(r.treatments)}件`),
      numTile("新患数", `${fmtNum(r.newPatients)}名`),
      numTile("成約数", `${fmtNum(r.contracts)}件`)));

    /* --- コメント全文 --- */
    body.appendChild(el("section", { class: "nippo-dsec" },
      el("h4", {}, icon("chat", 15), "本人コメント(全文)"),
      r.comment
        ? el("p", { class: "nippo-dcomment" }, r.comment)
        : el("p", { class: "nippo-dnote muted" }, "コメントの記入はありません。")));

    /* --- シフト・勤怠 --- */
    body.appendChild(el("section", { class: "nippo-dsec" },
      el("h4", {}, icon("clock", 15), "この日のシフト・勤怠"),
      attendanceBlock(r)));

    /* --- 直近7日推移 --- */
    body.appendChild(el("section", { class: "nippo-dsec" },
      el("h4", {}, icon("trend", 15), "直近7日の売上推移"),
      recentTrend(r)));

    /* --- メンター/責任者コメント --- */
    const mayComment = canComment(r.staffId);
    if (r.mentorComment || mayComment) {
      const sec = el("section", { class: "nippo-dsec nippo-dmentor" },
        el("h4", {}, icon("heart", 15), "メンター・責任者からのコメント"));
      if (r.mentorComment) {
        sec.appendChild(el("div", { class: "nippo-dmc" },
          el("div", { class: "nippo-dmc-head" },
            avatar(store.byId("staff", r.mentorCommentBy), 22),
            el("strong", {}, store.staffName(r.mentorCommentBy)),
            r.mentorCommentAt ? el("span", { class: "small muted" }, fmtDate(r.mentorCommentAt)) : null),
          el("p", {}, r.mentorComment)));
      }
      if (mayComment) {
        const ta = el("textarea", {
          class: "textarea", rows: "3",
          placeholder: `${s?.name || ""}さんへのひとこと(良かった点・次の一歩)`,
        });
        ta.value = r.mentorComment || "";
        const save = el("button", { class: "btn primary sm" }, icon("send", 15),
          r.mentorComment ? "コメントを更新する" : "コメントを送る");
        save.addEventListener("click", () => {
          const v = ta.value.trim();
          if (!v) { toast("コメントを入力してください", "error"); return; }
          store.update("dailyReports", r.id, {
            mentorComment: v,
            mentorCommentBy: store.me().id,
            mentorCommentAt: todayStr(),
          });
          toast(`${s?.name || ""}さんにコメントを送りました`);
          onChanged?.();
          paint();
        });
        sec.appendChild(
          el("div", { class: "nippo-dmc-form" }, ta,
            el("div", { class: "flex between wrap", style: { gap: "8px" } },
              el("span", { class: "small muted" }, "コメントは本人と評価面談の記録に共有されます"),
              save)));
      }
      body.appendChild(sec);
    } else if (r.staffId === store.me().id) {
      body.appendChild(el("section", { class: "nippo-dsec" },
        el("h4", {}, icon("heart", 15), "メンターからのコメント"),
        el("p", { class: "nippo-dnote muted" }, "まだコメントは届いていません。")));
    }

    /* --- ナビ --- */
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i >= list.length - 1;
    clear(pos).append(`${i + 1} / ${list.length}件`);
    body.scrollTop = 0;
    body.parentElement?.scrollTo?.(0, 0);
  };

  prevBtn.addEventListener("click", () => { if (i > 0) { i--; paint(); } });
  nextBtn.addEventListener("click", () => { if (i < list.length - 1) { i++; paint(); } });
  paint();
  return m;
}

/* ---------------- タブ1:提出する ---------------- */

/** 自分のメンターカード */
function myMentorCard() {
  const mentor = myMentor();
  if (!mentor) return null;
  return card({
    title: "あなたのメンター",
    class: "pad-sm",
    body: el("div", { class: "nippo-mentorcard" },
      staffChip(mentor.id, { size: 38 }),
      el("div", { class: "nippo-mentornote" },
        icon("heart", 14),
        el("span", {}, "提出した日報は", el("strong", {}, `${mentor.name}さん`), "にも共有されます。気になることはコメントで相談できます。"))),
  });
}

function submitTab(renderAll) {
  const me = store.me();
  const mentor = myMentor();

  const numInput = (name) => el("input", {
    class: "input", type: "number", min: "0", step: "1", inputmode: "numeric",
    placeholder: "0", "aria-label": name,
  });
  const fDate = el("input", { class: "input", type: "date", value: todayStr(), max: todayStr() });
  const inRevenue = numInput("個人売上");
  const inTreat = numInput("施術数(新患込み)");
  const inNew = numInput("新患数");
  const inCont = numInput("成約数");
  const taComment = el("textarea", { class: "textarea", rows: "4", placeholder: "今日の振り返りを自分の言葉で(良かった点・課題・明日の一手)" });

  const collect = (ex) => ({
    revenue: Math.max(0, Number(inRevenue.value) || 0),
    treatments: Math.max(0, Number(inTreat.value) || 0),
    newPatients: Math.max(0, Number(inNew.value) || 0),
    contracts: Math.max(0, Number(inCont.value) || 0),
    // 画面からは外れた項目は既存値を引き継ぐ(過去データ互換)
    proposals: ex ? (ex.proposals || 0) : 0,
    goods: ex ? (ex.goods || 0) : 0,
    comment: taComment.value.trim(),
  });

  /* --- 既存日報の読み込み(同日分があれば上書き編集) --- */
  const existBadge = el("span", {});
  const submitBtn = el("button", { class: "btn primary lg block" }, icon("send", 17), "日報を提出する");

  const loadFor = (date) => {
    const ex = myReportOn(date);
    inRevenue.value = ex ? ex.revenue : "";
    inTreat.value = ex ? ex.treatments : "";
    inNew.value = ex ? ex.newPatients : "";
    inCont.value = ex ? ex.contracts : "";
    taComment.value = ex ? ex.comment : "";
    clear(existBadge);
    if (ex) {
      existBadge.append(statusBadge(ex.status),
        el("span", { class: "small muted" }, "この日の日報は入力済みです。修正して再提出できます"));
    }
    submitBtn.lastChild.textContent = ex ? "日報を更新する" : "日報を提出する";
  };
  fDate.addEventListener("change", () => loadFor(fDate.value));
  loadFor(todayStr());

  /* --- 提出 --- */
  submitBtn.addEventListener("click", () => {
    const date = fDate.value;
    if (!date) { toast("日付を入力してください", "error"); return; }
    if (date > todayStr()) { toast("未来の日付には提出できません", "error"); return; }
    const ex = myReportOn(date);
    const v = collect(ex);
    if (ex) {
      store.update("dailyReports", ex.id, { ...v, status: "submitted" });
      toast("日報を更新しました。おつかれさまでした!");
    } else {
      store.add("dailyReports", {
        staffId: me.id, storeId: me.storeId, date,
        ...v, aiSummary: null, status: "submitted",
      });
      toast("日報を提出しました。おつかれさまでした!");
    }
    // 「日報を提出する」デイリータスク(毎日自動追加)を完了にする
    const dailyTask = store.get("tasks").find((t) =>
      t.ownerId === me.id && t.source?.kind === "nippo" && t.due === date && t.status !== "done");
    if (dailyTask) store.update("tasks", dailyTask.id, { status: "done" });
    renderAll();
  });

  const field = (label, input, hint) => el("div", { class: "field" },
    el("label", {}, label), input,
    hint ? el("span", { class: "hint" }, hint) : null);

  const shareLine = mentor
    ? `提出すると院長・統括、そしてメンターの${mentor.name}さんに共有されます`
    : "提出すると院長・統括にリアルタイムで共有されます";

  const formCard = card({
    title: "日報を提出",
    sub: `${store.storeName(me.storeId)}・${me.name}`,
    body: el("div", { class: "stack", style: { gap: "14px" } },
      el("div", { class: "nippo-lead" },
        icon("sparkle", 15),
        "入力は1分で終わります。項目は「個人売上・施術数(新患込み)・新患数・成約数・コメント」の5つだけです。"),
      el("div", { class: "flex wrap", style: { gap: "12px" } },
        el("div", { class: "field nippo-datefield" }, el("label", {}, "日付"), fDate),
        existBadge),
      el("div", { class: "nippo-numgrid" },
        field("個人売上(円)", inRevenue),
        field("施術数(新患込み)", inTreat),
        field("新患数(人)", inNew),
        field("成約数(件)", inCont)),
      el("div", { class: "field" },
        el("label", {}, "コメント(振り返り)"),
        taComment,
        el("span", { class: "hint" }, "AIによる下書き・要約は行いません。自分の言葉がそのまま共有されます")),
      submitBtn,
      el("div", { class: "small muted", style: { textAlign: "center" } }, shareLine)),
  });

  /* --- サイド --- */
  const hasTeam = can("nippo.view") && visibleStaff().length > 1;
  const mine = monthSubmissionRate();
  const myRecent = reportsOfStaff(me.id).slice(0, 6);

  const side = el("div", { class: "stack", style: { gap: "16px" } },
    myMentorCard(),
    hasTeam
      ? card({
        title: "本日の提出状況",
        sub: scopeLabel(),
        class: "pad-sm",
        body: submissionStatusEl(todayStr(), "all"),
      })
      : (isPractitioner(me) ? card({
        title: "今月のあなたの提出率",
        sub: `${Number(mine.month.slice(5, 7))}月`,
        class: "pad-sm",
        body: el("div", { class: "nippo-substatus" },
          el("span", { class: "nippo-subcount" }, icon("clipboard", 14), `${mine.rate}%`),
          el("span", { class: "small muted" }, `${mine.submitted}日 / 営業日 ${mine.days}日`)),
      }) : null),
    myRecent.length ? card({
      title: "自分の最近の日報",
      sub: "クリックで中身を確認",
      class: "pad-sm",
      body: el("div", { class: "nippo-minilist" },
        myRecent.map((r, idx) => el("button", {
          class: "nippo-minirow",
          onclick: () => openReport(myRecent, idx, renderAll),
        },
          el("span", { class: "nippo-minidate" }, fmtDate(r.date)),
          el("span", { class: "nippo-miniyen" }, fmtYen(r.revenue)),
          r.mentorComment ? badge("コメントあり", "accent") : null,
          statusBadge(r.status),
          icon("chevR", 14)))),
    }) : null,
    evalNote());

  return el("div", { class: "nippo-grid" }, formCard, side);
}

/* ---------------- タブ2:みんなの日報 ---------------- */

function allTab(renderAll) {
  const wrap = el("div", { class: "stack", style: { gap: "16px" } });
  const isToday = state.date >= todayStr();
  const stores = visibleStores();

  /* --- 日付ナビ + 店舗フィルタ --- */
  const goDate = (d) => { state.date = d; state.dateTouched = true; renderAll(); };
  const goSubmit = () => { state.tab = "submit"; renderAll(); };

  const nav = el("div", { class: "nippo-datenav" },
    el("button", {
      class: "icon-btn nav-chev", "aria-label": "前日",
      onclick: () => goDate(addDays(state.date, -1)),
    }, icon("chevL", 18)),
    el("span", { class: "nippo-dateval" },
      fmtDate(state.date, { withYear: true }),
      isToday ? badge("今日", "accent") : (!state.dateTouched ? badge("最新の提出日", "") : null)),
    el("button", {
      class: "icon-btn nav-chev", "aria-label": "翌日", disabled: isToday,
      onclick: () => goDate(addDays(state.date, 1)),
    }, icon("chevR", 18)),
    !isToday ? el("button", {
      class: "btn ghost sm",
      onclick: () => goDate(todayStr()),
    }, "今日へ") : null);

  const seg = stores.length > 1 ? segmented(
    [{ id: "all", label: "全店" }, ...stores.map((s) => ({ id: s.id, label: s.short }))],
    state.storeFilter,
    (id) => { state.storeFilter = id; renderAll(); }) : null;

  wrap.appendChild(el("div", { class: "nippo-controls" }, nav, seg));
  wrap.appendChild(submissionCard(state.date, state.storeFilter, goSubmit));

  /* --- テーブル(+合計行) --- */
  const reports = reportsOn(state.date, state.storeFilter)
    .slice().sort((a, b) => b.revenue - a.revenue);

  let tableEl;
  if (!reports.length) {
    tableEl = emptyState({
      icon: dow(state.date) === 3 ? "🌙" : "🗂",
      title: dow(state.date) === 3 ? "定休日(水曜)です" : "この日の日報はまだありません",
      hint: dow(state.date) === 3 ? "日報の提出対象日ではありません" : "前日・翌日で移動できます",
    });
  } else {
    const sum = (k) => reports.reduce((a, r) => a + (r[k] || 0), 0);
    const totalRow = {
      __total: true,
      revenue: sum("revenue"), treatments: sum("treatments"), newPatients: sum("newPatients"),
      contracts: sum("contracts"),
    };
    const b = (v) => el("strong", {}, v);
    tableEl = table({
      columns: [
        { key: "staffId", label: "スタッフ", render: (r) => r.__total
            ? el("span", { class: "flex", style: { gap: "7px" } }, b("合計"), el("span", { class: "small muted" }, `${reports.length}名`))
            : el("span", { class: "nippo-staffcell" }, staffChip(r.staffId), reasonBadge(r.staffId)) },
        { key: "revenue", label: "個人売上", align: "right", render: (r) => r.__total ? b(fmtYen(r.revenue)) : fmtYen(r.revenue) },
        { key: "treatments", label: "施術(新患込み)", align: "right", render: (r) => r.__total ? b(fmtNum(r.treatments)) : fmtNum(r.treatments) },
        { key: "newPatients", label: "新患", align: "right", render: (r) => r.__total ? b(fmtNum(r.newPatients)) : fmtNum(r.newPatients) },
        { key: "contracts", label: "成約", align: "right", render: (r) => r.__total ? b(fmtNum(r.contracts)) : fmtNum(r.contracts) },
        { key: "status", label: "状態", align: "center", render: (r) => r.__total ? "" : statusBadge(r.status) },
        { key: "open", label: "", align: "center", render: (r) => r.__total ? "" :
            el("span", { class: "nippo-open" }, "中身を見る", icon("chevR", 14)) },
      ],
      rows: [...reports, totalRow],
      onRowClick: (r) => {
        if (r.__total) return;
        openReport(reports, reports.indexOf(r), renderAll);
      },
    });
  }
  wrap.appendChild(card({
    title: "みんなの日報",
    sub: `${fmtDate(state.date)}・行をクリックすると中身(コメント全文)が開きます`,
    body: tableEl,
  }));

  return wrap;
}

/* ---------------- タブ3:メンティーの日報 ---------------- */

function menteeUnreadCount() {
  return myMentees().reduce((a, s) =>
    a + reportsOfStaff(s.id).slice(0, 14).filter(isUnread).length, 0);
}

function menteeTab(renderAll) {
  const mentees = myMentees();
  const wrap = el("div", { class: "stack", style: { gap: "16px" } });

  wrap.appendChild(el("div", { class: "nippo-mentorlead" },
    icon("heart", 16),
    el("span", {},
      el("strong", {}, `あなたは ${mentees.length}名のメンターです。`),
      "メンティーの日報は店舗をまたいで確認できます。コメントを返すと本人と評価面談の記録に残ります。")));

  for (const s of mentees) {
    const list = reportsOfStaff(s.id).slice(0, 10);
    const unread = list.filter(isUnread).length;
    const mine = monthSubmissionRate(s.id);
    const last = list[0];

    const rows = list.length
      ? el("div", { class: "nippo-mentee-list" },
        list.map((r, idx) => el("button", {
          class: `nippo-mentee-row ${isUnread(r) ? "unread" : ""}`,
          onclick: () => openReport(list, idx, renderAll),
        },
          el("span", { class: "nippo-mentee-date" }, fmtDate(r.date)),
          el("span", { class: "nippo-mentee-comment" },
            r.comment || el("span", { class: "muted" }, "コメントなし")),
          el("span", { class: "nippo-mentee-meta" },
            el("span", { class: "nippo-mentee-yen" }, fmtYen(r.revenue)),
            el("span", { class: "small muted" }, `成約 ${fmtNum(r.contracts)}件`),
            isUnread(r) ? badge("未確認", "warn", true) : (r.mentorComment ? badge("返信済", "good") : statusBadge(r.status)),
            icon("chevR", 14)))))
      : emptyState({ icon: "🗂", title: "日報がまだありません" });

    wrap.appendChild(card({
      title: s.name,
      sub: `${store.storeName(s.storeId)}・${s.role}`,
      class: "nippo-menteecard",
      actions: el("span", { class: "flex", style: { gap: "6px" } },
        unread ? badge(`未確認 ${unread}件`, "warn", true) : badge("すべて確認済み", "good"),
        badge(`今月の提出率 ${mine.rate}%`, mine.rate >= 90 ? "good" : mine.rate >= 70 ? "accent" : "warn")),
      body: el("div", { class: "stack", style: { gap: "10px" } },
        el("div", { class: "nippo-mentee-head" },
          avatar(s, 38),
          el("div", { class: "nippo-mentee-headmeta" },
            el("span", {}, "直近の提出:", el("strong", {}, last ? fmtDate(last.date, { withYear: true }) : "—")),
            el("span", { class: "small muted" }, `今月 ${mine.submitted}日提出 / 営業日 ${mine.days}日`))),
        rows),
    }));
  }

  return wrap;
}

/* ---------------- タブ4:自分の推移 ---------------- */

function meTab(renderAll) {
  const me = store.me();
  const my = store.get("dailyReports").filter((r) => r.staffId === me.id);
  const byDate = new Map(my.map((r) => [r.date, r]));

  /* --- 直近30日の売上ライン --- */
  const labels = [];
  const values = [];
  for (let off = -29; off <= 0; off++) {
    const d = addDays(todayStr(), off);
    const [, m, dd] = d.split("-").map(Number);
    labels.push(`${m}/${dd}`);
    values.push(byDate.get(d)?.revenue || 0);
  }
  const chart = lineChart({
    series: [{ name: "売上", values }],
    labels,
    fillFirst: true,
    height: 240,
    yFmt: (v) => (v >= 1000 ? `¥${Math.round(v / 1000)}k` : `¥${Math.round(v)}`),
  });

  /* --- 今月の合計 --- */
  const month = monthOf(todayStr());
  const inMonth = my.filter((r) => monthOf(r.date) === month);
  const sum = (k) => inMonth.reduce((a, r) => a + (r[k] || 0), 0);
  const monthLabel = `${Number(month.slice(5, 7))}月の実績`;
  const spark = sparkline({ values: values.slice(-14), width: 90, height: 30 });
  const sub = monthSubmissionRate();

  const recent = reportsOfStaff(me.id).slice(0, 8);

  return el("div", { class: "stack", style: { gap: "16px" } },
    evalNote(),
    el("div", { class: "kpi-row" },
      statTile({
        label: `提出率(${monthLabel})`, value: `${sub.rate}%`, icon: "clipboard",
        tone: sub.rate >= 90 ? "good" : sub.rate >= 70 ? "brand" : "warn",
        sub: `${sub.submitted}日提出 / 営業日 ${sub.days}日`,
      }),
      statTile({ label: `個人売上(${monthLabel})`, value: fmtYen(sum("revenue")), icon: "cash", tone: "brand", sub: "自動集計", spark }),
      statTile({ label: `施術数(${monthLabel})`, value: `${fmtNum(sum("treatments"))}件`, icon: "body", tone: "accent", sub: `新患込み・新患 ${fmtNum(sum("newPatients"))}名` }),
      statTile({ label: `成約数(${monthLabel})`, value: `${fmtNum(sum("contracts"))}件`, icon: "ticket", tone: "good", sub: "自動集計" })),
    card({
      title: "直近30日の売上推移",
      sub: `${me.name}(提出済みの日報から自動生成)`,
      body: chart,
    }),
    recent.length ? card({
      title: "自分の日報",
      sub: "行をクリックすると中身とメンターコメントを確認できます",
      body: el("div", { class: "nippo-minilist" },
        recent.map((r, idx) => el("button", {
          class: "nippo-minirow lg",
          onclick: () => openReport(recent, idx, renderAll),
        },
          el("span", { class: "nippo-minidate" }, fmtDate(r.date, { withYear: true })),
          el("span", { class: "nippo-minicomment" }, r.comment || el("span", { class: "muted" }, "コメントなし")),
          el("span", { class: "nippo-miniyen" }, fmtYen(r.revenue)),
          r.mentorComment ? badge("コメントあり", "accent") : null,
          statusBadge(r.status),
          icon("chevR", 14)))),
    }) : null);
}

/* ---------------- 閲覧範囲バー ---------------- */

function scopeBar() {
  const me = store.me();
  const bar = el("div", { class: "nippo-scopebar" },
    el("span", { class: "nippo-scope", title: `権限:${rankLabel(me)}` },
      icon("eye", 14),
      el("span", { class: "nippo-scope-l" }, "閲覧範囲"),
      el("strong", {}, scopeLabel())));

  if (isPractitioner(me)) {
    const s = monthSubmissionRate();
    bar.appendChild(el("span", { class: `nippo-myrate ${s.rate >= 90 ? "good" : s.rate < 70 ? "warn" : ""}` },
      icon("clipboard", 14),
      el("span", { class: "nippo-myrate-l" }, `今月の自分の提出率`),
      el("strong", {}, `${s.rate}%`),
      el("span", { class: "nippo-myrate-s" }, `${s.submitted}/${s.days}営業日`)));
  }
  return bar;
}

/* ---------------- ページ本体 ---------------- */

export default {
  id: "nippo",
  title: "日報",
  icon: "report",

  // このページが必要とするデータ。ルーターがそろえてから render() を呼ぶ
  needs: ["attendance", "dailyReports", "shifts", "staff", "stores", "tasks"],
  render(root, params) {
    if (params?.[0] && ["submit", "all", "mentee", "me"].includes(params[0])) state.tab = params[0];

    const renderAll = () => {
      clear(root);

      const showAll = can("nippo.view") && visibleStaff().length > 1;
      const mentees = myMentees();
      const showMentee = mentees.length > 0;

      // 店舗フィルタが閲覧範囲外なら「全店」に戻す
      const okStores = new Set(visibleStores().map((s) => s.id));
      if (state.storeFilter !== "all" && !okStores.has(state.storeFilter)) state.storeFilter = "all";

      // 初期表示日:提出のある直近の営業日(ユーザーが日付を動かすまで)
      if (showAll && !state.dateTouched) state.date = defaultDate();

      const items = [{ id: "submit", label: "提出する" }];
      if (showAll) items.push({ id: "all", label: "みんなの日報" });
      if (showMentee) {
        const un = menteeUnreadCount();
        items.push({ id: "mentee", label: "メンティーの日報", badge: un || null });
      }
      items.push({ id: "me", label: "自分の推移" });
      if (!items.some((i) => i.id === state.tab)) state.tab = "submit";

      root.append(
        sectionHeader("日報", "個人売上・施術数(新患込み)・新患数・成約数・コメントの5項目だけ。権限に応じて見える範囲が変わります。"),
        scopeBar(),
        tabs(items, state.tab, (id) => { state.tab = id; renderAll(); }),
        state.tab === "submit" ? submitTab(renderAll)
          : state.tab === "all" ? allTab(renderAll)
          : state.tab === "mentee" ? menteeTab(renderAll)
          : meTab(renderAll));
    };
    renderAll();
  },
};
