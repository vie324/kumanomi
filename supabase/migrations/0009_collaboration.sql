-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 09:みんなで使う部分
--
-- ここまでは「自分の記録」(勤怠・日報)が中心だった。
-- この移行で、アカウント同士が連動する部分をサーバーへ移す。
--
--   投稿 posts                … 連絡事項・タイムライン・サンクスギフト・売上報告
--   タスク tasks              … 振り分け・進捗・期限
--   チャット chat_rooms / chat_messages
--   研修 trainings / training_reports … 研修ごとのレポート(全員が読める)
--   始末書 incident_reports   … 業務改善書 / 始末書(組織図の上の人が読める)
--   予算 budgets              … 店舗 × 月の売上予算(ダッシュボードの「予算比」)
--   写真 members.photo_url    … プロフィール写真(Storage の avatars バケット)
--
-- 人を指す列は uuid(members.id)で持ち、アプリ側の社員番号とは
-- ビューの INSTEAD OF トリガで読み替える(0007 と同じ作り)。
-- 「いいね」「既読」「メンバー」のように人の配列を持つ列は、
-- 読み替えの手間を省くため社員番号の text[] のまま持つ。
-- ============================================================

-- ------------------------------------------------------------
-- 共通ヘルパー
-- ------------------------------------------------------------

-- ログイン中の人の社員番号(text[] 列と突き合わせる用)
create or replace function app.current_employee_no()
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select m.employee_no from public.members m where m.id = app.current_member_id();
$$;

-- 社員番号 → uuid(0007 で定義済み。無い環境のために再定義)
create or replace function app.member_id_of(p_employee_no text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_catalog
as $$ select id from public.members where employee_no = p_employee_no; $$;

create or replace function app.store_id_of(p_code text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_catalog
as $$ select id from public.stores where code = p_code; $$;

-- uuid → 社員番号(ビューで返す用)
create or replace function app.employee_no_of(p_member uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$ select employee_no from public.members where id = p_member; $$;

-- ============================================================
-- 1. プロフィール写真
-- ============================================================
alter table public.members add column if not exists photo_url text;
comment on column public.members.photo_url is 'プロフィール写真(Storage の avatars バケットの公開URL)';

-- 名簿ビューに写真を足す(末尾への追加のみ。0002/0006 の列順は変えない)
drop view if exists public.v_member_directory;
create view public.v_member_directory
  with (security_invoker = true) as
select
  m.id,
  m.name_key,
  m.employee_no,
  m.full_name,
  m.kana,
  m.former_name,
  m.gender,
  case m.gender when 'male' then '男性' when 'female' then '女性' else '—' end as gender_label,
  m.license,
  case m.license
    when 'judo'        then '柔道整復師'
    when 'acupuncture' then '鍼灸師'
    when 'seitai'      then '整体師'
    when 'esthetic'    then 'エステティシャン'
    when 'reception'   then '受付'
    when 'none'        then '資格なし'
    else '未確認'
  end as license_label,
  m.rank,
  app.rank_label(m.rank) as rank_label,
  app.rank_level(m.rank) as rank_level,
  m.role_title,
  m.department,
  case m.department
    when 'seitai'      then '整体部門'
    when 'beauty'      then '美容部門'
    when 'reception'   then '受付スタッフ'
    when 'management'  then 'マネジメント'
    else '本部'
  end as department_label,
  s.id   as store_id,
  s.name as store_name,
  s.category as store_category,
  mgr.id   as manager_id,
  mgr.full_name as manager_name,
  mgr.role_title as manager_role,
  (select count(*) from app.subtree_ids(m.id)) as subordinate_count,
  (select count(*) from public.mentorships ms where ms.mentor_id = m.id and ms.ended_on is null) as mentee_count,
  m.joined_on,
  m.is_active,
  s.code   as store_code,
  mgr.employee_no as manager_employee_no,
  m.color,
  m.employment,
  m.sort_order,
  m.photo_url
from public.members m
left join public.stores  s   on s.id = m.primary_store_id
left join public.members mgr on mgr.id = m.reports_to_id;

comment on view public.v_member_directory is
  'メンバー名簿。store_code / manager_employee_no はアプリ側の安定キー。photo_url はプロフィール写真';
grant select on public.v_member_directory to authenticated;

-- 自分の写真は自分で直せる(0004 の members_update_self がそのまま効く)

-- Storage:avatars バケット(公開読み取り・本人だけ書き込み)
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read on storage.objects
  for select using (bucket_id = 'avatars');

-- パスは "社員番号/ファイル名"。自分のフォルダにだけ書ける
drop policy if exists avatars_own_write on storage.objects;
create policy avatars_own_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = app.current_employee_no());

drop policy if exists avatars_own_update on storage.objects;
create policy avatars_own_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = app.current_employee_no());

drop policy if exists avatars_own_delete on storage.objects;
create policy avatars_own_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = app.current_employee_no());

-- ============================================================
-- 2. 投稿(社内SNS)
-- ============================================================
create table if not exists public.posts (
  id          uuid primary key default gen_random_uuid(),
  app_id      text        not null unique,
  author_id   uuid        not null references public.members (id) on delete cascade,
  post_type   text        not null,                 -- notice / timeline / chourei / philosophy / committee / thanks / uriage / free
  channel_id  text,                                 -- 'ch-all' など(チャンネルはアプリ側のマスタ)
  store_id    uuid        references public.stores (id) on delete set null,
  to_member   uuid        references public.members (id) on delete set null,  -- サンクスの宛先
  title       text,
  body        text        not null default '',
  points      integer     not null default 0,       -- サンクスのポイント
  pinned      boolean     not null default false,
  likes       text[]      not null default '{}',    -- 社員番号
  comments    jsonb       not null default '[]'::jsonb,
  uriage      jsonb,                                -- 売上報告 {sales, patients, newPatients, cancels}
  images      jsonb       not null default '[]'::jsonb, -- 添付画像(data URL の配列)
  posted_at   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists posts_posted_idx  on public.posts (posted_at desc);
create index if not exists posts_type_idx    on public.posts (post_type, posted_at desc);
create index if not exists posts_store_idx   on public.posts (store_id, posted_at desc);
comment on table public.posts is '社内SNSの投稿。連絡事項 / タイムライン / サンクスギフト / 売上報告 / チャンネル';

-- ============================================================
-- 3. タスク
-- ============================================================
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  app_id       text        not null unique,
  title        text        not null,
  note         text,
  owner_id     uuid        not null references public.members (id) on delete cascade,
  created_by   uuid        references public.members (id) on delete set null,
  due_on       date,
  status       text        not null default 'todo',   -- todo / doing / done
  progress     integer     not null default 0,        -- 0〜100
  source       jsonb       not null default '{}'::jsonb,
  is_auto      boolean     not null default false,
  auto_key     text,                                  -- 自動タスクの識別子(同じ条件で二重に積まない)
  auto_resolve text,                                  -- 条件が解消したとき remove / done / keep
  reassigned   boolean     not null default false,
  assign_log   jsonb       not null default '[]'::jsonb,
  alerted_at   timestamptz,                           -- 未完了アラートを最後に送った時刻
  completed_at timestamptz,
  created_on   date        not null default current_date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint tasks_status_ok check (status in ('todo', 'doing', 'done')),
  constraint tasks_progress_range check (progress between 0 and 100)
);
create index if not exists tasks_owner_idx on public.tasks (owner_id, status, due_on);
-- 同じ自動タスクは全社で 1 行(別の端末が同時に積んでも二重にならない)
create unique index if not exists tasks_auto_key_uniq on public.tasks (auto_key) where auto_key is not null;
comment on table public.tasks is 'タスク。振り分け履歴と進捗、未完了アラートの送信時刻を持つ';

-- ============================================================
-- 4. チャット
-- ============================================================
create table if not exists public.chat_rooms (
  id            uuid primary key default gen_random_uuid(),
  app_id        text        not null unique,
  kind          text        not null default 'group',  -- group / store / dm
  name          text        not null,
  icon          text,
  description   text,
  store_id      uuid        references public.stores (id) on delete set null,
  member_nos    text[]      not null default '{}',      -- 参加者の社員番号
  announce_only boolean     not null default false,
  pinned_message_app_id text,
  created_by    uuid        references public.members (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists chat_rooms_members_idx on public.chat_rooms using gin (member_nos);
comment on table public.chat_rooms is 'チャットルーム。参加者は社員番号の配列';

create table if not exists public.chat_messages (
  id           uuid primary key default gen_random_uuid(),
  app_id       text        not null unique,
  room_app_id  text        not null,
  author_id    uuid        not null references public.members (id) on delete cascade,
  sent_at      timestamptz not null default now(),
  body         text        not null default '',
  mentions     text[]      not null default '{}',        -- 社員番号
  reactions    jsonb       not null default '{}'::jsonb, -- {"👍": ["145","242"]}
  read_by      text[]      not null default '{}',        -- 社員番号
  reply_to_app_id text,
  attachment   jsonb,
  task_app_id  text,                                     -- このメッセージから作ったタスク
  edited       boolean     not null default false,
  deleted      boolean     not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists chat_messages_room_idx on public.chat_messages (room_app_id, sent_at);
comment on table public.chat_messages is 'チャットの発言。既読・リアクションは社員番号で持つ';

-- ============================================================
-- 5. 研修とレポート
-- ============================================================
create table if not exists public.trainings (
  id           uuid primary key default gen_random_uuid(),
  app_id       text        not null unique,
  title        text        not null,
  kind         text,                              -- 技術研修 / 鍼研修 / 座学
  held_on      date        not null,
  start_at     time,
  duration_min integer,
  required     boolean     not null default false,
  place        text,
  attendees    jsonb       not null default '[]'::jsonb,  -- [{staffId, status}]
  created_by   uuid        references public.members (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists trainings_date_idx on public.trainings (held_on desc);
comment on table public.trainings is '研修の予定と出欠';

create table if not exists public.training_reports (
  id               uuid primary key default gen_random_uuid(),
  app_id           text        not null unique,
  training_app_id  text        not null,
  author_id        uuid        not null references public.members (id) on delete cascade,
  body             text        not null default '',
  learned          text,                            -- 学んだこと
  apply_plan       text,                            -- 現場でどう活かすか
  status           text        not null default 'draft',   -- draft / submitted
  submitted_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint training_reports_one_per_person unique (training_app_id, author_id),
  constraint training_reports_status_ok check (status in ('draft', 'submitted'))
);
create index if not exists training_reports_training_idx on public.training_reports (training_app_id, submitted_at desc);
comment on table public.training_reports is '研修ごとのレポート。提出済みは全員が読める';

-- ============================================================
-- 6. 始末書・業務改善書
-- ============================================================
create table if not exists public.incident_reports (
  id              uuid primary key default gen_random_uuid(),
  app_id          text        not null unique,
  author_id       uuid        not null references public.members (id) on delete cascade,
  kind            text        not null default 'kaizen',   -- kaizen(業務改善書) / shimatsu(始末書)
  occurred_on     date        not null,
  conclusion      text        not null default '',          -- 結論・結果
  cause           text        not null default '',          -- 原因
  process_detail  text        not null default '',          -- 詳細な過程
  worst_case      text        not null default '',          -- 最悪の場合どうなっていたか
  prevention      text        not null default '',          -- どうすれば防げたか・改善点
  status          text        not null default 'draft',     -- draft / submitted / acknowledged
  submitted_at    timestamptz,
  acknowledged_by uuid        references public.members (id) on delete set null,
  acknowledged_at timestamptz,
  ack_comment     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint incident_kind_ok   check (kind in ('kaizen', 'shimatsu')),
  constraint incident_status_ok check (status in ('draft', 'submitted', 'acknowledged'))
);
create index if not exists incident_reports_author_idx on public.incident_reports (author_id, occurred_on desc);
comment on table public.incident_reports is '業務改善書・始末書。本人と、組織図で上にいる人が読める';

-- ============================================================
-- 7. 予算(店舗 × 月)
-- ============================================================
create table if not exists public.budgets (
  id         uuid primary key default gen_random_uuid(),
  app_id     text        not null unique,
  store_id   uuid        not null references public.stores (id) on delete cascade,
  month      text        not null,                 -- 'YYYY-MM'
  amount     bigint      not null default 0,       -- 売上予算(円)
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budgets_month_format check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint budgets_one_per_store_month unique (store_id, month)
);
comment on table public.budgets is '店舗ごとの月次売上予算。ダッシュボードの「予算に対しての%」の分母';

-- ------------------------------------------------------------
-- updated_at
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['posts', 'tasks', 'chat_rooms', 'chat_messages',
                           'trainings', 'training_reports', 'incident_reports', 'budgets'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format(
      'create trigger %I_touch before update on public.%I
         for each row execute function app.touch_updated_at()', t, t);
  end loop;
end $$;

-- ============================================================
-- 権限(RLS)
-- ============================================================
alter table public.posts            enable row level security;
alter table public.tasks            enable row level security;
alter table public.chat_rooms       enable row level security;
alter table public.chat_messages    enable row level security;
alter table public.trainings        enable row level security;
alter table public.training_reports enable row level security;
alter table public.incident_reports enable row level security;
alter table public.budgets          enable row level security;

-- ---------------- 投稿 ----------------
-- 読む:全社員。書く:本人。ピン留めと削除:院長以上
drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts
  for select to authenticated using (true);

drop policy if exists posts_insert on public.posts;
create policy posts_insert on public.posts
  for insert to authenticated
  with check (author_id = app.current_member_id());

-- いいね・コメントは誰でも付けられるので update は全員に開き、
-- 本文などは下のトリガで本人・責任者以外の変更を弾く
drop policy if exists posts_update on public.posts;
create policy posts_update on public.posts
  for update to authenticated using (true) with check (true);

drop policy if exists posts_delete on public.posts;
create policy posts_delete on public.posts
  for delete to authenticated
  using (author_id = app.current_member_id() or app.my_rank_level() >= 3);

-- 本人と責任者以外は「いいね」「コメント」しか変えられない
create or replace function app.guard_post_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if old.author_id = app.current_member_id() or app.my_rank_level() >= 3 then
    return new;
  end if;
  -- それ以外の人:いいね・コメント以外は元に戻す
  new.title      := old.title;
  new.body       := old.body;
  new.post_type  := old.post_type;
  new.channel_id := old.channel_id;
  new.store_id   := old.store_id;
  new.to_member  := old.to_member;
  new.points     := old.points;
  new.pinned     := old.pinned;
  new.uriage     := old.uriage;
  new.images     := old.images;
  new.posted_at  := old.posted_at;
  new.author_id  := old.author_id;
  return new;
end;
$$;
drop trigger if exists posts_guard on public.posts;
create trigger posts_guard before update on public.posts
  for each row execute function app.guard_post_update();

-- ---------------- タスク ----------------
-- 見える:担当 / 作成者 / 担当が傘の中
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select to authenticated
  using (
    owner_id = app.current_member_id()
    or created_by = app.current_member_id()
    or app.can_see_member(app.current_member_id(), owner_id)
  );

-- 作れる:誰でも(自分の名前で)。振り分け先は誰でもよい
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert to authenticated
  with check (created_by = app.current_member_id() or created_by is null);

-- 直せる:担当 / 作成者 / 傘の上の人
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update to authenticated
  using (
    owner_id = app.current_member_id()
    or created_by = app.current_member_id()
    or app.can_see_member(app.current_member_id(), owner_id)
  )
  with check (true);

drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks
  for delete to authenticated
  using (created_by = app.current_member_id() or owner_id = app.current_member_id() or app.my_rank_level() >= 3);

-- ---------------- チャット ----------------
-- ルーム:参加者だけ。作る:自分が参加者に入っていること
drop policy if exists chat_rooms_select on public.chat_rooms;
create policy chat_rooms_select on public.chat_rooms
  for select to authenticated
  using (app.current_employee_no() = any (member_nos) or app.my_rank_level() >= 6);

drop policy if exists chat_rooms_insert on public.chat_rooms;
create policy chat_rooms_insert on public.chat_rooms
  for insert to authenticated
  with check (app.current_employee_no() = any (member_nos));

drop policy if exists chat_rooms_update on public.chat_rooms;
create policy chat_rooms_update on public.chat_rooms
  for update to authenticated
  using (app.current_employee_no() = any (member_nos) or app.my_rank_level() >= 6)
  with check (true);

drop policy if exists chat_rooms_delete on public.chat_rooms;
create policy chat_rooms_delete on public.chat_rooms
  for delete to authenticated
  using (created_by = app.current_member_id() or app.my_rank_level() >= 6);

-- 発言:ルームの参加者だけ読める。書くのは本人
create or replace function app.is_room_member(p_room_app_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.chat_rooms r
     where r.app_id = p_room_app_id
       and (app.current_employee_no() = any (r.member_nos) or app.my_rank_level() >= 6)
  );
$$;

drop policy if exists chat_messages_select on public.chat_messages;
create policy chat_messages_select on public.chat_messages
  for select to authenticated using (app.is_room_member(room_app_id));

drop policy if exists chat_messages_insert on public.chat_messages;
create policy chat_messages_insert on public.chat_messages
  for insert to authenticated
  with check (author_id = app.current_member_id() and app.is_room_member(room_app_id));

-- 既読・リアクションは参加者なら誰でも。本文は下のトリガで本人だけに絞る
drop policy if exists chat_messages_update on public.chat_messages;
create policy chat_messages_update on public.chat_messages
  for update to authenticated
  using (app.is_room_member(room_app_id)) with check (true);

drop policy if exists chat_messages_delete on public.chat_messages;
create policy chat_messages_delete on public.chat_messages
  for delete to authenticated
  using (author_id = app.current_member_id());

create or replace function app.guard_message_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if old.author_id = app.current_member_id() then return new; end if;
  new.body        := old.body;
  new.mentions    := old.mentions;
  new.attachment  := old.attachment;
  new.reply_to_app_id := old.reply_to_app_id;
  new.edited      := old.edited;
  new.deleted     := old.deleted;
  new.author_id   := old.author_id;
  new.sent_at     := old.sent_at;
  new.room_app_id := old.room_app_id;
  -- task_app_id は「メッセージからタスク化」で他人も付けてよい
  return new;
end;
$$;
drop trigger if exists chat_messages_guard on public.chat_messages;
create trigger chat_messages_guard before update on public.chat_messages
  for each row execute function app.guard_message_update();

-- ---------------- 研修 ----------------
drop policy if exists trainings_select on public.trainings;
create policy trainings_select on public.trainings
  for select to authenticated using (true);

-- 予定を作る・消す:院長以上。
-- 出欠の回答(attendees)は本人が書くので update は全員に開き、
-- 予定の中身(題名・日時など)はトリガで院長以上に絞る
drop policy if exists trainings_write on public.trainings;
drop policy if exists trainings_insert on public.trainings;
create policy trainings_insert on public.trainings
  for insert to authenticated with check (app.my_rank_level() >= 3);
drop policy if exists trainings_update on public.trainings;
create policy trainings_update on public.trainings
  for update to authenticated using (true) with check (true);
drop policy if exists trainings_delete on public.trainings;
create policy trainings_delete on public.trainings
  for delete to authenticated using (app.my_rank_level() >= 3);

create or replace function app.guard_training_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if app.my_rank_level() >= 3 then return new; end if;
  -- 一般社員は出欠(attendees)だけ変えられる
  new.title        := old.title;
  new.kind         := old.kind;
  new.held_on      := old.held_on;
  new.start_at     := old.start_at;
  new.duration_min := old.duration_min;
  new.required     := old.required;
  new.place        := old.place;
  return new;
end;
$$;
drop trigger if exists trainings_guard on public.trainings;
create trigger trainings_guard before update on public.trainings
  for each row execute function app.guard_training_update();

-- レポート:提出済みは全員が読める。下書きは本人だけ
drop policy if exists training_reports_select on public.training_reports;
create policy training_reports_select on public.training_reports
  for select to authenticated
  using (status = 'submitted' or author_id = app.current_member_id());

drop policy if exists training_reports_write on public.training_reports;
create policy training_reports_write on public.training_reports
  for all to authenticated
  using (author_id = app.current_member_id())
  with check (author_id = app.current_member_id());

-- ---------------- 始末書・業務改善書 ----------------
-- 読める:本人 / 組織図で上の人 / 本部人事・社長
drop policy if exists incident_select on public.incident_reports;
create policy incident_select on public.incident_reports
  for select to authenticated
  using (
    author_id = app.current_member_id()
    or app.can_see_member(app.current_member_id(), author_id)
    or app.my_rank()::text in ('hr', 'ceo')
  );

-- 書く:本人だけ
drop policy if exists incident_insert on public.incident_reports;
create policy incident_insert on public.incident_reports
  for insert to authenticated
  with check (author_id = app.current_member_id());

-- 直す:本人(提出前)/ 上の人(確認済みにする)
drop policy if exists incident_update on public.incident_reports;
create policy incident_update on public.incident_reports
  for update to authenticated
  using (
    author_id = app.current_member_id()
    or app.can_see_member(app.current_member_id(), author_id)
    or app.my_rank()::text in ('hr', 'ceo')
  )
  with check (true);

drop policy if exists incident_delete on public.incident_reports;
create policy incident_delete on public.incident_reports
  for delete to authenticated
  using (author_id = app.current_member_id() and status = 'draft');

-- 上の人は「確認」しかできない(本文を書き換えられないように)
create or replace function app.guard_incident_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if old.author_id = app.current_member_id() then
    -- 本人:提出後は本文を変えられない。確認欄は触れない
    if old.status <> 'draft' then
      new.kind := old.kind; new.occurred_on := old.occurred_on;
      new.conclusion := old.conclusion; new.cause := old.cause;
      new.process_detail := old.process_detail; new.worst_case := old.worst_case;
      new.prevention := old.prevention;
      if old.status = 'acknowledged' then new.status := old.status; end if;
    end if;
    new.acknowledged_by := old.acknowledged_by;
    new.acknowledged_at := old.acknowledged_at;
    new.ack_comment     := old.ack_comment;
    return new;
  end if;
  -- 上の人:確認欄だけ
  new.kind := old.kind; new.occurred_on := old.occurred_on;
  new.conclusion := old.conclusion; new.cause := old.cause;
  new.process_detail := old.process_detail; new.worst_case := old.worst_case;
  new.prevention := old.prevention; new.author_id := old.author_id;
  new.submitted_at := old.submitted_at;
  if new.status = 'acknowledged' and old.status <> 'acknowledged' then
    new.acknowledged_by := app.current_member_id();
    new.acknowledged_at := now();
  elsif new.status <> old.status then
    new.status := old.status;
  end if;
  return new;
end;
$$;
drop trigger if exists incident_guard on public.incident_reports;
create trigger incident_guard before update on public.incident_reports
  for each row execute function app.guard_incident_update();

-- ---------------- 予算 ----------------
drop policy if exists budgets_select on public.budgets;
create policy budgets_select on public.budgets
  for select to authenticated using (true);

drop policy if exists budgets_write on public.budgets;
create policy budgets_write on public.budgets
  for all to authenticated
  using (app.my_rank_level() >= 6 or app.my_rank()::text = 'hr')
  with check (app.my_rank_level() >= 6 or app.my_rank()::text = 'hr');

grant select, insert, update, delete on
  public.posts, public.tasks, public.chat_rooms, public.chat_messages,
  public.trainings, public.training_reports, public.incident_reports, public.budgets
  to authenticated;

-- ============================================================
-- アプリ用ビュー(社員番号・店舗コードで返す)と書き込みトリガ
-- ============================================================

-- ---------------- posts ----------------
create or replace view public.v_app_posts
  with (security_invoker = true) as
select
  p.app_id                as id,
  p.post_type             as type,
  app.employee_no_of(p.author_id) as author_id,
  p.channel_id,
  st.code                 as store_id,
  app.employee_no_of(p.to_member) as to_id,
  p.title, p.body, p.points, p.pinned, p.likes, p.comments, p.uriage, p.images,
  p.posted_at             as date
from public.posts p
left join public.stores st on st.id = p.store_id;

create or replace function app.write_app_posts()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
declare v_author uuid;
begin
  if tg_op = 'DELETE' then delete from public.posts where app_id = old.id; return old; end if;
  if tg_op = 'UPDATE' then
    update public.posts set
      post_type = coalesce(new.type, post_type), channel_id = new.channel_id,
      store_id = coalesce(app.store_id_of(new.store_id), store_id),
      to_member = coalesce(app.member_id_of(new.to_id), to_member),
      title = new.title, body = coalesce(new.body, ''), points = coalesce(new.points, 0),
      pinned = coalesce(new.pinned, false), likes = coalesce(new.likes, '{}'),
      comments = coalesce(new.comments, '[]'::jsonb), uriage = new.uriage,
      images = coalesce(new.images, '[]'::jsonb),
      posted_at = coalesce(new.date, posted_at)
    where app_id = old.id;
    return new;
  end if;
  v_author := app.member_id_of(new.author_id);
  if v_author is null then
    raise exception '社員番号 % のメンバーが見つかりません', new.author_id using errcode = 'foreign_key_violation';
  end if;
  insert into public.posts as p (app_id, post_type, author_id, channel_id, store_id, to_member,
    title, body, points, pinned, likes, comments, uriage, images, posted_at)
  values (new.id, coalesce(new.type, 'timeline'), v_author, new.channel_id, app.store_id_of(new.store_id),
    app.member_id_of(new.to_id), new.title, coalesce(new.body, ''), coalesce(new.points, 0),
    coalesce(new.pinned, false), coalesce(new.likes, '{}'), coalesce(new.comments, '[]'::jsonb),
    new.uriage, coalesce(new.images, '[]'::jsonb), coalesce(new.date, now()))
  on conflict (app_id) do update set
    title = excluded.title, body = excluded.body, likes = excluded.likes, comments = excluded.comments,
    pinned = excluded.pinned, uriage = excluded.uriage, images = excluded.images;
  return new;
end; $$;
drop trigger if exists v_app_posts_write on public.v_app_posts;
create trigger v_app_posts_write instead of insert or update or delete on public.v_app_posts
  for each row execute function app.write_app_posts();

-- ---------------- tasks ----------------
create or replace view public.v_app_tasks
  with (security_invoker = true) as
select
  t.app_id       as id,
  t.title, t.note,
  app.employee_no_of(t.owner_id)   as owner_id,
  app.employee_no_of(t.created_by) as created_by,
  t.due_on       as due,
  t.status, t.progress, t.source,
  t.is_auto      as auto,
  t.auto_key, t.auto_resolve, t.reassigned, t.assign_log, t.alerted_at, t.completed_at,
  t.created_on   as created_at
from public.tasks t;

create or replace function app.write_app_tasks()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
declare v_owner uuid;
begin
  if tg_op = 'DELETE' then delete from public.tasks where app_id = old.id; return old; end if;
  v_owner := app.member_id_of(new.owner_id);
  if tg_op = 'UPDATE' then
    update public.tasks set
      title = coalesce(new.title, title), note = new.note,
      owner_id = coalesce(v_owner, owner_id),
      due_on = new.due, status = coalesce(new.status, status),
      progress = coalesce(new.progress, progress), source = coalesce(new.source, source),
      reassigned = coalesce(new.reassigned, reassigned), assign_log = coalesce(new.assign_log, assign_log),
      alerted_at = new.alerted_at,
      completed_at = case when coalesce(new.status, status) = 'done' and status <> 'done' then now()
                          when coalesce(new.status, status) <> 'done' then null else completed_at end
    where app_id = old.id;
    return new;
  end if;
  if v_owner is null then
    raise exception '社員番号 % のメンバーが見つかりません', new.owner_id using errcode = 'foreign_key_violation';
  end if;
  -- 自動タスクは auto_key で 1 行に寄せる。別の端末が先に積んでいたら題名・メモだけ追随する
  if new.auto_key is not null and exists (select 1 from public.tasks where auto_key = new.auto_key) then
    update public.tasks set title = coalesce(new.title, title), note = coalesce(new.note, note),
      due_on = coalesce(new.due, due_on)
    where auto_key = new.auto_key and status <> 'done';
    return new;
  end if;
  insert into public.tasks as t (app_id, title, note, owner_id, created_by, due_on, status, progress,
    source, is_auto, auto_key, auto_resolve, reassigned, assign_log, created_on)
  values (new.id, new.title, new.note, v_owner, coalesce(app.member_id_of(new.created_by), app.current_member_id()),
    new.due, coalesce(new.status, 'todo'), coalesce(new.progress, 0), coalesce(new.source, '{}'::jsonb),
    coalesce(new.auto, false), new.auto_key, new.auto_resolve, coalesce(new.reassigned, false),
    coalesce(new.assign_log, '[]'::jsonb), coalesce(new.created_at, current_date))
  on conflict (app_id) do update set
    title = excluded.title, note = excluded.note, owner_id = excluded.owner_id, due_on = excluded.due_on,
    status = excluded.status, progress = excluded.progress, reassigned = excluded.reassigned,
    assign_log = excluded.assign_log;
  return new;
end; $$;
drop trigger if exists v_app_tasks_write on public.v_app_tasks;
create trigger v_app_tasks_write instead of insert or update or delete on public.v_app_tasks
  for each row execute function app.write_app_tasks();

-- ---------------- chat_rooms ----------------
create or replace view public.v_app_chat_rooms
  with (security_invoker = true) as
select
  r.app_id      as id,
  r.kind, r.name, r.icon,
  r.description as "desc",
  st.code       as store_id,
  r.member_nos  as member_ids,
  r.announce_only,
  r.pinned_message_app_id as pinned_message_id,
  app.employee_no_of(r.created_by) as created_by
from public.chat_rooms r
left join public.stores st on st.id = r.store_id;

create or replace function app.write_app_chat_rooms()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
begin
  if tg_op = 'DELETE' then delete from public.chat_rooms where app_id = old.id; return old; end if;
  if tg_op = 'UPDATE' then
    update public.chat_rooms set
      kind = coalesce(new.kind, kind), name = coalesce(new.name, name), icon = new.icon,
      description = new."desc", store_id = coalesce(app.store_id_of(new.store_id), store_id),
      member_nos = coalesce(new.member_ids, member_nos),
      announce_only = coalesce(new.announce_only, announce_only),
      pinned_message_app_id = new.pinned_message_id
    where app_id = old.id;
    return new;
  end if;
  insert into public.chat_rooms as r (app_id, kind, name, icon, description, store_id, member_nos,
    announce_only, pinned_message_app_id, created_by)
  values (new.id, coalesce(new.kind, 'group'), new.name, new.icon, new."desc", app.store_id_of(new.store_id),
    coalesce(new.member_ids, '{}'), coalesce(new.announce_only, false), new.pinned_message_id,
    coalesce(app.member_id_of(new.created_by), app.current_member_id()))
  on conflict (app_id) do update set
    name = excluded.name, icon = excluded.icon, description = excluded.description,
    member_nos = excluded.member_nos, announce_only = excluded.announce_only,
    pinned_message_app_id = excluded.pinned_message_app_id;
  return new;
end; $$;
drop trigger if exists v_app_chat_rooms_write on public.v_app_chat_rooms;
create trigger v_app_chat_rooms_write instead of insert or update or delete on public.v_app_chat_rooms
  for each row execute function app.write_app_chat_rooms();

-- ---------------- chat_messages ----------------
create or replace view public.v_app_chat_messages
  with (security_invoker = true) as
select
  m.app_id       as id,
  m.room_app_id  as room_id,
  app.employee_no_of(m.author_id) as author_id,
  m.sent_at      as date,
  m.body         as text,
  m.mentions, m.reactions, m.read_by,
  m.reply_to_app_id as reply_to_id,
  m.attachment,
  m.task_app_id  as task_id,
  m.edited, m.deleted
from public.chat_messages m;

create or replace function app.write_app_chat_messages()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
declare v_author uuid;
begin
  if tg_op = 'DELETE' then delete from public.chat_messages where app_id = old.id; return old; end if;
  if tg_op = 'UPDATE' then
    update public.chat_messages set
      body = coalesce(new.text, body), mentions = coalesce(new.mentions, mentions),
      reactions = coalesce(new.reactions, reactions), read_by = coalesce(new.read_by, read_by),
      reply_to_app_id = new.reply_to_id, attachment = new.attachment, task_app_id = new.task_id,
      edited = coalesce(new.edited, edited), deleted = coalesce(new.deleted, deleted)
    where app_id = old.id;
    return new;
  end if;
  v_author := app.member_id_of(new.author_id);
  if v_author is null then
    raise exception '社員番号 % のメンバーが見つかりません', new.author_id using errcode = 'foreign_key_violation';
  end if;
  insert into public.chat_messages as m (app_id, room_app_id, author_id, sent_at, body, mentions, reactions,
    read_by, reply_to_app_id, attachment, task_app_id, edited, deleted)
  values (new.id, new.room_id, v_author, coalesce(new.date, now()), coalesce(new.text, ''),
    coalesce(new.mentions, '{}'), coalesce(new.reactions, '{}'::jsonb), coalesce(new.read_by, '{}'),
    new.reply_to_id, new.attachment, new.task_id, coalesce(new.edited, false), coalesce(new.deleted, false))
  on conflict (app_id) do update set
    body = excluded.body, reactions = excluded.reactions, read_by = excluded.read_by,
    task_app_id = excluded.task_app_id, edited = excluded.edited, deleted = excluded.deleted;
  return new;
end; $$;
drop trigger if exists v_app_chat_messages_write on public.v_app_chat_messages;
create trigger v_app_chat_messages_write instead of insert or update or delete on public.v_app_chat_messages
  for each row execute function app.write_app_chat_messages();

-- ---------------- trainings ----------------
create or replace view public.v_app_trainings
  with (security_invoker = true) as
select
  t.app_id       as id,
  t.title,
  t.kind         as type,
  t.held_on      as date,
  t.start_at     as start,
  t.duration_min,
  t.required, t.place, t.attendees
from public.trainings t;

create or replace function app.write_app_trainings()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
begin
  if tg_op = 'DELETE' then delete from public.trainings where app_id = old.id; return old; end if;
  if tg_op = 'UPDATE' then
    update public.trainings set
      title = coalesce(new.title, title), kind = new.type, held_on = coalesce(new.date, held_on),
      start_at = new.start, duration_min = new.duration_min, required = coalesce(new.required, required),
      place = new.place, attendees = coalesce(new.attendees, attendees)
    where app_id = old.id;
    return new;
  end if;
  insert into public.trainings as t (app_id, title, kind, held_on, start_at, duration_min, required, place, attendees, created_by)
  values (new.id, new.title, new.type, new.date, new.start, new.duration_min, coalesce(new.required, false),
    new.place, coalesce(new.attendees, '[]'::jsonb), app.current_member_id())
  on conflict (app_id) do update set
    title = excluded.title, kind = excluded.kind, held_on = excluded.held_on, start_at = excluded.start_at,
    duration_min = excluded.duration_min, required = excluded.required, place = excluded.place,
    attendees = excluded.attendees;
  return new;
end; $$;
drop trigger if exists v_app_trainings_write on public.v_app_trainings;
create trigger v_app_trainings_write instead of insert or update or delete on public.v_app_trainings
  for each row execute function app.write_app_trainings();

-- ---------------- training_reports ----------------
create or replace view public.v_app_training_reports
  with (security_invoker = true) as
select
  r.app_id          as id,
  r.training_app_id as training_id,
  app.employee_no_of(r.author_id) as author_id,
  r.body, r.learned, r.apply_plan, r.status, r.submitted_at
from public.training_reports r;

create or replace function app.write_app_training_reports()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
declare v_author uuid;
begin
  if tg_op = 'DELETE' then delete from public.training_reports where app_id = old.id; return old; end if;
  if tg_op = 'UPDATE' then
    update public.training_reports set
      body = coalesce(new.body, body), learned = new.learned, apply_plan = new.apply_plan,
      status = coalesce(new.status, status),
      submitted_at = case when coalesce(new.status, status) = 'submitted' and submitted_at is null then now()
                          else coalesce(new.submitted_at, submitted_at) end
    where app_id = old.id;
    return new;
  end if;
  v_author := coalesce(app.member_id_of(new.author_id), app.current_member_id());
  insert into public.training_reports as r (app_id, training_app_id, author_id, body, learned, apply_plan, status, submitted_at)
  values (new.id, new.training_id, v_author, coalesce(new.body, ''), new.learned, new.apply_plan,
    coalesce(new.status, 'draft'), case when new.status = 'submitted' then coalesce(new.submitted_at, now()) end)
  on conflict (app_id) do update set
    body = excluded.body, learned = excluded.learned, apply_plan = excluded.apply_plan,
    status = excluded.status, submitted_at = coalesce(excluded.submitted_at, r.submitted_at);
  return new;
end; $$;
drop trigger if exists v_app_training_reports_write on public.v_app_training_reports;
create trigger v_app_training_reports_write instead of insert or update or delete on public.v_app_training_reports
  for each row execute function app.write_app_training_reports();

-- ---------------- incident_reports ----------------
create or replace view public.v_app_incident_reports
  with (security_invoker = true) as
select
  i.app_id      as id,
  app.employee_no_of(i.author_id) as author_id,
  i.kind, i.occurred_on, i.conclusion, i.cause, i.process_detail, i.worst_case, i.prevention,
  i.status, i.submitted_at,
  app.employee_no_of(i.acknowledged_by) as acknowledged_by,
  i.acknowledged_at, i.ack_comment
from public.incident_reports i;

create or replace function app.write_app_incident_reports()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
declare v_author uuid;
begin
  if tg_op = 'DELETE' then delete from public.incident_reports where app_id = old.id; return old; end if;
  if tg_op = 'UPDATE' then
    update public.incident_reports set
      kind = coalesce(new.kind, kind), occurred_on = coalesce(new.occurred_on, occurred_on),
      conclusion = coalesce(new.conclusion, conclusion), cause = coalesce(new.cause, cause),
      process_detail = coalesce(new.process_detail, process_detail),
      worst_case = coalesce(new.worst_case, worst_case), prevention = coalesce(new.prevention, prevention),
      status = coalesce(new.status, status),
      submitted_at = case when coalesce(new.status, status) <> 'draft' and submitted_at is null then now()
                          else submitted_at end,
      ack_comment = coalesce(new.ack_comment, ack_comment)
    where app_id = old.id;
    return new;
  end if;
  v_author := coalesce(app.member_id_of(new.author_id), app.current_member_id());
  insert into public.incident_reports as i (app_id, author_id, kind, occurred_on, conclusion, cause,
    process_detail, worst_case, prevention, status, submitted_at)
  values (new.id, v_author, coalesce(new.kind, 'kaizen'), coalesce(new.occurred_on, current_date),
    coalesce(new.conclusion, ''), coalesce(new.cause, ''), coalesce(new.process_detail, ''),
    coalesce(new.worst_case, ''), coalesce(new.prevention, ''), coalesce(new.status, 'draft'),
    case when coalesce(new.status, 'draft') <> 'draft' then now() end)
  on conflict (app_id) do update set
    kind = excluded.kind, occurred_on = excluded.occurred_on, conclusion = excluded.conclusion,
    cause = excluded.cause, process_detail = excluded.process_detail, worst_case = excluded.worst_case,
    prevention = excluded.prevention, status = excluded.status;
  return new;
end; $$;
drop trigger if exists v_app_incident_reports_write on public.v_app_incident_reports;
create trigger v_app_incident_reports_write instead of insert or update or delete on public.v_app_incident_reports
  for each row execute function app.write_app_incident_reports();

-- ---------------- budgets ----------------
create or replace view public.v_app_budgets
  with (security_invoker = true) as
select
  b.app_id  as id,
  st.code   as store_id,
  b.month, b.amount, b.note
from public.budgets b
join public.stores st on st.id = b.store_id;

create or replace function app.write_app_budgets()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
declare v_store uuid;
begin
  if tg_op = 'DELETE' then delete from public.budgets where app_id = old.id; return old; end if;
  v_store := app.store_id_of(new.store_id);
  if tg_op = 'UPDATE' then
    update public.budgets set amount = coalesce(new.amount, amount), note = new.note,
      month = coalesce(new.month, month), store_id = coalesce(v_store, store_id)
    where app_id = old.id;
    return new;
  end if;
  if v_store is null then
    raise exception '店舗コード % が見つかりません', new.store_id using errcode = 'foreign_key_violation';
  end if;
  insert into public.budgets as b (app_id, store_id, month, amount, note)
  values (new.id, v_store, new.month, coalesce(new.amount, 0), new.note)
  on conflict (store_id, month) do update set
    app_id = excluded.app_id, amount = excluded.amount, note = excluded.note;
  return new;
end; $$;
drop trigger if exists v_app_budgets_write on public.v_app_budgets;
create trigger v_app_budgets_write instead of insert or update or delete on public.v_app_budgets
  for each row execute function app.write_app_budgets();

grant select, insert, update, delete on
  public.v_app_posts, public.v_app_tasks, public.v_app_chat_rooms, public.v_app_chat_messages,
  public.v_app_trainings, public.v_app_training_reports, public.v_app_incident_reports, public.v_app_budgets
  to authenticated;

-- ============================================================
-- 自分の情報に写真を足す
-- ============================================================
create or replace function public.me()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select case when m.id is null then null else jsonb_build_object(
    'id',            m.id,
    'employee_no',   m.employee_no,
    'full_name',     m.full_name,
    'kana',          m.kana,
    'email',         m.email,
    'color',         m.color,
    'photo_url',     m.photo_url,
    'rank',          m.rank,
    'rank_label',    app.rank_label(m.rank),
    'rank_level',    app.rank_level(m.rank),
    'role_title',    m.role_title,
    'department',    m.department,
    'store_id',      m.primary_store_id,
    'store_code',    s.code,
    'store_name',    s.name,
    'manager_id',    m.reports_to_id,
    'manager_employee_no', (select mgr.employee_no from public.members mgr where mgr.id = m.reports_to_id),
    'can_edit_org',  app.can_edit_org(),
    'managed_store_ids', (select coalesce(jsonb_agg(store_id), '[]'::jsonb) from app.managed_store_ids(m.id)),
    'managed_store_codes', (
      select coalesce(jsonb_agg(st.code), '[]'::jsonb)
        from app.managed_store_ids(m.id) ms
        join public.stores st on st.id = ms.store_id
    ),
    'subordinates',      (select count(*) from app.subtree_ids(m.id)),
    'mentees',           (select count(*) from public.mentorships ms
                           where ms.mentor_id = m.id and ms.ended_on is null)
  ) end
  from public.members m
  left join public.stores s on s.id = m.primary_store_id
  where m.id = app.current_member_id();
$$;
grant execute on function public.me() to authenticated;
