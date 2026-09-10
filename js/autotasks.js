/* ============================================================
   自動タスク生成エンジン
   日々の業務のなかで「対応が必要な状態」になったものを、
   自動でタスクリストに積む。人が起票しなくても漏れない仕組み。

   ・在庫が発注点を下回った        → 発注する
   ・経費申請が承認待ち            → 承認する
   ・勤怠に未承認が残っている      → 承認する
   ・本日の売上報告が未提出        → 投稿する
   ・本日の日報が未提出            → 提出する
   ・翌月の希望休が未提出(締切前) → 提出する
   ・発注が入荷待ちのまま1週間超   → 入荷を確認する

   各タスクは autoKey で一意に管理し、二重に積まれない。
   条件が解消したときの扱いは resolve で決める:
     "remove" … タスクごと消す(その時点で対応が要らなくなるもの)
     "done"   … 完了にして残す(その日にやったことの記録になるもの)
   利用者が担当を振り替えたタスク(reassigned)は、担当を上書きしない。
   ============================================================ */

import { store, todayStr, addDays, monthOf } from "./store.js";

const pad2 = (n) => String(n).padStart(2, "0");
const fmtMD = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 毎月のお願い:1minuteアンケート(Googleフォーム) */
export const SURVEY_URL = "https://forms.gle/xjRUN51dF7Rj8vqs9";

/** その店舗の責任者(院長・店長)。いなければ社長にフォールバック */
function directorOf(storeId) {
  const list = store.get("staff") || [];
  return list.find((s) => s.storeId === storeId && ["院長", "店長"].includes(s.role))
    || list.find((s) => s.rank === "ceo")
    || list[0];
}

/** 日報・売上報告の対象になる現場スタッフか(本部人事・事務は対象外) */
const isFieldStaff = (s) => !["hr", "clerk"].includes(s.rank);

/** 翌月(YYYY-MM) */
function nextMonth(month) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/* ============================================================
   ルール:現時点で「必要なタスク」の一覧を組み立てる
   ============================================================ */
function desiredTasks() {
  const today = todayStr();
  const out = [];
  const add = (t) => out.push({ resolve: "remove", ...t });

  /* ---- 1. 在庫が発注点を下回った ---- */
  // 在庫は成増店で一括管理している運用に合わせる
  const invStoreId = "st-narimasu";
  const invOwner = directorOf(invStoreId);
  for (const it of store.get("inventory") || []) {
    if (it.stock >= it.min) continue;
    // すでに発注済み(入荷待ち)なら重ねて起票しない
    const pendingOrder = (store.get("orders") || [])
      .some((o) => o.itemId === it.id && o.status === "ordered");
    if (pendingOrder) continue;
    add({
      autoKey: `inv:${it.id}`,
      title: `${it.name}を発注する`,
      note: `在庫が発注点を下回りました(在庫 ${it.stock}${it.unit} / 発注点 ${it.min}${it.unit}・仕入先 ${it.supplier})。在庫・経費ページの「発注」から手配してください。`,
      ownerId: invOwner?.id,
      due: addDays(today, 2),
      source: { kind: "inventory", refId: it.id, label: "在庫アラート" },
    });
  }

  /* ---- 2. 経費・交通費の承認待ち ---- */
  for (const e of store.get("expenses") || []) {
    if (e.status !== "pending") continue;
    const applicant = store.byId("staff", e.staffId);
    const owner = directorOf(applicant?.storeId);
    if (!owner || owner.id === e.staffId) continue; // 自分の申請を自分で承認させない
    add({
      autoKey: `exp:${e.id}`,
      title: `${applicant?.name || "スタッフ"}さんの${e.category}申請を承認する`,
      note: `${fmtMD(e.date)}・¥${Number(e.amount).toLocaleString("ja-JP")}「${e.memo || "メモなし"}」。在庫・経費ページの「経費申請」タブから承認・却下できます。`,
      ownerId: owner.id,
      due: addDays(e.date, 3),
      source: { kind: "expense", refId: e.id, label: "経費申請" },
    });
  }

  /* ---- 3. 勤怠の未承認(店舗ごとにまとめる) ---- */
  const unapproved = new Map(); // storeId → 件数
  for (const a of store.get("attendance") || []) {
    if (a.approved || a.date >= today) continue;
    const s = store.byId("staff", a.staffId);
    if (!s) continue;
    unapproved.set(s.storeId, (unapproved.get(s.storeId) || 0) + 1);
  }
  for (const [storeId, count] of unapproved) {
    if (count < 3) continue; // 数件は日常。溜まってきたら起票する
    const owner = directorOf(storeId);
    add({
      autoKey: `att:${storeId}`,
      title: `${store.storeName(storeId)}の勤怠を承認する(${count}件)`,
      note: "未承認の打刻が溜まっています。勤怠管理の承認キューから「正常分を一括承認」できます。給与の締めに間に合うよう処理してください。",
      ownerId: owner?.id,
      due: addDays(today, 3),
      source: { kind: "kintai", refId: storeId, label: "勤怠の承認" },
    });
  }

  /* ---- 4. 本日の売上報告が未提出(店舗の代表者) ---- */
  for (const st of store.get("stores") || []) {
    const reported = (store.get("posts") || [])
      .some((p) => p.type === "uriage" && p.storeId === st.id && (p.date || "").startsWith(today));
    if (reported) continue;
    const owner = directorOf(st.id);
    add({
      autoKey: `uriage:${st.id}:${today}`,
      resolve: "done",
      title: `${st.name}の売上報告を投稿する(本日分)`,
      note: "締め後に、売上・来患数・新患数・キャンセル数と消化率の写真を投稿してください。全スタッフのタイムラインに共有されます。",
      ownerId: owner?.id,
      due: today,
      source: { kind: "uriage", refId: st.id, label: "毎日の業務" },
    });
  }

  /* ---- 5. 本日の日報が未提出 ---- */
  for (const s of store.get("staff") || []) {
    if (!isFieldStaff(s)) continue;
    const submitted = (store.get("dailyReports") || [])
      .some((r) => r.staffId === s.id && r.date === today && r.status === "submitted");
    if (submitted) continue;
    add({
      autoKey: `nippo:${s.id}:${today}`,
      resolve: "done",
      title: "日報を提出する(本日分)",
      note: "退勤打刻の前に「日報」ページから提出しましょう。このタスクは毎日自動で追加されます。",
      ownerId: s.id,
      due: today,
      source: { kind: "nippo", refId: null, label: "毎日の業務" },
    });
  }

  /* ---- 6. 希望休が未提出(締切は対象月の前月20日) ----
     20日を過ぎたら翌月分の締切は終わっているので、次に締切が来る月へ切り替える */
  const dayOfMonth = Number(today.slice(8, 10));
  const beforeDeadline = dayOfMonth <= 20;
  const targetMonth = beforeDeadline
    ? nextMonth(monthOf(today))
    : nextMonth(nextMonth(monthOf(today)));
  const deadline = beforeDeadline
    ? `${monthOf(today)}-20`
    : `${nextMonth(monthOf(today))}-20`;
  for (const s of store.get("staff") || []) {
    const submitted = (store.get("shiftRequests") || [])
      .some((r) => r.staffId === s.id && r.month === targetMonth);
    if (submitted) continue;
    add({
      autoKey: `wish:${s.id}:${targetMonth}`,
      resolve: "done",
      title: `${Number(targetMonth.slice(5))}月の希望休を提出する`,
      note: `締切は ${Number(deadline.slice(5, 7))}/${Number(deadline.slice(8))} 21:00です。シフト管理の「希望休を申請(月単位)」から提出してください(理由の記入は任意です)。`,
      ownerId: s.id,
      due: deadline,
      source: { kind: "shift", refId: targetMonth, label: "希望休の提出" },
    });
  }

  /* ---- 7. 入荷待ちのまま1週間を超えた発注 ---- */
  for (const o of store.get("orders") || []) {
    if (o.status !== "ordered") continue;
    if (o.date > addDays(today, -7)) continue;
    add({
      autoKey: `order:${o.id}`,
      title: `${o.itemName}の入荷を確認する`,
      note: `${fmtMD(o.date)}に${o.supplier}へ発注してから1週間以上が経過しています。納期を確認し、届いていれば在庫・経費ページの「入荷」から記録してください。`,
      ownerId: o.staffId,
      due: addDays(today, 1),
      source: { kind: "order", refId: o.id, label: "発注の追跡" },
    });
  }

  /* ---- 8. 毎月のお願い(1minuteアンケート・交通費申請) ----
     以前は社内SNSの脇に置いていたが、月ごとのタスクとして全員に積む。
     期限は月末。済んだかどうかは本人がタスクを完了にして記録する(自動では閉じない)。 */
  const month = monthOf(today);
  const monthEnd = addDays(nextMonth(month) + "-01", -1);
  const mLabel = `${Number(month.slice(5))}月分`;
  for (const s of store.get("staff") || []) {
    add({
      autoKey: `survey:${s.id}:${month}`,
      resolve: "keep",
      title: `1minuteアンケートに回答する(${mLabel})`,
      note: `所要1分・月1回。Googleフォームで回答したら、このタスクを完了にしてください。\n${SURVEY_URL}`,
      ownerId: s.id,
      due: monthEnd,
      source: { kind: "survey", refId: SURVEY_URL, label: "毎月のお願い" },
    });
    // 交通費は現場スタッフだけ(本部人事・事務は申請の確認側)
    if (!isFieldStaff(s)) continue;
    const applied = (store.get("expenses") || [])
      .some((e) => e.staffId === s.id && e.category === "交通費" && monthOf(e.date) === month);
    if (applied) continue;
    add({
      autoKey: `transport:${s.id}:${month}`,
      resolve: "done",
      title: `交通費を申請する(${mLabel})`,
      note: "月1回。領収書画像+金額+区間(どこからどこまで)+距離を、在庫・経費ページの「経費申請」から申請してください。申請すると自動で完了になります。",
      ownerId: s.id,
      due: monthEnd,
      source: { kind: "transport", refId: null, label: "毎月のお願い" },
    });
  }

  return out.filter((t) => t.ownerId);
}

/* ============================================================
   同期:必要なタスクを積み、不要になったものを片付ける
   ============================================================ */

/**
 * 自動タスクを現在の状況に合わせる。
 * @returns {{added:number, closed:number}} 追加・クローズした件数
 */
export function syncAutoTasks() {
  const me = store.me();
  if (!me) return { added: 0, closed: 0 };
  const today = todayStr();

  // 本番(サーバー同期あり)では「自分のタスクは自分の端末が積む」。
  // 他人のぶんまで積むと、その人の名前では書けない(RLS)うえ、
  // 端末ごとに同じタスクが二重に積まれてしまう。
  // デモでは全員分を積んで、権限切替で見え方を体験できるようにする。
  const live = (store.state.seedMode || "demo") === "live";
  const mineOnly = (t) => !live || t.ownerId === me.id;

  const desired = desiredTasks().filter(mineOnly);
  const desiredByKey = new Map(desired.map((d) => [d.autoKey, d]));
  const existingByKey = new Map();
  for (const t of store.get("tasks") || []) if (t.autoKey && mineOnly(t)) existingByKey.set(t.autoKey, t);

  let added = 0;
  let closed = 0;

  // --- 必要なタスクを積む / 内容を最新化する ---
  for (const d of desired) {
    const ex = existingByKey.get(d.autoKey);
    if (!ex) {
      store.add("tasks", {
        title: d.title,
        note: d.note,
        ownerId: d.ownerId,
        createdBy: live ? me.id : d.ownerId,
        due: d.due || null,
        status: "todo",
        progress: 0,
        source: d.source,
        createdAt: today,
        auto: true,
        autoKey: d.autoKey,
        autoResolve: d.resolve,
      });
      added++;
      continue;
    }
    // 件数などが変わるタイトル・メモは追随させる(状態は触らない)。
    // 担当を振り替え済みのタスクは、その担当を尊重して上書きしない。
    const patch = {};
    if (ex.title !== d.title) patch.title = d.title;
    if (ex.note !== d.note) patch.note = d.note;
    if (!ex.reassigned && ex.ownerId !== d.ownerId && ex.status !== "done") patch.ownerId = d.ownerId;
    if (Object.keys(patch).length) store.update("tasks", ex.id, patch);
  }

  // --- 条件が解消したタスクを片付ける ---
  for (const [key, t] of existingByKey) {
    if (desiredByKey.has(key)) continue;
    if (t.autoResolve === "keep") continue;           // 月が変わっても残す(未対応なら期限超過のまま)
    if (t.autoResolve === "done") {
      if (t.status !== "done") {
        store.update("tasks", t.id, { status: "done", progress: 100 });
        closed++;
      }
    } else {
      store.remove("tasks", t.id);
      closed++;
    }
  }

  return { added, closed };
}

/** 自動タスクの発生元ごとの遷移先(タスク画面からワンタップで現場へ) */
export const AUTO_SOURCE_LINK = {
  inventory: () => "backoffice",
  expense: () => "backoffice/expense",
  kintai: () => "kintai",
  uriage: () => "uriage",
  nippo: () => "nippo",
  shift: () => "shift",
  order: () => "backoffice",
  transport: () => "backoffice/expense",
  // アンケートは外部(Googleフォーム)なので、ページ遷移ではなく別タブで開く
  survey: () => { window.open(SURVEY_URL, "_blank", "noopener"); return null; },
};
