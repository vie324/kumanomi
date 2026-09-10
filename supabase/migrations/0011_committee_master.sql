-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 11:委員会マスタ(固定の6つ)
--
-- 会社の委員会はこの 6 つで固定。画面のプルダウンはこの一覧から選ぶ。
-- 何度流しても同じ 6 つにそろう(名前・アイコンを合わせ直し、在籍に戻す)。
-- 登録すると 0010 のトリガが委員会ごとのチャットルームを自動で作る。
-- ============================================================

insert into public.committees (code, name, icon, description, sort_order, is_active) values
  ('cm-recruit',    '採用委員会',     '🤝', '採用活動・面接調整・母集団づくり',       1, true),
  ('cm-marketing',  'マーケ委員会',   '📈', '集客・LINE配信・キャンペーン企画',       2, true),
  ('cm-philosophy', '理念浸透委員会', '🧭', '理念の言語化と浸透施策',                 3, true),
  ('cm-env',        '環境委員会',     '🌿', '院内環境・衛生・備品',                   4, true),
  ('cm-tech',       '技術委員会',     '✋', '手技研鑽・症例共有・技術研修運営',       5, true),
  ('cm-traffic',    '交通事故委員会', '🚗', '交通事故対応・保険手続きの知見共有',     6, true)
on conflict (code) do update set
  name        = excluded.name,
  icon        = excluded.icon,
  description = excluded.description,
  sort_order  = excluded.sort_order,
  is_active   = true;

-- 委員会ルームの名前とアイコンもマスタに合わせる(参加者は所属から自動)
update public.chat_rooms r
   set name = c.name,
       icon = c.icon
  from public.committees c
 where r.auto_key = 'committee:' || c.code
   and (r.name is distinct from c.name or r.icon is distinct from c.icon);
