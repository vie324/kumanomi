-- ============================================================
-- くまのみ 統合ポータル — セットアップ SQL(全部入り)
--
-- このファイルは scripts/build-setup-sql.js が
-- supabase/migrations/*.sql から自動生成しています。
-- 直接編集せず、マイグレーション側を直してから作り直してください。
--
--   node scripts/build-setup-sql.js
--
-- ------------------------------------------------------------
-- 使い方(どちらか一方でよい)
--
--   A. Supabase ダッシュボード
--      SQL Editor を開き、このファイルの中身を全部貼って Run。
--      1 回で店舗・メンバー・組織図・権限・勤怠・シフト・希望休・日報が
--      すべて出来上がります。
--
--   B. psql
--      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/setup.sql
--
-- ------------------------------------------------------------
-- 何度実行しても壊れません(作成済みのものは飛ばします)。
-- スキーマだけを作ります。組織図データの取り込みは
--   supabase/seed/0001_roster.sql
-- を続けて実行するか、画面の「メンバー・組織図の一括登録」から行ってください。
--
-- 実行後にやること:
--   1. select public.fill_employee_numbers();   -- 社員番号を振る
--   2. select public.set_member_emails('[...]'); -- メールを登録
--   3. Supabase Auth で社員を招待
--   4. select public.link_member_accounts();     -- アカウントと名簿を紐付け
-- 詳しくは docs/supabase-migration.md を参照。
-- ============================================================

-- 収録しているマイグレーション
--   0001_core_schema.sql
--   0002_org_views.sql
--   0003_roster_import.sql
--   0004_rls.sql
--   0005_accounts.sql
--   0006_app_bridge.sql
--   0007_daily_operations.sql
--   0008_bootstrap_admin.sql
--   0009_collaboration.sql
--   0010_members_and_rooms.sql


-- ############################################################
-- # 0001_core_schema.sql
-- ############################################################

-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 01:店舗・メンバー・組織図
--
-- 組織図スプレッドシート(統括MG / MG / 統括院長 / 店舗 / 院長 /
-- 整体部門 / 受付スタッフ / 店長 / 美容部門)をそのまま表現できる形にしている。
--
--   * 人の階層 …… members.reports_to_id(自己参照)= 「傘」
--   * 店舗の責任者 …… stores.director_id / chief_director_id /
--                      area_manager_id / general_manager_id
--   * 兼務 …… member_store_assignments(1人が複数店舗に所属できる)
--
-- アプリ側 js/auth.js の RBAC(rank / reportsTo / mentorId)と 1:1 で対応する。
-- ============================================================

create extension if not exists "pgcrypto";

-- 内部ヘルパー用スキーマ(PostgREST には公開しない)
create schema if not exists app;

-- ------------------------------------------------------------
-- 列挙型
-- ------------------------------------------------------------

-- 店舗カテゴリ。責任者の呼称がここで決まる(美容・エステ=店長 / それ以外=院長)
do $$ begin
  create type public.store_category as enum ('整骨院', '整体院', '鍼灸院', '美容・エステ');
exception when duplicate_object then null; end $$;

-- 役職ランク。js/auth.js の RANKS と同じキー
do $$ begin
  create type public.member_rank as enum (
    'ceo',      -- 社長
    'exec',     -- 統括マネージャー(統括MG)
    'area',     -- マネージャー(MG)
    'chief',    -- 統括院長
    'manager',  -- 院長・店長
    'mentor',   -- メンター
    'staff',    -- スタッフ
    'hr'        -- 本部人事
  );
exception when duplicate_object then null; end $$;

-- 部門。スプレッドシートの列グループに対応する
do $$ begin
  create type public.department as enum (
    'seitai',      -- 整体部門
    'beauty',      -- 美容部門
    'reception',   -- 受付スタッフ
    'management',  -- 統括MG / MG / 統括院長
    'head_office'  -- 本部(人事・経理など)
  );
exception when duplicate_object then null; end $$;

-- 資格。シートのセル背景色に対応(白=柔整師 / 緑=鍼灸師 / ピンク=整体師)
do $$ begin
  create type public.license_type as enum (
    'judo',         -- 柔道整復師(柔整師)
    'acupuncture',  -- 鍼灸師
    'seitai',       -- 整体師
    'esthetic',     -- エステティシャン
    'reception',    -- 受付(無資格)
    'none',         -- 資格なし
    'unknown'       -- 未確認
  );
exception when duplicate_object then null; end $$;

-- 性別。シートの文字色に対応(青字=男性 / 赤字=女性)
do $$ begin
  create type public.gender as enum ('male', 'female', 'other', 'unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.employment_type as enum ('fulltime', 'parttime', 'contract', 'outsourced', 'unknown');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------
-- 共通トリガー関数
-- ------------------------------------------------------------

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 氏名から取込用のキーを作る。
--   ・全角/半角スペース、括弧付きの旧姓を落とす
--   ・同姓同名は シート側で「佐藤 真夢@2」のように @連番 を付けて区別する
create or replace function app.name_key(p_name text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(
      regexp_replace(coalesce(p_name, ''), '[[:space:]　]+', '', 'g'),
      '[（(][^）)]*[）)]', '', 'g'
    ),
    ''
  );
$$;

-- ------------------------------------------------------------
-- 店舗
-- ------------------------------------------------------------

create table if not exists public.stores (
  id            uuid primary key default gen_random_uuid(),
  code          text        not null unique,               -- 'koshigaya-ekimae' など安定コード
  name          text        not null unique,               -- '越谷駅前院'
  short_name    text,                                      -- '越谷'
  category      public.store_category not null default '整骨院',
  postal_code   text,
  address       text,
  phone         text,
  lat           double precision,                          -- GPS打刻の判定に使う
  lng           double precision,
  radius_m      integer     not null default 200,          -- 打刻を有効とする半径(m)
  open_hour     time,
  close_hour    time,
  closed_dow    smallint,                                  -- 定休日(0=日 … 6=土)
  beds          smallint    not null default 3,            -- 予約枠の基軸になるベッド数
  color         text,                                      -- UI 上の識別色
  opened_on     date,
  is_pilot      boolean     not null default false,        -- 先行導入店
  is_active     boolean     not null default true,
  sort_order    integer     not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint stores_closed_dow_range check (closed_dow is null or closed_dow between 0 and 6),
  constraint stores_beds_positive    check (beds > 0)
);

comment on table  public.stores            is '店舗マスタ。組織図シートの「店舗」列に対応する';
comment on column public.stores.category   is '整骨院/整体院/鍼灸院=院長、美容・エステ=店長という呼称の切り替えに使う';
comment on column public.stores.radius_m   is 'GPS打刻を有効とする半径(m)。既定 200m';

drop trigger if exists trg_stores_touch on public.stores;
create trigger trg_stores_touch before update on public.stores
  for each row execute function app.touch_updated_at();

-- ------------------------------------------------------------
-- メンバー(従業員)
-- ------------------------------------------------------------

create table if not exists public.members (
  id               uuid primary key default gen_random_uuid(),

  -- 取込キー。シートの氏名から自動生成する(スペース・旧姓括弧を除去)
  name_key         text        not null unique,
  -- 人事システム上の社員番号。あとから埋められるよう nullable
  employee_no      text unique,
  -- Supabase Auth のユーザー。招待/サインアップ後に紐付ける
  auth_user_id     uuid unique references auth.users (id) on delete set null,

  full_name        text        not null,                   -- '浅見(山村) 彩雅' のような旧姓表記もそのまま保持
  display_name     text,                                   -- 表示用の短縮名(未設定なら full_name)
  kana             text,
  former_name      text,                                   -- 旧姓(括弧内から自動抽出)
  gender           public.gender        not null default 'unknown',
  license          public.license_type  not null default 'unknown',
  extra_licenses   text[]      not null default '{}',       -- 複数資格を持つ場合の補足
  employment       public.employment_type not null default 'unknown',

  rank             public.member_rank   not null default 'staff',
  role_title       text        not null default 'スタッフ', -- '統括MG' '院長' '店長' など実際の呼称
  department       public.department    not null default 'seitai',

  primary_store_id uuid references public.stores (id) on delete set null,
  reports_to_id    uuid references public.members (id) on delete set null,

  email            text,
  phone            text,
  color            text,
  joined_on        date,
  left_on          date,
  is_active        boolean     not null default true,
  sort_order       integer     not null default 0,
  note             text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint members_not_self_manager check (id is distinct from reports_to_id)
);

comment on table  public.members               is 'メンバー(従業員)マスタ。組織図シートの全氏名セルがここに入る';
comment on column public.members.name_key      is '取込の一意キー。同姓同名はシート側で「氏名@2」と書いて区別する';
comment on column public.members.reports_to_id is '直属の上司。この親子関係が「傘=見える範囲」を決める';
comment on column public.members.license       is 'シートのセル背景色から判定(白=柔整師 / 緑=鍼灸師 / ピンク=整体師)';
comment on column public.members.gender        is 'シートの文字色から判定(青字=男性 / 赤字=女性)';

create index if not exists members_reports_to_idx    on public.members (reports_to_id);
create index if not exists members_primary_store_idx on public.members (primary_store_id);
create index if not exists members_rank_idx          on public.members (rank);
create index if not exists members_active_idx        on public.members (is_active) where is_active;

drop trigger if exists trg_members_touch on public.members;
create trigger trg_members_touch before update on public.members
  for each row execute function app.touch_updated_at();

-- ---- 循環参照ガード -------------------------------------------------
-- 「A の上司が B、B の上司が A」のような輪ができると配下計算が壊れるため、
-- INSERT/UPDATE の時点で弾く。
create or replace function app.assert_no_org_cycle()
returns trigger
language plpgsql
as $$
declare
  cur   uuid := new.reports_to_id;
  hops  integer := 0;
begin
  while cur is not null loop
    if cur = new.id then
      raise exception '組織図が循環しています: % (%) の上司チェーンが自分自身に戻ります', new.full_name, new.id
        using errcode = 'check_violation';
    end if;
    hops := hops + 1;
    if hops > 64 then
      raise exception '組織図の階層が深すぎます(64段を超えました): %', new.full_name
        using errcode = 'check_violation';
    end if;
    select m.reports_to_id into cur from public.members m where m.id = cur;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_members_no_cycle on public.members;
create trigger trg_members_no_cycle
  before insert or update of reports_to_id on public.members
  for each row execute function app.assert_no_org_cycle();

-- ------------------------------------------------------------
-- 店舗の責任者(シートの列をそのまま持つ)
-- ------------------------------------------------------------

alter table public.stores
  add column if not exists director_id         uuid references public.members (id) on delete set null,
  add column if not exists beauty_manager_id   uuid references public.members (id) on delete set null,
  add column if not exists chief_director_id   uuid references public.members (id) on delete set null,
  add column if not exists area_manager_id     uuid references public.members (id) on delete set null,
  add column if not exists general_manager_id  uuid references public.members (id) on delete set null;

comment on column public.stores.director_id        is '院長(シート「院長」列)';
comment on column public.stores.beauty_manager_id  is '店長(シート「店長」列/美容部門の責任者)';
comment on column public.stores.chief_director_id  is '統括院長(シート「統括院長」列)';
comment on column public.stores.area_manager_id    is 'マネージャー(シート「MG」列)';
comment on column public.stores.general_manager_id is '統括マネージャー(シート「統括MG」列)';

create index if not exists stores_director_idx on public.stores (director_id);

-- ------------------------------------------------------------
-- 所属(兼務対応)
-- ------------------------------------------------------------

create table if not exists public.member_store_assignments (
  member_id   uuid not null references public.members (id) on delete cascade,
  store_id    uuid not null references public.stores  (id) on delete cascade,
  department  public.department not null,
  role_title  text,                                    -- その店舗での呼称('院長' '店長' 'スタッフ' 等)
  is_primary  boolean not null default false,          -- 主たる所属(打刻・日報の既定店舗)
  started_on  date,
  ended_on    date,
  created_at  timestamptz not null default now(),
  primary key (member_id, store_id, department)
);

comment on table public.member_store_assignments is '所属店舗。統括院長やMGのように複数店舗を持つ人はここが複数行になる';

create index if not exists msa_store_idx  on public.member_store_assignments (store_id);
create index if not exists msa_member_idx on public.member_store_assignments (member_id);
-- 主たる所属は 1 人 1 件
create unique index if not exists msa_one_primary_per_member
  on public.member_store_assignments (member_id) where is_primary;

-- ------------------------------------------------------------
-- メンター関係(組織図とは別レイヤー)
-- ------------------------------------------------------------

create table if not exists public.mentorships (
  id          uuid primary key default gen_random_uuid(),
  mentor_id   uuid not null references public.members (id) on delete cascade,
  mentee_id   uuid not null references public.members (id) on delete cascade,
  started_on  date not null default current_date,
  ended_on    date,
  note        text,
  created_at  timestamptz not null default now(),
  constraint mentorship_not_self check (mentor_id <> mentee_id)
);

comment on table public.mentorships is 'メンター制度。組織図の傘とは別に、メンターはメンティーの日報を閲覧できる';

-- 同じ組み合わせの現行(終了していない)関係は 1 件だけ
create unique index if not exists mentorships_active_pair
  on public.mentorships (mentor_id, mentee_id) where ended_on is null;
create index if not exists mentorships_mentee_idx on public.mentorships (mentee_id) where ended_on is null;

-- ------------------------------------------------------------
-- 組織変更の履歴(組織図ページのドラッグ操作もここに残る)
-- ------------------------------------------------------------

create table if not exists public.org_change_log (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references public.members (id) on delete cascade,
  from_manager_id uuid references public.members (id) on delete set null,
  to_manager_id   uuid references public.members (id) on delete set null,
  changed_by    uuid references public.members (id) on delete set null,
  changed_at    timestamptz not null default now(),
  effective_on  date not null default current_date,
  source        text not null default 'app',   -- 'app' | 'import' | 'manual'
  note          text
);

comment on table public.org_change_log is '管轄の付け替え履歴。ワンクリックで元に戻すために from/to を両方持つ';

create index if not exists org_change_log_member_idx on public.org_change_log (member_id, changed_at desc);

-- ------------------------------------------------------------
-- 上司変更を自動で履歴に残す
-- ------------------------------------------------------------

create or replace function app.log_org_change()
returns trigger
language plpgsql
as $$
begin
  if new.reports_to_id is distinct from old.reports_to_id then
    insert into public.org_change_log (member_id, from_manager_id, to_manager_id, source)
    values (new.id, old.reports_to_id, new.reports_to_id,
            coalesce(current_setting('app.change_source', true), 'app'));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_members_log_org_change on public.members;
create trigger trg_members_log_org_change
  after update of reports_to_id on public.members
  for each row execute function app.log_org_change();

-- ############################################################
-- # 0002_org_views.sql
-- ############################################################

-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 02:組織ツリーのビューと判定関数
--
-- js/auth.js の subtreeIds / isDescendant / managedStores / canSeeStaff を
-- そのまま SQL 側に持ってきたもの。RLS からも画面からも同じ定義を使う。
--
-- RLS のポリシー内から members を読むと再帰してしまうため、
-- 判定関数はすべて security definer + 固定 search_path にしている。
-- ============================================================

-- ------------------------------------------------------------
-- ログイン中のメンバー
-- ------------------------------------------------------------

create or replace function app.current_member_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select m.id from public.members m where m.auth_user_id = auth.uid() limit 1;
$$;

comment on function app.current_member_id is 'auth.uid() を members.id に解決する。未紐付けなら null';

-- ------------------------------------------------------------
-- 傘(配下)の計算
-- ------------------------------------------------------------

-- 配下全員の ID(自分は含まない)
create or replace function app.subtree_ids(p_member_id uuid)
returns table (member_id uuid)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with recursive tree as (
    select m.id, 1 as depth
      from public.members m
     where m.reports_to_id = p_member_id
    union all
    select c.id, t.depth + 1
      from public.members c
      join tree t on c.reports_to_id = t.id
     where t.depth < 64
  )
  select id from tree;
$$;

comment on function app.subtree_ids is '組織図上の配下メンバー全員。深さ64でガードして循環しても止まる';

-- target が base の傘の下にいるか
create or replace function app.is_descendant(p_target uuid, p_base uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select case
    when p_target is null or p_base is null then false
    else exists (select 1 from app.subtree_ids(p_base) s where s.member_id = p_target)
  end;
$$;

-- 自分から上へ辿る上司チェーン(近い順)
create or replace function app.manager_chain(p_member_id uuid)
returns table (member_id uuid, depth integer)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with recursive chain as (
    select m.reports_to_id as id, 1 as depth
      from public.members m
     where m.id = p_member_id and m.reports_to_id is not null
    union all
    select p.reports_to_id, c.depth + 1
      from public.members p
      join chain c on p.id = c.id
     where p.reports_to_id is not null and c.depth < 64
  )
  select id, depth from chain where id is not null;
$$;

-- ランクの強さ(js/auth.js の RANKS.level と同じ)
create or replace function app.rank_level(p_rank public.member_rank)
returns integer
language sql
immutable
as $$
  select case p_rank
    when 'ceo'     then 7
    when 'exec'    then 6
    when 'area'    then 5
    when 'chief'   then 4
    when 'manager' then 3
    when 'hr'      then 3
    when 'mentor'  then 2
    else 1
  end;
$$;

create or replace function app.rank_label(p_rank public.member_rank)
returns text
language sql
immutable
as $$
  select case p_rank
    when 'ceo'     then '社長'
    when 'exec'    then '統括マネージャー'
    when 'area'    then 'マネージャー'
    when 'chief'   then '統括院長'
    when 'manager' then '院長・店長'
    when 'hr'      then '本部人事'
    when 'mentor'  then 'メンター'
    else 'スタッフ'
  end;
$$;

-- 店舗カテゴリから責任者の呼称を返す
create or replace function public.director_title(p_category public.store_category)
returns text
language sql
immutable
as $$
  select case when p_category = '美容・エステ' then '店長' else '院長' end;
$$;

-- ------------------------------------------------------------
-- 管轄店舗
-- ------------------------------------------------------------

-- 自分+配下に院長/店長がいる店舗、および階層3以上なら配下の所属店舗すべて
create or replace function app.managed_store_ids(p_member_id uuid)
returns table (store_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rank  public.member_rank;
  v_level integer;
begin
  select m.rank into v_rank from public.members m where m.id = p_member_id;
  if v_rank is null then
    return;
  end if;

  -- 本部人事は勤怠・シフト管理のため全店舗を対象にする
  if v_rank = 'hr' then
    return query select s.id from public.stores s where s.is_active;
    return;
  end if;

  v_level := app.rank_level(v_rank);

  return query
  with scope as (
    select p_member_id as id
    union
    select t.member_id from app.subtree_ids(p_member_id) t
  )
  select distinct a.store_id
    from public.member_store_assignments a
    join scope   on scope.id = a.member_id
    join public.members m on m.id = a.member_id
   where a.ended_on is null
     and (v_level >= 3 or m.rank = 'manager');
end;
$$;

comment on function app.managed_store_ids is 'シフト編集・勤怠承認ができる店舗。組織ツリーから毎回計算する';

-- ------------------------------------------------------------
-- 可視範囲(傘+メンター)
-- ------------------------------------------------------------

create or replace function app.can_see_member(p_viewer uuid, p_target uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rank public.member_rank;
begin
  if p_viewer is null or p_target is null then
    return false;
  end if;
  if p_viewer = p_target then
    return true;
  end if;

  select m.rank into v_rank from public.members m where m.id = p_viewer;
  if v_rank is null then
    return false;
  end if;
  -- 本部人事は勤怠管理のため全員を参照できる(日報そのものは別途遮断する)
  if v_rank = 'hr' then
    return true;
  end if;

  -- メンティーは組織図とは別に見える
  if exists (
    select 1 from public.mentorships ms
     where ms.mentor_id = p_viewer and ms.mentee_id = p_target and ms.ended_on is null
  ) then
    return true;
  end if;

  return app.is_descendant(p_target, p_viewer);
end;
$$;

-- なぜ見えるのかの理由ラベル(画面のバッジ表示用)
create or replace function public.visibility_reason(p_viewer uuid, p_target uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rank   public.member_rank;
  v_parent uuid;
begin
  if p_viewer = p_target then return '自分'; end if;

  if exists (
    select 1 from public.mentorships ms
     where ms.mentor_id = p_viewer and ms.mentee_id = p_target and ms.ended_on is null
  ) then
    return 'メンティー';
  end if;

  select m.reports_to_id into v_parent from public.members m where m.id = p_target;
  if v_parent = p_viewer then return '直属'; end if;

  select m.rank into v_rank from public.members m where m.id = p_viewer;
  if app.is_descendant(p_target, p_viewer) then
    return case when v_rank = 'ceo' then '全社' else '配下' end;
  end if;
  if v_rank = 'hr' then return '人事(勤怠)'; end if;
  return null;
end;
$$;

-- ------------------------------------------------------------
-- ビュー
-- ------------------------------------------------------------

-- 組織ツリー。depth / path / 経路上の氏名を持つので画面でそのまま描ける
create or replace view public.v_org_tree as
with recursive tree as (
  select
    m.id,
    m.reports_to_id,
    0                            as depth,
    array[m.sort_order, 0]       as sort_path,
    array[m.id]                  as id_path,
    m.full_name::text            as name_path
  from public.members m
  where m.reports_to_id is null and m.is_active
  union all
  select
    c.id,
    c.reports_to_id,
    t.depth + 1,
    t.sort_path || array[c.sort_order, 0],
    t.id_path   || c.id,
    t.name_path || ' > ' || c.full_name
  from public.members c
  join tree t on c.reports_to_id = t.id
  where c.is_active and t.depth < 64
)
select
  t.id            as member_id,
  t.reports_to_id as manager_id,
  t.depth,
  t.id_path,
  t.name_path,
  t.sort_path,
  m.full_name,
  m.rank,
  m.role_title,
  m.department,
  m.gender,
  m.license,
  s.id            as store_id,
  s.name          as store_name,
  s.category      as store_category
from tree t
join public.members m on m.id = t.id
left join public.stores s on s.id = m.primary_store_id;

comment on view public.v_org_tree is '組織図の全ノード。depth と id_path で階層描画・部分木抽出ができる';

-- メンバー名簿(画面・CSV出力向けの読みやすい形)
-- ※ 0006 でこのビューに列を足している。
--    create or replace view は「列を減らす」ことができないため、
--    2 回目以降の実行で失敗しないよう、いったん落としてから作り直す。
--    (このビューに依存している別のビューは無い)
drop view if exists public.v_member_directory;

create view public.v_member_directory as
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
  m.is_active
from public.members m
left join public.stores  s   on s.id = m.primary_store_id
left join public.members mgr on mgr.id = m.reports_to_id;

comment on view public.v_member_directory is 'メンバー名簿。ランク・部門・上司・配下人数をラベル付きで返す';

-- 店舗ごとの体制(シートの1行に相当する形へ戻したもの)
create or replace view public.v_store_roster as
select
  s.id,
  s.code,
  s.name,
  s.category,
  public.director_title(s.category) as director_title,
  gm.full_name    as general_manager,
  mg.full_name    as area_manager,
  cd.full_name    as chief_director,
  dr.full_name    as director,
  bm.full_name    as beauty_manager,
  coalesce((
    select array_agg(m.full_name order by m.sort_order, m.full_name)
      from public.member_store_assignments a
      join public.members m on m.id = a.member_id
     where a.store_id = s.id and a.department = 'seitai'
       and a.ended_on is null and m.id is distinct from s.director_id
  ), '{}') as seitai_members,
  coalesce((
    select array_agg(m.full_name order by m.sort_order, m.full_name)
      from public.member_store_assignments a
      join public.members m on m.id = a.member_id
     where a.store_id = s.id and a.department = 'reception' and a.ended_on is null
  ), '{}') as reception_members,
  coalesce((
    select array_agg(m.full_name order by m.sort_order, m.full_name)
      from public.member_store_assignments a
      join public.members m on m.id = a.member_id
     where a.store_id = s.id and a.department = 'beauty'
       and a.ended_on is null and m.id is distinct from s.beauty_manager_id
  ), '{}') as beauty_members,
  (select count(*) from public.member_store_assignments a
    where a.store_id = s.id and a.ended_on is null) as headcount,
  s.is_active
from public.stores s
left join public.members gm on gm.id = s.general_manager_id
left join public.members mg on mg.id = s.area_manager_id
left join public.members cd on cd.id = s.chief_director_id
left join public.members dr on dr.id = s.director_id
left join public.members bm on bm.id = s.beauty_manager_id;

comment on view public.v_store_roster is '店舗ごとの体制表。取り込んだ組織図シートと同じ並びで検算できる';

-- ############################################################
-- # 0003_roster_import.sql
-- ############################################################

-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 03:組織図シートの一括取込
--
-- 使い方(Supabase SQL Editor / psql どちらでも):
--
--   select public.import_roster_sheet($sheet$
--   統括MG	MG	統括院長	店舗	院長	整体部門			受付スタッフ	店長	美容部門
--   日野 碧人	竹内 香織	小村 将真	越谷駅前院	嶋田 勇輝	福井 仁太	佐藤 真夢			増渕 香澄	楢苅 芽依
--   				新三郷院	小村 将真
--   $sheet$);
--
--   ・スプレッドシートから範囲コピーして、そのまま貼るだけ(タブ区切り)
--   ・結合セル(統括MG / MG / 統括院長)は空欄のまま下に続けてよい ── 上の値を引き継ぐ
--   ・見出しは 1 行でも 2 行(部門グループ+列名)でも自動判別する
--   ・列の並び・列数は見出しから判定するので、部門の人数が増減しても直さなくてよい
--
-- セルの書き方:
--   氏名                       … 資格・性別は「未確認」
--   氏名(柔整/男)             … 末尾の括弧が資格・性別トークンだけなら注記として解釈
--   浅見(山村) 彩雅            … トークン以外の括弧は旧姓として保持(氏名はそのまま残る)
--   佐藤 真夢@2                … 同姓同名の別人。@以降は区別用でDBの氏名には入らない
--
-- 何度流しても同じ結果になる(氏名キーで UPSERT)。
-- ============================================================

-- ------------------------------------------------------------
-- 取込用の語彙
-- ------------------------------------------------------------

-- 見出しラベル → 列の役割
create or replace function app.roster_column_role(p_label text)
returns text
language sql
immutable
as $$
  select case
    when l = ''                                              then null
    when l ~ '統括MG|統括ＭＧ|統括マネージャ|統括マネジャ|ゼネラルマネージャ|^GM$' then 'gm'
    when l ~ '統括院長|エリア院長|ブロック院長'               then 'chief'
    when l in ('MG', 'ＭＧ') or l ~ 'マネージャ|マネジャ|エリア長|エリアMG' then 'mg'
    when l ~ 'カテゴリ|区分|業態|種別'                        then 'category'
    when l ~ '店舗|院名|拠点|サロン名'                        then 'store'
    when l ~ '院長'                                           then 'director'
    when l ~ '受付'                                           then 'reception'
    when l ~ '店長'                                           then 'beauty_manager'
    when l ~ '美容|エステ'                                    then 'beauty'
    when l ~ '整体|整骨|施術|治療|鍼灸'                       then 'seitai'
    else null
  end
  from (select regexp_replace(coalesce(p_label, ''), '[[:space:]　]', '', 'g') as l) t;
$$;

comment on function app.roster_column_role is '組織図シートの見出し文字列を列の役割に変換する';

-- 注記トークン → 資格
create or replace function app.license_from_token(p_token text)
returns public.license_type
language sql
immutable
as $$
  select case
    when p_token in ('柔', '柔整', '柔整師', '柔道整復', '柔道整復師', 'JU')       then 'judo'
    when p_token in ('鍼', '針', '鍼灸', '鍼灸師', 'はり', 'きゅう', '針灸', 'AC') then 'acupuncture'
    when p_token in ('整体', '整体師', 'SE')                                       then 'seitai'
    when p_token in ('エステ', 'エステティシャン', '美容', 'ES')                   then 'esthetic'
    when p_token in ('受付', 'RE')                                                 then 'reception'
    when p_token in ('無資格', '資格なし', 'なし')                                 then 'none'
    else null
  end::public.license_type;
$$;

-- 注記トークン → 性別
create or replace function app.gender_from_token(p_token text)
returns public.gender
language sql
immutable
as $$
  select case
    when p_token in ('男', '男性', 'M', 'm')  then 'male'
    when p_token in ('女', '女性', 'F', 'f')  then 'female'
    else null
  end::public.gender;
$$;

-- 店舗名からカテゴリを推測する(シートに「区分」列があればそちらが優先)
create or replace function app.infer_store_category(p_name text, p_default text default '整骨院')
returns public.store_category
language sql
immutable
as $$
  select case
    when p_name ~ '美容|エステ|ビューティ|ビューティー' then '美容・エステ'
    when p_name ~ '鍼灸|針灸|はりきゅう'               then '鍼灸院'
    when p_name ~ '整体'                                then '整体院'
    else coalesce(nullif(p_default, ''), '整骨院')
  end::public.store_category;
$$;

-- 「人がいない」ことを表すセルか。
-- 結合セルの引き継ぎを断ち切るマーカーとしても使う(統括院長がいない店舗など)。
create or replace function app.is_blank_cell(p_cell text)
returns boolean
language sql
immutable
as $$
  select v = ''
      or v ~ '^[-—―ー‐−・※]+$'
      or v in ('なし', '無し', '空き', '欠員', '未定', '募集中', '該当なし')
  from (select regexp_replace(coalesce(p_cell, ''), '[[:space:]　]', '', 'g') as v) t;
$$;

comment on function app.is_blank_cell is '空欄・ハイフン・「なし」などを人のいないセルとして判定する';

-- ------------------------------------------------------------
-- 氏名セルの解釈
-- ------------------------------------------------------------

create or replace function app.parse_person_cell(p_cell text)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_raw     text;
  v_name    text;
  v_inner   text;
  v_tokens  text[];
  v_tok     text;
  v_license public.license_type := null;
  v_gender  public.gender       := null;
  v_lic_hit public.license_type;
  v_gen_hit public.gender;
  v_all_known boolean;
  v_dedupe  text := '';
  v_former  text := null;
begin
  v_raw := btrim(regexp_replace(coalesce(p_cell, ''), '[[:space:]　]+', ' ', 'g'));
  if app.is_blank_cell(v_raw) then
    return null;
  end if;
  v_name := v_raw;

  -- 1) 末尾の括弧が「資格/性別トークンだけ」なら注記として取り除く
  v_inner := (regexp_match(v_name, '[（(【\[]([^）)】\]]*)[）)】\]][[:space:]　]*$'))[1];
  if v_inner is not null and btrim(v_inner) <> '' then
    v_tokens := regexp_split_to_array(btrim(v_inner), '[/／・,、|＋+[:space:]　]+');
    v_all_known := true;
    foreach v_tok in array v_tokens loop
      v_tok := btrim(v_tok);
      if v_tok = '' then continue; end if;
      v_lic_hit := app.license_from_token(v_tok);
      v_gen_hit := app.gender_from_token(v_tok);
      if v_lic_hit is null and v_gen_hit is null then
        v_all_known := false;
        exit;
      end if;
      if v_lic_hit is not null then v_license := v_lic_hit; end if;
      if v_gen_hit is not null then v_gender  := v_gen_hit; end if;
    end loop;

    if v_all_known then
      v_name := btrim(regexp_replace(v_name, '[（(【\[][^）)】\]]*[）)】\]][[:space:]　]*$', ''));
    else
      -- トークンではない括弧 = 旧姓表記。氏名にはそのまま残す
      v_license := null;
      v_gender  := null;
    end if;
  end if;

  -- 2) 同姓同名の区別用サフィックス(@2 など)
  v_dedupe := coalesce((regexp_match(v_name, '@([0-9A-Za-z_-]+)[[:space:]　]*$'))[1], '');
  if v_dedupe <> '' then
    v_name := btrim(regexp_replace(v_name, '@[0-9A-Za-z_-]+[[:space:]　]*$', ''));
  end if;

  -- 3) 括弧内が残っていれば旧姓として拾う(例:浅見(山村) 彩雅 → 山村)
  v_former := (regexp_match(v_name, '[（(]([^）)]+)[）)]'))[1];

  if btrim(v_name) = '' then
    return null;
  end if;

  return jsonb_build_object(
    'full_name',   btrim(v_name),
    'name_key',    app.name_key(btrim(v_name)) || case when v_dedupe = '' then '' else '@' || v_dedupe end,
    'former_name', v_former,
    'license',     coalesce(v_license::text, 'unknown'),
    'gender',      coalesce(v_gender::text,  'unknown'),
    'raw',         v_raw
  );
end;
$$;

comment on function app.parse_person_cell is '氏名セルを {氏名, 取込キー, 旧姓, 資格, 性別} に分解する';

-- ------------------------------------------------------------
-- シート(TSV)のパース
-- ------------------------------------------------------------

create or replace function app.parse_roster_sheet(p_tsv text)
returns table (
  row_no          integer,
  general_manager text,
  area_manager    text,
  chief_director  text,
  store_name      text,
  store_category  text,
  director        text,
  seitai          text[],
  reception       text[],
  beauty_manager  text,
  beauty          text[]
)
language plpgsql
immutable
as $$
declare
  v_lines   text[];
  v_cells   text[];
  v_h1      text[] := '{}';
  v_h2      text[] := '{}';
  v_roles   text[] := '{}';
  v_fill    text;
  v_start   integer;
  v_hits2   integer := 0;
  v_hits1   integer := 0;
  v_i       integer;
  v_j       integer;
  v_role    text;
  v_val     text;
  v_ncols   integer;
  -- 結合セルの引き継ぎ
  c_gm text := null; c_mg text := null; c_chief text := null;
  -- 出力待ちの1行
  p_open   boolean := false;
  p_no     integer := 0;
  p_gm text; p_mg text; p_chief text; p_store text; p_cat text; p_dir text; p_bm text;
  p_seitai text[]; p_recep text[]; p_beauty text[];
  v_emitted integer := 0;
begin
  if coalesce(p_tsv, '') = '' then
    raise exception '取り込む組織図シートが空です';
  end if;

  v_lines := regexp_split_to_array(replace(replace(p_tsv, e'\r\n', e'\n'), e'\r', e'\n'), e'\n');

  -- 先頭の空行を落とす($sheet$ の直後の改行などで見出しがずれないように)
  while array_length(v_lines, 1) > 0
        and btrim(replace(coalesce(v_lines[1], ''), e'\t', '')) = '' loop
    v_lines := v_lines[2 : array_length(v_lines, 1)];
  end loop;
  if coalesce(array_length(v_lines, 1), 0) = 0 then
    raise exception '取り込む組織図シートが空です';
  end if;

  -- ---- 見出しの解析 ----------------------------------------
  v_cells := string_to_array(v_lines[1], e'\t');
  v_fill := '';
  for v_i in 1 .. coalesce(array_length(v_cells, 1), 0) loop
    if btrim(coalesce(v_cells[v_i], '')) <> '' then
      v_fill := btrim(v_cells[v_i]);            -- 結合された部門見出しを右へ引き継ぐ
    end if;
    v_h1[v_i] := v_fill;
    if app.roster_column_role(btrim(coalesce(v_cells[v_i], ''))) is not null then
      v_hits1 := v_hits1 + 1;
    end if;
  end loop;

  v_start := 2;
  if array_length(v_lines, 1) >= 2 then
    v_cells := string_to_array(v_lines[2], e'\t');
    for v_i in 1 .. coalesce(array_length(v_cells, 1), 0) loop
      if app.roster_column_role(btrim(coalesce(v_cells[v_i], ''))) is not null then
        v_hits2 := v_hits2 + 1;
      end if;
    end loop;
    -- 2行見出し(1行目=部門グループ / 2行目=列名)なら 2 行目もマージする
    if v_hits2 >= 2 then
      v_h2 := v_cells;
      v_start := 3;
    end if;
  end if;

  v_ncols := greatest(coalesce(array_length(v_h1, 1), 0), coalesce(array_length(v_h2, 1), 0));
  for v_i in 1 .. v_ncols loop
    v_roles[v_i] := app.roster_column_role(
      coalesce(nullif(btrim(coalesce(v_h2[v_i], '')), ''), v_h1[v_i])
    );
  end loop;

  -- v_roles が全て NULL のとき「'store' = any(...)」は NULL になるため、
  -- coalesce で必ず true/false に落としてから判定する。
  if not coalesce('store' = any (v_roles), false) then
    raise exception
      '見出し行が見つかりません。1行目(または2行目)に「統括MG / MG / 統括院長 / 店舗 / 院長 / 整体部門 / 受付スタッフ / 店長 / 美容部門」を含めてください';
  end if;

  -- ---- データ行 --------------------------------------------
  for v_i in v_start .. coalesce(array_length(v_lines, 1), 0) loop
    if btrim(replace(coalesce(v_lines[v_i], ''), e'\t', '')) = '' then
      continue;                                  -- 空行は読み飛ばす
    end if;
    v_cells := string_to_array(v_lines[v_i], e'\t');

    -- 縦の結合セルを引き継ぐ(統括MG / MG / 統括院長 のみ)。
    -- 空欄は「上と同じ」、ハイフンや「なし」は「この階層は不在」を意味する。
    for v_j in 1 .. least(coalesce(array_length(v_cells, 1), 0), v_ncols) loop
      v_role := v_roles[v_j];
      if v_role not in ('gm', 'mg', 'chief') then continue; end if;
      v_val := btrim(coalesce(v_cells[v_j], ''));
      if v_val = '' then continue; end if;
      if app.is_blank_cell(v_val) then v_val := null; end if;
      if    v_role = 'gm'    then c_gm    := v_val;
      elsif v_role = 'mg'    then c_mg    := v_val;
      elsif v_role = 'chief' then c_chief := v_val;
      end if;
    end loop;

    -- この行の店舗名
    v_val := null;
    for v_j in 1 .. least(coalesce(array_length(v_cells, 1), 0), v_ncols) loop
      if v_roles[v_j] = 'store' and not app.is_blank_cell(coalesce(v_cells[v_j], '')) then
        v_val := btrim(v_cells[v_j]);
        exit;
      end if;
    end loop;

    if v_val is not null then
      -- 新しい店舗 → 直前の行を確定して出力
      if p_open then
        row_no := p_no; general_manager := p_gm; area_manager := p_mg; chief_director := p_chief;
        store_name := p_store; store_category := p_cat; director := p_dir;
        seitai := p_seitai; reception := p_recep; beauty_manager := p_bm; beauty := p_beauty;
        return next;
        v_emitted := v_emitted + 1;
      end if;
      p_open  := true;
      p_no    := coalesce(p_no, 0) + 1;
      p_store := v_val;
      p_cat   := null; p_dir := null; p_bm := null;
      p_seitai := '{}'; p_recep := '{}'; p_beauty := '{}';
    elsif not p_open then
      continue;   -- 店舗が一度も出てこないうちの行は無視する
    end if;

    -- 店舗より上の階層は最新の引き継ぎ値を採用する
    p_gm := c_gm; p_mg := c_mg; p_chief := c_chief;

    -- セルを役割ごとに振り分ける(店舗名が空の行は同じ店舗の続きとして追記)
    for v_j in 1 .. least(coalesce(array_length(v_cells, 1), 0), v_ncols) loop
      v_role := v_roles[v_j];
      v_val  := btrim(coalesce(v_cells[v_j], ''));
      if v_role is null or app.is_blank_cell(v_val) then continue; end if;
      if    v_role = 'category'       then p_cat    := v_val;
      elsif v_role = 'director'       then p_dir    := coalesce(p_dir, v_val);
      elsif v_role = 'beauty_manager' then p_bm     := coalesce(p_bm, v_val);
      elsif v_role = 'seitai'         then p_seitai := p_seitai || v_val;
      elsif v_role = 'reception'      then p_recep  := p_recep  || v_val;
      elsif v_role = 'beauty'         then p_beauty := p_beauty || v_val;
      end if;
    end loop;
  end loop;

  if p_open then
    row_no := p_no; general_manager := p_gm; area_manager := p_mg; chief_director := p_chief;
    store_name := p_store; store_category := p_cat; director := p_dir;
    seitai := p_seitai; reception := p_recep; beauty_manager := p_bm; beauty := p_beauty;
    return next;
  end if;
end;
$$;

comment on function app.parse_roster_sheet is 'タブ区切りの組織図シートを店舗1行=1レコードに正規化する(結合セル・2行見出し対応)';

-- ------------------------------------------------------------
-- 取込のステージング(監査ログ兼用)
-- ------------------------------------------------------------

create table if not exists public.roster_import_batches (
  id           uuid primary key default gen_random_uuid(),
  imported_at  timestamptz not null default now(),
  imported_by  uuid references public.members (id) on delete set null,
  source_label text,
  options      jsonb not null default '{}'::jsonb,
  raw_tsv      text,
  result       jsonb
);

comment on table public.roster_import_batches is '組織図シートの取込履歴。貼り付けた原文をそのまま残して差分を追える';

create table if not exists public.roster_import_rows (
  batch_id        uuid not null references public.roster_import_batches (id) on delete cascade,
  row_no          integer not null,
  general_manager text,
  area_manager    text,
  chief_director  text,
  store_name      text,
  store_category  text,
  director        text,
  seitai          text[] not null default '{}',
  reception       text[] not null default '{}',
  beauty_manager  text,
  beauty          text[] not null default '{}',
  primary key (batch_id, row_no)
);

create table if not exists public.roster_import_people (
  batch_id    uuid not null references public.roster_import_batches (id) on delete cascade,
  seq         integer not null,
  row_no      integer not null,
  role_kind   text    not null,   -- gm | mg | chief | director | beauty_manager | seitai | reception | beauty
  store_name  text,
  raw_cell    text,
  full_name   text    not null,
  name_key    text    not null,
  former_name text,
  license     public.license_type not null default 'unknown',
  gender      public.gender       not null default 'unknown',
  primary key (batch_id, seq)
);

create index if not exists rip_name_key_idx on public.roster_import_people (batch_id, name_key);

-- 役割の優先度。同じ人が複数の列に出てきたら大きい方を採用する
create or replace function app.role_priority(p_role text)
returns integer
language sql
immutable
as $$
  select case p_role
    when 'gm'             then 60
    when 'mg'             then 50
    when 'chief'          then 40
    when 'director'       then 30
    when 'beauty_manager' then 25
    when 'reception'      then 12
    else 10
  end;
$$;

create or replace function app.rank_of_role(p_role text)
returns public.member_rank
language sql
immutable
as $$
  select case p_role
    when 'gm'             then 'exec'
    when 'mg'             then 'area'
    when 'chief'          then 'chief'
    when 'director'       then 'manager'
    when 'beauty_manager' then 'manager'
    else 'staff'
  end::public.member_rank;
$$;

create or replace function app.department_of_role(p_role text, p_category public.store_category)
returns public.department
language sql
immutable
as $$
  select case
    when p_role in ('gm', 'mg', 'chief') then 'management'
    when p_role = 'reception'            then 'reception'
    when p_role in ('beauty', 'beauty_manager') then 'beauty'
    when p_role = 'director' and p_category = '美容・エステ' then 'beauty'
    else 'seitai'
  end::public.department;
$$;

-- 実際の呼称。役職者は役職名、スタッフは資格名を使う(js/data.js の role と揃える)
-- 資格が未確認のスタッフは所属部門から妥当な呼称に落とす。
create or replace function app.role_title_of(p_role text, p_category public.store_category, p_license public.license_type)
returns text
language sql
immutable
as $$
  select case p_role
    when 'gm'             then '統括マネージャー'
    when 'mg'             then 'マネージャー'
    when 'chief'          then '統括院長'
    when 'director'       then public.director_title(p_category)
    when 'beauty_manager' then '店長'
    when 'reception'      then '受付'
    else coalesce(
      case p_license
        when 'judo'        then '柔道整復師'
        when 'acupuncture' then '鍼灸師'
        when 'seitai'      then '整体師'
        when 'esthetic'    then 'エステティシャン'
        when 'reception'   then '受付'
        else null
      end,
      case p_role
        when 'beauty' then 'エステティシャン'
        else 'スタッフ'
      end)
  end;
$$;

-- ------------------------------------------------------------
-- 取込前プレビュー(書き込みなし)
-- ------------------------------------------------------------

create or replace function public.preview_roster_sheet(p_tsv text)
returns table (
  row_no          integer,
  general_manager text,
  area_manager    text,
  chief_director  text,
  store_name      text,
  store_category  text,
  director        text,
  member_count    integer,
  seitai          text[],
  reception       text[],
  beauty_manager  text,
  beauty          text[],
  is_new_store    boolean
)
language sql
stable
as $$
  select
    r.row_no,
    r.general_manager,
    r.area_manager,
    r.chief_director,
    r.store_name,
    coalesce(r.store_category, app.infer_store_category(r.store_name)::text),
    r.director,
    (case when r.director is null then 0 else 1 end
      + coalesce(array_length(r.seitai, 1), 0)
      + coalesce(array_length(r.reception, 1), 0)
      + (case when r.beauty_manager is null then 0 else 1 end)
      + coalesce(array_length(r.beauty, 1), 0))::integer,
    r.seitai,
    r.reception,
    r.beauty_manager,
    r.beauty,
    not exists (select 1 from public.stores s where s.name = r.store_name)
  from app.parse_roster_sheet(p_tsv) r;
$$;

comment on function public.preview_roster_sheet is '貼り付けた組織図シートを取り込まずに確認する。行数・人数・新規店舗が分かる';

-- ------------------------------------------------------------
-- 本体:一括取込
-- ------------------------------------------------------------

create or replace function public.import_roster_sheet(
  p_tsv          text,
  p_options      jsonb default '{}'::jsonb,
  p_source_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_batch        uuid;
  v_seq          integer := 0;
  v_rec          record;
  v_person       jsonb;
  v_cell         text;
  v_actor        uuid := app.current_member_id();
  v_deactivate   boolean := coalesce((p_options ->> 'deactivate_missing')::boolean, false);
  v_default_cat  text    := coalesce(p_options ->> 'default_category', '整骨院');
  v_keep_manual  boolean := coalesce((p_options ->> 'preserve_manual_edits')::boolean, true);
  v_stores_new   integer := 0;
  v_stores_upd   integer := 0;
  v_members_new  integer := 0;
  v_members_upd  integer := 0;
  v_links        integer := 0;
  v_result       jsonb;
begin
  insert into public.roster_import_batches (imported_by, source_label, options, raw_tsv)
  values (v_actor, p_source_label, coalesce(p_options, '{}'::jsonb), p_tsv)
  returning id into v_batch;

  -- ---- 1) シートを行に正規化して保存 ----------------------
  insert into public.roster_import_rows (
    batch_id, row_no, general_manager, area_manager, chief_director,
    store_name, store_category, director, seitai, reception, beauty_manager, beauty)
  select v_batch, r.row_no, r.general_manager, r.area_manager, r.chief_director,
         r.store_name,
         coalesce(r.store_category, app.infer_store_category(r.store_name, v_default_cat)::text),
         r.director, r.seitai, r.reception, r.beauty_manager, r.beauty
    from app.parse_roster_sheet(p_tsv) r;

  if not exists (select 1 from public.roster_import_rows where batch_id = v_batch) then
    raise exception '取り込める行がありませんでした。見出し行と店舗名の列を確認してください';
  end if;

  -- ---- 2) 氏名セルを 1 人 1 行に展開 ----------------------
  insert into public.roster_import_people (
    batch_id, seq, row_no, role_kind, store_name, raw_cell,
    full_name, name_key, former_name, license, gender)
  select
    v_batch,
    row_number() over (order by x.row_no, app.role_priority(x.role_kind) desc, x.ord),
    x.row_no,
    x.role_kind,
    x.store_name,
    x.parsed ->> 'raw',
    x.parsed ->> 'full_name',
    x.parsed ->> 'name_key',
    x.parsed ->> 'former_name',
    (x.parsed ->> 'license')::public.license_type,
    (x.parsed ->> 'gender')::public.gender
  from (
    select r.row_no, r.store_name, c.role_kind, c.ord, app.parse_person_cell(c.cell) as parsed
      from public.roster_import_rows r
      cross join lateral (
        select 'gm'::text             as role_kind, 0 as ord, r.general_manager as cell
        union all select 'mg',             0, r.area_manager
        union all select 'chief',          0, r.chief_director
        union all select 'director',       0, r.director
        union all select 'beauty_manager', 0, r.beauty_manager
        union all select 'seitai',         s.ord::int, s.cell
                    from unnest(r.seitai)    with ordinality as s(cell, ord)
        union all select 'reception',      s.ord::int, s.cell
                    from unnest(r.reception) with ordinality as s(cell, ord)
        union all select 'beauty',         s.ord::int, s.cell
                    from unnest(r.beauty)    with ordinality as s(cell, ord)
      ) c
     where r.batch_id = v_batch
  ) x
  where x.parsed is not null;

  -- ---- 3) 店舗を UPSERT ------------------------------------
  with src as (
    select distinct on (r.store_name)
           r.store_name,
           coalesce(r.store_category, app.infer_store_category(r.store_name, v_default_cat)::text)::public.store_category as category,
           r.row_no
      from public.roster_import_rows r
     where r.batch_id = v_batch and r.store_name is not null
     order by r.store_name, r.row_no
  ), ups as (
    insert into public.stores (code, name, category, sort_order, is_active)
    select 'st-' || app.name_key(s.store_name), s.store_name, s.category, s.row_no * 10, true
      from src s
    on conflict (name) do update
      set category   = excluded.category,
          sort_order = excluded.sort_order,
          is_active  = true,
          updated_at = now()
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_stores_new, v_stores_upd
    from ups;

  -- ---- 4) メンバーを UPSERT --------------------------------
  -- 同じ人が複数の列に出てきた場合は、いちばん強い役職を採用する
  with best as (
    select distinct on (p.name_key)
           p.name_key, p.full_name, p.former_name, p.license, p.gender,
           p.role_kind, p.store_name, p.seq
      from public.roster_import_people p
     where p.batch_id = v_batch
     order by p.name_key, app.role_priority(p.role_kind) desc, p.seq
  ), attrs as (
    -- 資格・性別はシート内のどこかで判明していればそれを使う
    select p.name_key,
           (array_remove(array_agg(p.license order by (p.license <> 'unknown') desc, p.seq), null))[1] as license,
           (array_remove(array_agg(p.gender  order by (p.gender  <> 'unknown') desc, p.seq), null))[1] as gender,
           (array_remove(array_agg(p.former_name order by p.seq), null))[1]                            as former_name
      from public.roster_import_people p
     where p.batch_id = v_batch
     group by p.name_key
  ), home as (
    -- 主たる所属は「現場の役割」で最初に出てきた店舗
    select distinct on (p.name_key) p.name_key, p.store_name
      from public.roster_import_people p
     where p.batch_id = v_batch
       and p.role_kind in ('director', 'beauty_manager', 'seitai', 'reception', 'beauty')
     order by p.name_key, p.seq
  ), fallback_home as (
    select distinct on (p.name_key) p.name_key, p.store_name
      from public.roster_import_people p
     where p.batch_id = v_batch
     order by p.name_key, p.seq
  ), final as (
    select b.name_key,
           b.full_name,
           a.former_name,
           a.license,
           a.gender,
           b.role_kind,
           b.seq,
           coalesce(h.store_name, f.store_name) as store_name
      from best b
      join attrs a on a.name_key = b.name_key
      left join home h  on h.name_key = b.name_key
      left join fallback_home f on f.name_key = b.name_key
  ), ups as (
    insert into public.members (
      name_key, full_name, former_name, license, gender,
      rank, role_title, department, primary_store_id, sort_order, is_active)
    select
      fi.name_key,
      fi.full_name,
      fi.former_name,
      fi.license,
      fi.gender,
      app.rank_of_role(fi.role_kind),
      app.role_title_of(fi.role_kind, coalesce(st.category, '整骨院'), fi.license),
      app.department_of_role(fi.role_kind, coalesce(st.category, '整骨院')),
      st.id,
      fi.seq,
      true
    from final fi
    left join public.stores st on st.name = fi.store_name
    on conflict (name_key) do update set
      full_name        = excluded.full_name,
      former_name      = coalesce(excluded.former_name, public.members.former_name),
      -- 手入力で埋めた資格・性別はシート側が未確認なら残す
      license          = case when v_keep_manual and excluded.license = 'unknown'
                              then public.members.license else excluded.license end,
      gender           = case when v_keep_manual and excluded.gender = 'unknown'
                              then public.members.gender else excluded.gender end,
      rank             = excluded.rank,
      role_title       = excluded.role_title,
      department       = excluded.department,
      primary_store_id = coalesce(excluded.primary_store_id, public.members.primary_store_id),
      sort_order       = excluded.sort_order,
      is_active        = true,
      updated_at       = now()
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_members_new, v_members_upd
    from ups;

  -- ---- 5) 所属(兼務)を張り直す ---------------------------
  delete from public.member_store_assignments a
   where exists (
     select 1 from public.roster_import_people p
      join public.members m on m.name_key = p.name_key
     where p.batch_id = v_batch and m.id = a.member_id
   );

  -- 同じ人が同じ店舗の同じ部門に複数回出てくる場合(統括MG 兼 MG など)は
  -- いちばん強い役割だけを残す。ON CONFLICT は 1 文の中の重複を吸収できないため。
  insert into public.member_store_assignments (member_id, store_id, department, role_title, is_primary)
  select distinct on (x.member_id, x.store_id, x.department)
         x.member_id, x.store_id, x.department, x.role_title, false
    from (
      select m.id as member_id,
             s.id as store_id,
             app.department_of_role(p.role_kind, s.category)            as department,
             app.role_title_of(p.role_kind, s.category, m.license)      as role_title,
             app.role_priority(p.role_kind)                             as priority,
             p.seq
        from public.roster_import_people p
        join public.members m on m.name_key = p.name_key
        join public.stores  s on s.name = p.store_name
       where p.batch_id = v_batch
    ) x
   order by x.member_id, x.store_id, x.department, x.priority desc, x.seq
  on conflict (member_id, store_id, department) do update
    set role_title = excluded.role_title;

  -- 主たる所属にフラグを立てる
  update public.member_store_assignments a
     set is_primary = true
    from public.members m
   where m.id = a.member_id
     and m.primary_store_id = a.store_id
     and a.department = m.department
     and exists (select 1 from public.roster_import_people p
                  where p.batch_id = v_batch and p.name_key = m.name_key);

  get diagnostics v_links = row_count;   -- 主たる所属を確定した件数

  -- ---- 6) 店舗の責任者列を設定 ----------------------------
  update public.stores s set
    general_manager_id = gm.id,
    area_manager_id    = mg.id,
    chief_director_id  = cd.id,
    director_id        = dr.id,
    beauty_manager_id  = bm.id,
    updated_at         = now()
  from public.roster_import_rows r
  left join public.members gm on gm.name_key = app.name_key(r.general_manager)
  left join public.members mg on mg.name_key = app.name_key(r.area_manager)
  left join public.members cd on cd.name_key = app.name_key(r.chief_director)
  left join public.members dr on dr.name_key = app.name_key(r.director)
  left join public.members bm on bm.name_key = app.name_key(r.beauty_manager)
  where r.batch_id = v_batch and s.name = r.store_name;

  -- ---- 7) 上司(傘)を組み立てる ---------------------------
  -- 役割ごとに「上司候補」を並べ、自分自身でない最初の 1 人を採用する。
  -- 例)MG 兼 院長の人は院長としての上司(=自分)を飛ばして統括MGにぶら下がる。
  with cand as (
    select
      p.name_key,
      p.seq,
      case p.role_kind
        when 'gm'    then array[]::text[]
        when 'mg'    then array[app.name_key(r.general_manager)]
        when 'chief' then array[app.name_key(r.area_manager), app.name_key(r.general_manager)]
        when 'director' then array[app.name_key(r.chief_director), app.name_key(r.area_manager), app.name_key(r.general_manager)]
        when 'beauty_manager' then array[app.name_key(r.director), app.name_key(r.chief_director), app.name_key(r.area_manager), app.name_key(r.general_manager)]
        when 'beauty' then array[app.name_key(r.beauty_manager), app.name_key(r.director), app.name_key(r.chief_director), app.name_key(r.area_manager), app.name_key(r.general_manager)]
        else array[app.name_key(r.director), app.name_key(r.chief_director), app.name_key(r.area_manager), app.name_key(r.general_manager)]
      end as candidates
    from public.roster_import_people p
    join public.roster_import_rows  r on r.batch_id = p.batch_id and r.row_no = p.row_no
    where p.batch_id = v_batch
  ), best_role as (
    -- 1 人につき「いちばん強い役職の行」だけを採用する
    select distinct on (p.name_key) p.name_key, c.candidates
      from public.roster_import_people p
      join cand c on c.name_key = p.name_key and c.seq = p.seq
     where p.batch_id = v_batch
     order by p.name_key, app.role_priority(p.role_kind) desc, p.seq
  ), resolved as (
    select b.name_key,
           (select cc.key
              from unnest(b.candidates) with ordinality as cc(key, ord)
             where cc.key is not null and cc.key <> b.name_key
             order by cc.ord
             limit 1) as manager_key
      from best_role b
  )
  update public.members m
     set reports_to_id = mgr.id,
         updated_at    = now()
    from resolved rs
    left join public.members mgr on mgr.name_key = rs.manager_key
   where m.name_key = rs.name_key
     and m.reports_to_id is distinct from mgr.id;

  -- ---- 8) シートに出てこない人・店舗を退職/閉院にする -----
  if v_deactivate then
    update public.members m
       set is_active = false, updated_at = now()
     where m.is_active
       and m.rank <> 'hr'
       and not exists (select 1 from public.roster_import_people p
                        where p.batch_id = v_batch and p.name_key = m.name_key);
    update public.stores s
       set is_active = false, updated_at = now()
     where s.is_active
       and not exists (select 1 from public.roster_import_rows r
                        where r.batch_id = v_batch and r.store_name = s.name);
  end if;

  -- ---- 9) 結果 --------------------------------------------
  select jsonb_build_object(
    'batch_id',        v_batch,
    'rows',            (select count(*) from public.roster_import_rows   where batch_id = v_batch),
    'people_cells',    (select count(*) from public.roster_import_people where batch_id = v_batch),
    'stores_created',  v_stores_new,
    'stores_updated',  v_stores_upd,
    'members_created', v_members_new,
    'members_updated', v_members_upd,
    'assignments',     (select count(*) from public.member_store_assignments a
                         where exists (
                           select 1 from public.members m
                             join public.roster_import_people p
                               on p.batch_id = v_batch and p.name_key = m.name_key
                            where m.id = a.member_id)),
    'roots',           (select coalesce(jsonb_agg(m.full_name order by m.sort_order), '[]'::jsonb)
                          from public.members m
                         where m.reports_to_id is null and m.is_active),
    'unknown_license', (select count(distinct m.name_key) from public.members m
                         join public.roster_import_people p on p.batch_id = v_batch and p.name_key = m.name_key
                        where m.license = 'unknown'),
    'unknown_gender',  (select count(distinct m.name_key) from public.members m
                         join public.roster_import_people p on p.batch_id = v_batch and p.name_key = m.name_key
                        where m.gender = 'unknown'),
    'duplicate_names', (select coalesce(jsonb_agg(t.full_name), '[]'::jsonb) from (
                          select p.full_name from public.roster_import_people p
                           where p.batch_id = v_batch
                           group by p.full_name
                          having count(distinct p.name_key) > 1) t),
    'orphans',         (select coalesce(jsonb_agg(m.full_name order by m.full_name), '[]'::jsonb)
                          from public.members m
                         where m.is_active and m.reports_to_id is null and m.rank not in ('ceo', 'exec', 'hr'))
  ) into v_result;

  update public.roster_import_batches set result = v_result where id = v_batch;
  return v_result;
end;
$$;

comment on function public.import_roster_sheet is
  '組織図シート(TSV)を貼り付けて店舗・メンバー・傘を一括登録する。氏名キーで UPSERT するため何度でも流せる';

revoke all on function public.import_roster_sheet(text, jsonb, text) from public, anon;

-- ############################################################
-- # 0004_rls.sql
-- ############################################################

-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 04:RLS(行レベルセキュリティ)
--
-- 方針は js/auth.js と同じ:
--   ・店舗マスタと名簿は全社員が閲覧できる(誰がどこにいるかは共有情報)
--   ・自分の情報は自分で更新できる
--   ・組織の付け替えは 統括マネージャー以上 + 本部人事
--   ・一括取込は管理者(service_role)と統括マネージャー以上のみ
--
-- 「点数・評価・カルテ」など個人情報を含むテーブルは後続のマイグレーションで
-- app.can_see_member() を使って同じ形の制限をかける。
-- ============================================================

alter table public.stores                   enable row level security;
alter table public.members                  enable row level security;
alter table public.member_store_assignments enable row level security;
alter table public.mentorships              enable row level security;
alter table public.org_change_log           enable row level security;
alter table public.roster_import_batches    enable row level security;
alter table public.roster_import_rows       enable row level security;
alter table public.roster_import_people     enable row level security;

-- ------------------------------------------------------------
-- ヘルパー
-- ------------------------------------------------------------

-- ログイン中メンバーのランク強度。未ログイン/未紐付けは 0
create or replace function app.my_rank_level()
returns integer
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce((select app.rank_level(m.rank) from public.members m where m.id = app.current_member_id()), 0);
$$;

create or replace function app.my_rank()
returns public.member_rank
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select m.rank from public.members m where m.id = app.current_member_id();
$$;

-- 組織図の編集権限(js/auth.js の "org.edit" と同じ)。
-- 未ログイン時に NULL を返すと「not can_edit_org()」が真にならず素通りするため、
-- 必ず true/false のどちらかを返す。
create or replace function app.can_edit_org()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(app.my_rank_level() >= 6 or app.my_rank() = 'hr', false);
$$;

-- ------------------------------------------------------------
-- 店舗
-- ------------------------------------------------------------

drop policy if exists stores_select on public.stores;
create policy stores_select on public.stores
  for select to authenticated
  using (true);                                   -- 全社員が全店舗を閲覧できる(シフト等の前提)

drop policy if exists stores_write on public.stores;
create policy stores_write on public.stores
  for all to authenticated
  using (app.can_edit_org())
  with check (app.can_edit_org());

-- ------------------------------------------------------------
-- メンバー
-- ------------------------------------------------------------

-- 名簿そのものは全社員が見える。点数・評価など機微な値は別テーブルで制御する。
drop policy if exists members_select on public.members;
create policy members_select on public.members
  for select to authenticated
  using (true);

-- 自分のプロフィール(連絡先・かな・色)は自分で直せる
drop policy if exists members_update_self on public.members;
create policy members_update_self on public.members
  for update to authenticated
  using (id = app.current_member_id())
  with check (id = app.current_member_id());

-- 組織の付け替え・メンバー登録は統括マネージャー以上と本部人事
drop policy if exists members_manage on public.members;
create policy members_manage on public.members
  for all to authenticated
  using (app.can_edit_org())
  with check (app.can_edit_org());

-- ------------------------------------------------------------
-- 所属・メンター
-- ------------------------------------------------------------

drop policy if exists msa_select on public.member_store_assignments;
create policy msa_select on public.member_store_assignments
  for select to authenticated using (true);

drop policy if exists msa_manage on public.member_store_assignments;
create policy msa_manage on public.member_store_assignments
  for all to authenticated
  using (app.can_edit_org())
  with check (app.can_edit_org());

drop policy if exists mentorships_select on public.mentorships;
create policy mentorships_select on public.mentorships
  for select to authenticated using (true);

-- メンターの割り当ては院長・店長以上(自分の傘の中のメンティーに対して)
drop policy if exists mentorships_manage on public.mentorships;
create policy mentorships_manage on public.mentorships
  for all to authenticated
  using (app.my_rank_level() >= 3 and app.can_see_member(app.current_member_id(), mentee_id))
  with check (app.my_rank_level() >= 3 and app.can_see_member(app.current_member_id(), mentee_id));

-- ------------------------------------------------------------
-- 変更履歴
-- ------------------------------------------------------------

drop policy if exists org_log_select on public.org_change_log;
create policy org_log_select on public.org_change_log
  for select to authenticated using (true);

drop policy if exists org_log_insert on public.org_change_log;
create policy org_log_insert on public.org_change_log
  for insert to authenticated
  with check (app.can_edit_org());

-- ------------------------------------------------------------
-- 取込バッチ(組織図シート)
-- ------------------------------------------------------------
-- 貼り付けた原文には全社員の氏名が含まれるため、閲覧も編集も
-- 組織図を編集できる人(統括マネージャー以上・本部人事)に限定する。

drop policy if exists rib_all on public.roster_import_batches;
create policy rib_all on public.roster_import_batches
  for all to authenticated
  using (app.can_edit_org()) with check (app.can_edit_org());

drop policy if exists rir_all on public.roster_import_rows;
create policy rir_all on public.roster_import_rows
  for all to authenticated
  using (app.can_edit_org()) with check (app.can_edit_org());

drop policy if exists rip_all on public.roster_import_people;
create policy rip_all on public.roster_import_people
  for all to authenticated
  using (app.can_edit_org()) with check (app.can_edit_org());

-- ------------------------------------------------------------
-- 実行権限
-- ------------------------------------------------------------

grant usage on schema public to authenticated;
grant select on public.v_org_tree, public.v_member_directory, public.v_store_roster to authenticated;

grant execute on function public.director_title(public.store_category)          to authenticated;
grant execute on function public.visibility_reason(uuid, uuid)                  to authenticated;
grant execute on function public.preview_roster_sheet(text)                     to authenticated;

-- 一括取込は security definer なので、実行できる人を明示的に絞る。
-- (関数の中身は RLS を迂回するため、ここが唯一の関門になる)
revoke all on function public.import_roster_sheet(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.import_roster_sheet(text, jsonb, text) to service_role;

-- 画面から実行できるように、権限チェック付きのラッパーを用意する
create or replace function public.import_roster_sheet_as_admin(
  p_tsv          text,
  p_options      jsonb default '{}'::jsonb,
  p_source_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if not app.can_edit_org() then
    raise exception '組織図の一括登録は統括マネージャー以上または本部人事のみ実行できます'
      using errcode = 'insufficient_privilege';
  end if;
  perform set_config('app.change_source', 'import', true);
  return public.import_roster_sheet(p_tsv, p_options, p_source_label);
end;
$$;

comment on function public.import_roster_sheet_as_admin is
  '画面(supabase-js)から呼ぶ一括取込。実行者のランクを検査してから import_roster_sheet に委譲する';

revoke all on function public.import_roster_sheet_as_admin(text, jsonb, text) from public, anon;
grant execute on function public.import_roster_sheet_as_admin(text, jsonb, text) to authenticated, service_role;

-- ############################################################
-- # 0005_accounts.sql
-- ############################################################

-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 05:社員アカウントの紐付け
--
-- 組織図シートには氏名しか無いので、Supabase Auth のユーザーとは
-- 「メールアドレス」を橋渡しにして結びつける。
--
--   1) members.email を埋める        … set_member_emails()
--   2) Supabase Auth で社員を招待する … ダッシュボード / Admin API
--   3) auth.users と突き合わせる      … link_member_accounts()
--
-- 3 は何度実行してもよい。招待を受けた人から順に紐付いていく。
-- ============================================================

-- ------------------------------------------------------------
-- メールアドレスの一括設定
-- ------------------------------------------------------------

/**
 * 氏名 → メールアドレス の対応をまとめて登録する。
 *   select public.set_member_emails('[
 *     {"name": "日野 碧人", "email": "hino@example.co.jp"},
 *     {"name": "竹内 香織", "email": "takeuchi@example.co.jp"}
 *   ]'::jsonb);
 * 氏名は空白の有無を無視して照合する(取込と同じキー)。
 */
create or replace function public.set_member_emails(p_pairs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_updated integer := 0;
  v_missing text[] := '{}';
  v_item    jsonb;
begin
  if not app.can_edit_org() then
    raise exception 'メールアドレスの一括設定は統括マネージャー以上または本部人事のみ実行できます'
      using errcode = 'insufficient_privilege';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) loop
    update public.members m
       set email = nullif(btrim(v_item ->> 'email'), ''),
           updated_at = now()
     where m.name_key = app.name_key(v_item ->> 'name');
    if found then
      v_updated := v_updated + 1;
    else
      v_missing := v_missing || (v_item ->> 'name');
    end if;
  end loop;

  return jsonb_build_object(
    'updated', v_updated,
    'not_found', to_jsonb(v_missing)
  );
end;
$$;

comment on function public.set_member_emails is '氏名とメールアドレスの対応をまとめて登録する(組織図取込のあとに実行する)';

revoke all on function public.set_member_emails(jsonb) from public, anon;
grant execute on function public.set_member_emails(jsonb) to authenticated, service_role;

-- ------------------------------------------------------------
-- Auth ユーザーとの突き合わせ
-- ------------------------------------------------------------

/**
 * members.email と auth.users.email が一致する行を紐付ける。
 * 招待の進み具合に合わせて何度でも実行してよい。
 */
create or replace function public.link_member_accounts()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_linked integer := 0;
begin
  if not app.can_edit_org() then
    raise exception 'アカウントの紐付けは統括マネージャー以上または本部人事のみ実行できます'
      using errcode = 'insufficient_privilege';
  end if;

  with pairs as (
    select m.id as member_id, u.id as user_id
      from public.members m
      join auth.users u on lower(u.email) = lower(m.email)
     where m.email is not null
       and m.auth_user_id is distinct from u.id
       -- 1人のユーザーが2人のメンバーに紐付かないようにする
       and not exists (select 1 from public.members x where x.auth_user_id = u.id)
  ), upd as (
    update public.members m
       set auth_user_id = p.user_id, updated_at = now()
      from pairs p
     where m.id = p.member_id
    returning 1
  )
  select count(*) into v_linked from upd;

  return jsonb_build_object(
    'linked', v_linked,
    'total_linked', (select count(*) from public.members where auth_user_id is not null),
    'awaiting_invite', (select coalesce(jsonb_agg(full_name order by full_name), '[]'::jsonb)
                          from public.members
                         where is_active and auth_user_id is null and email is not null),
    'missing_email', (select count(*) from public.members where is_active and email is null)
  );
end;
$$;

comment on function public.link_member_accounts is 'members.email と auth.users.email を突き合わせてログインアカウントを紐付ける';

revoke all on function public.link_member_accounts() from public, anon;
grant execute on function public.link_member_accounts() to authenticated, service_role;

-- ------------------------------------------------------------
-- 自分の情報(画面の初期表示に使う)
-- ------------------------------------------------------------

create or replace function public.me()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select case when m.id is null then null else jsonb_build_object(
    'id',            m.id,
    'full_name',     m.full_name,
    'rank',          m.rank,
    'rank_label',    app.rank_label(m.rank),
    'rank_level',    app.rank_level(m.rank),
    'role_title',    m.role_title,
    'department',    m.department,
    'store_id',      m.primary_store_id,
    'store_name',    s.name,
    'manager_id',    m.reports_to_id,
    'can_edit_org',  app.can_edit_org(),
    'managed_store_ids', (select coalesce(jsonb_agg(store_id), '[]'::jsonb) from app.managed_store_ids(m.id)),
    'subordinates',      (select count(*) from app.subtree_ids(m.id)),
    'mentees',           (select count(*) from public.mentorships ms
                           where ms.mentor_id = m.id and ms.ended_on is null)
  ) end
  from public.members m
  left join public.stores s on s.id = m.primary_store_id
  where m.id = app.current_member_id();
$$;

comment on function public.me is 'ログイン中のメンバー情報。画面の権限判定(js/auth.js)の初期値として使う';

grant execute on function public.me() to authenticated;

-- ------------------------------------------------------------
-- 紐付け状況の確認ビュー
-- ------------------------------------------------------------

create or replace view public.v_account_status as
select
  m.id,
  m.full_name,
  m.role_title,
  s.name as store_name,
  m.email,
  case
    when m.auth_user_id is not null then 'ログイン可'
    when m.email is null            then 'メール未登録'
    else '招待待ち'
  end as status,
  m.is_active
from public.members m
left join public.stores s on s.id = m.primary_store_id
where m.is_active;

comment on view public.v_account_status is 'アカウント発行の進捗。「メール未登録」→「招待待ち」→「ログイン可」の順に進む';

grant select on public.v_account_status to authenticated;

-- ############################################################
-- # 0006_app_bridge.sql
-- ############################################################

-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 06:アプリとの橋渡し
--
-- アプリ側(js/)は uuid ではなく「安定コード」でデータを持っている。
--
--   店舗  … stores.code        ('st-narimasu')
--   人    … members.employee_no('145')
--
-- 画面のあいだで id を持ち回るのはこのコードなので、
-- 参照用ビューにもコードを返させて、uuid をブラウザに出さずに済ませる。
-- (js/remote.js の toLocal がこの列名をそのまま読む)
--
-- 破壊的変更なし。既存の列はそのままで、末尾に足すだけ。
-- ============================================================

-- ------------------------------------------------------------
-- ログイン済みユーザーに「入口」を渡す
--
-- 0004 は RLS(どの行が見えるか)を整えたが、その手前の
-- テーブル権限(そもそも触れるか)がビューにしか渡っていなかった。
-- RLS のポリシー式は「問い合わせた本人の権限」で評価されるため、
--   ・app.* を呼ぶための schema USAGE
--   ・実テーブルへの select / insert / update
-- が無いと、社員がログインした瞬間にすべて
-- 「permission denied for schema app」「permission denied for table members」
-- になる。ここで渡すのは入口だけで、どの行が見えるかは 0004 の RLS が決める。
--
-- ※ PostgREST が API に公開するのは public スキーマだけなので、
--    app スキーマの関数が外から直接叩かれることはない。
-- ------------------------------------------------------------
grant usage on schema app to authenticated;

grant select, insert, update, delete on
  public.stores,
  public.members,
  public.member_store_assignments,
  public.mentorships
  to authenticated;

grant select, insert on public.org_change_log to authenticated;

-- ------------------------------------------------------------
-- ビューは既定で「作った人の権限」で動く
--
-- PostgreSQL のビューは所有者(= マイグレーションを流した管理者)の
-- 権限で中身を読む。つまりビュー越しに読むと、下のテーブルに掛けた
-- RLS がまるごと素通りする。
-- security_invoker を立てると「見ている本人の権限」で読むようになり、
-- RLS が効く。PostgreSQL 15 以降で使える(Supabase は 15+)。
--
-- これを忘れると、v_app_attendance のようなビューが
-- 全社員の勤怠を誰にでも見せてしまう。
-- ------------------------------------------------------------
alter view public.v_org_tree        set (security_invoker = true);
alter view public.v_store_roster    set (security_invoker = true);
alter view public.v_account_status  set (security_invoker = true);

-- ------------------------------------------------------------
-- 管轄店舗に「主所属」も数える
--
-- 0002 の app.managed_store_ids は member_store_assignments(兼務表)
-- だけを見ていた。組織図シートから取り込めば必ず作られる表だが、
-- 画面からメンバーを1人足したときなど、兼務行が無いまま
-- primary_store_id だけが埋まることがある。
-- そのとき院長が自分の院の勤怠を承認できない・シフトを組めない、
-- という分かりにくい詰まり方をするので、主所属も管轄に数える。
--
-- 広がるのは「院長・店長以上」だけ(判定条件は 0002 のまま)。
-- アプリが名前の横に出している店舗と、権限の範囲が一致する。
-- ------------------------------------------------------------
create or replace function app.managed_store_ids(p_member_id uuid)
returns table (store_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rank  public.member_rank;
  v_level integer;
begin
  select m.rank into v_rank from public.members m where m.id = p_member_id;
  if v_rank is null then
    return;
  end if;

  -- 本部人事は勤怠・シフト管理のため全店舗を対象にする
  if v_rank::text = 'hr' then
    return query select s.id from public.stores s where s.is_active;
    return;
  end if;

  v_level := app.rank_level(v_rank);

  return query
  with scope as (
    select p_member_id as id
    union
    select t.member_id from app.subtree_ids(p_member_id) t
  ),
  owned as (
    -- 兼務表(組織図シートの取込が作る)
    select a.store_id, m.rank
      from public.member_store_assignments a
      join scope on scope.id = a.member_id
      join public.members m on m.id = a.member_id
     where a.ended_on is null
    union all
    -- 主所属(画面から足した人など、兼務行が無い場合の受け皿)
    select m.primary_store_id, m.rank
      from public.members m
      join scope on scope.id = m.id
     where m.primary_store_id is not null
       and m.is_active
  )
  select distinct o.store_id
    from owned o
   where o.store_id is not null
     and (v_level >= 3 or o.rank::text = 'manager');
end;
$$;

comment on function app.managed_store_ids is
  'シフト編集・勤怠承認ができる店舗。兼務表と主所属の両方から、組織ツリーをたどって毎回計算する';

-- ------------------------------------------------------------
-- 社労士へ提出する「所属コード」。給与連絡表の1列目に入る2桁の番号で、
-- 店舗ごとに固定。アプリ側は stores.deptCode として持っている。
-- ------------------------------------------------------------
alter table public.stores add column if not exists dept_code text;

comment on column public.stores.dept_code is '社労士提出用の所属コード(給与連絡表の「所属」列)';

-- ------------------------------------------------------------
-- 名簿ビューにコード列を足す
--   create or replace view は「末尾への追加」だけ許されるため、
--   既存の列順は 0002 のまま一字も変えずに写している。
-- ------------------------------------------------------------
create or replace view public.v_member_directory
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
  -- ↓ ここから 0006 で追加。アプリが使う安定コードと表示用の属性
  s.code   as store_code,
  mgr.employee_no as manager_employee_no,
  m.color,
  m.employment,
  m.sort_order
from public.members m
left join public.stores  s   on s.id = m.primary_store_id
left join public.members mgr on mgr.id = m.reports_to_id;

comment on view public.v_member_directory is
  'メンバー名簿。ランク・部門・上司・配下人数をラベル付きで返す。store_code / manager_employee_no はアプリ側の安定キー';

-- 0002 が作り直したときに権限が落ちるので、ここで渡し直す
grant select on public.v_member_directory to authenticated;

-- ------------------------------------------------------------
-- 店舗ビュー(アプリの stores コレクションに対応)
--   RLS で stores を直接読ませているが、
--   列名をアプリ側の形にそろえた入口も用意しておく。
-- ------------------------------------------------------------
create or replace view public.v_app_stores
  with (security_invoker = true) as
select
  s.code,
  s.name,
  s.short_name,
  s.category,
  s.postal_code,
  s.address,
  s.phone,
  s.lat,
  s.lng,
  s.radius_m,
  s.open_hour,
  s.close_hour,
  s.closed_dow,
  s.beds,
  s.color,
  s.dept_code,
  s.is_pilot,
  s.sort_order
from public.stores s
where s.is_active
order by s.sort_order, s.name;

comment on view public.v_app_stores is '店舗一覧(アプリの stores コレクション用。uuid を出さない)';

grant select on public.v_app_stores to authenticated;

-- ------------------------------------------------------------
-- 自分の情報にも安定コードを持たせる
--   ログイン直後、アプリはこれで「自分が名簿のどの行か」を決める。
-- ------------------------------------------------------------
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

comment on function public.me is
  'ログイン中のメンバー情報。画面の権限判定(js/auth.js)の初期値として使う。employee_no / store_code はアプリ側の安定キー';

grant execute on function public.me() to authenticated;

-- ------------------------------------------------------------
-- 社員番号が空だと、アプリ側の安定キーが作れない。
-- 取込直後に一括で振れるようにしておく(既に入っている番号は触らない)。
--   select public.fill_employee_numbers();       -- 既定の 'K0001' 形式
--   select public.fill_employee_numbers('S', 3); -- 'S001' 形式
-- ------------------------------------------------------------
create or replace function public.fill_employee_numbers(
  p_prefix text default 'K',
  p_width  integer default 4
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_filled integer := 0;
  v_next   integer;
begin
  if not app.can_edit_org() then
    raise exception '社員番号の一括採番は統括マネージャー以上または本部人事のみ実行できます'
      using errcode = 'insufficient_privilege';
  end if;

  -- 既存の 'K0007' のような番号から続きを決める
  select coalesce(max(substring(employee_no from '^' || p_prefix || '([0-9]+)$')::integer), 0) + 1
    into v_next
    from public.members
   where employee_no ~ ('^' || p_prefix || '[0-9]+$');

  with target as (
    select id, row_number() over (order by sort_order, full_name) - 1 as n
      from public.members
     where employee_no is null
  )
  update public.members m
     set employee_no = p_prefix || lpad((v_next + t.n)::text, p_width, '0'),
         updated_at = now()
    from target t
   where m.id = t.id;

  get diagnostics v_filled = row_count;

  return jsonb_build_object(
    'filled', v_filled,
    'total_with_number', (select count(*) from public.members where employee_no is not null),
    'still_missing',     (select count(*) from public.members where employee_no is null)
  );
end;
$$;

comment on function public.fill_employee_numbers is
  '社員番号が空のメンバーに連番を振る。アプリ側の安定キーになるため、取込後に一度実行する';

revoke all on function public.fill_employee_numbers(text, integer) from public, anon;
grant execute on function public.fill_employee_numbers(text, integer) to authenticated, service_role;

-- ############################################################
-- # 0007_daily_operations.sql
-- ############################################################

-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 07:毎日の業務
--
--   勤怠 attendance        … 打刻。給与連絡表の元データ
--   シフト shifts          … 1人1日1枠
--   希望休 shift_requests  … 月ごとの希望(理由は任意)
--   日報 daily_reports     … 施術数・売上・所感
--
-- 見える範囲の考え方は 0004 と同じ。
--   自分 … いつでも
--   配下 … app.can_see_member()(組織図の傘)
--   人事 … 勤怠とシフトは全社(日報は対象外。js/auth.js と揃える)
--   事務 … 給与に直結する勤怠は全社(閲覧のみ)
--
-- アプリ側は uuid ではなく安定コードで持つため、
-- 行を一意にするキーは「アプリが作った id」(app_id)にしている。
-- これで端末側で採番 → あとから送信、という順番でも衝突しない。
-- ============================================================

-- ------------------------------------------------------------
-- 事務職員ランク。js/auth.js の RANKS に 'clerk' を足したので合わせる
-- ------------------------------------------------------------
-- ※ 新しい enum 値は「追加したのと同じトランザクション内では使えない」。
--    そのため以下の関数・ポリシーはすべて ::text で比較している。
alter type public.member_rank add value if not exists 'clerk';

-- ランクの強さ。0002 の app.rank_level に clerk を足す
create or replace function app.rank_level(p_rank public.member_rank)
returns integer
language sql
immutable
as $$
  select case p_rank::text
    when 'ceo'     then 7
    when 'exec'    then 6
    when 'area'    then 5
    when 'chief'   then 4
    when 'manager' then 3
    when 'hr'      then 3
    when 'mentor'  then 2
    when 'clerk'   then 1
    else 1
  end;
$$;

create or replace function app.rank_label(p_rank public.member_rank)
returns text
language sql
immutable
as $$
  select case p_rank::text
    when 'ceo'     then '社長'
    when 'exec'    then '統括マネージャー'
    when 'area'    then 'マネージャー'
    when 'chief'   then '統括院長'
    when 'manager' then '院長・店長'
    when 'hr'      then '本部人事'
    when 'mentor'  then 'メンター'
    when 'clerk'   then '事務職員'
    else 'スタッフ'
  end;
$$;

-- 給与に直結する情報(勤怠・経費・交通費・発注)を最終確認する人
create or replace function app.is_payroll_clerk()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(app.my_rank()::text in ('clerk', 'hr') or app.my_rank_level() >= 6, false);
$$;

-- 勤怠・シフトを全社で扱える人(本部人事・事務・統括マネージャー以上)
create or replace function app.can_see_all_attendance()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(app.my_rank()::text in ('hr', 'clerk') or app.my_rank_level() >= 6, false);
$$;

-- 自分の店舗を管轄しているか(院長・店長以上)
create or replace function app.manages_store(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select p_store_id is not null
     and exists (
       select 1 from app.managed_store_ids(app.current_member_id()) m
        where m.store_id = p_store_id
     );
$$;

-- ------------------------------------------------------------
-- 共通:アプリ側の id を持つ行の作り
--   app_id  … 'at0001' 'sh0012' のようにアプリが採番した安定キー
--   すべての表で unique。sync.js の upsert がこれを使う。
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 勤怠
-- ------------------------------------------------------------
create table if not exists public.attendance (
  id          uuid primary key default gen_random_uuid(),
  app_id      text        not null unique,
  member_id   uuid        not null references public.members (id) on delete cascade,
  store_id    uuid        references public.stores (id) on delete set null,
  work_date   date        not null,
  shift_type  text,                                   -- early / late / full / off / training
  clock_in    time,
  clock_out   time,
  break_min   integer     not null default 0,
  status      text        not null default 'normal',  -- normal / late / early / absent / paid ...
  gps_ok      boolean     not null default true,
  approved    boolean     not null default false,
  approved_by uuid        references public.members (id) on delete set null,
  approved_at timestamptz,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint attendance_break_nonneg check (break_min >= 0),
  constraint attendance_one_per_day unique (member_id, work_date)
);

create index if not exists attendance_member_date_idx on public.attendance (member_id, work_date desc);
create index if not exists attendance_store_date_idx  on public.attendance (store_id, work_date desc);
create index if not exists attendance_unapproved_idx  on public.attendance (approved, work_date desc)
  where approved = false;

comment on table public.attendance is '打刻。給与連絡表(社労士提出)の元データ';

-- ------------------------------------------------------------
-- シフト
-- ------------------------------------------------------------
create table if not exists public.shifts (
  id         uuid primary key default gen_random_uuid(),
  app_id     text        not null unique,
  member_id  uuid        not null references public.members (id) on delete cascade,
  store_id   uuid        references public.stores (id) on delete set null,
  work_date  date        not null,
  shift_type text        not null default 'full',   -- early / late / full / off / training
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shifts_one_per_day unique (member_id, work_date)
);

create index if not exists shifts_date_idx  on public.shifts (work_date);
create index if not exists shifts_store_idx on public.shifts (store_id, work_date);

comment on table public.shifts is 'シフト。1人1日1枠';

-- ------------------------------------------------------------
-- 希望休(月ごと)
--   wishes / reasons は「日付 → 種別」「日付 → 理由」の対応。
--   理由は任意入力なので、空でも提出できる。
-- ------------------------------------------------------------
create table if not exists public.shift_requests (
  id           uuid primary key default gen_random_uuid(),
  app_id       text        not null unique,
  member_id    uuid        not null references public.members (id) on delete cascade,
  target_month text        not null,                     -- 'YYYY-MM'
  wishes       jsonb       not null default '{}'::jsonb, -- {"2026-10-05":"off"}
  reasons      jsonb       not null default '{}'::jsonb, -- {"2026-10-05":"通院のため"}
  note         text,
  submitted_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint shift_requests_month_format check (target_month ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint shift_requests_one_per_month unique (member_id, target_month)
);

create index if not exists shift_requests_month_idx on public.shift_requests (target_month);

comment on table public.shift_requests is '希望休。理由は任意(reasons に入っていない日は理由なし)';

-- ------------------------------------------------------------
-- 日報
-- ------------------------------------------------------------
create table if not exists public.daily_reports (
  id            uuid primary key default gen_random_uuid(),
  app_id        text        not null unique,
  member_id     uuid        not null references public.members (id) on delete cascade,
  store_id      uuid        references public.stores (id) on delete set null,
  report_date   date        not null,
  revenue       integer     not null default 0,
  treatments    integer     not null default 0,
  new_patients  integer     not null default 0,
  proposals     integer     not null default 0,  -- 回数券の提案数
  contracts     integer     not null default 0,  -- 成約数
  goods         integer     not null default 0,  -- 物販
  comment       text,
  ai_summary    text,
  status        text        not null default 'draft',  -- draft / submitted
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint daily_reports_one_per_day unique (member_id, report_date),
  constraint daily_reports_status_ok check (status in ('draft', 'submitted'))
);

create index if not exists daily_reports_member_date_idx on public.daily_reports (member_id, report_date desc);
create index if not exists daily_reports_store_date_idx  on public.daily_reports (store_id, report_date desc);

comment on table public.daily_reports is '日報。閲覧は組織図の傘の中(本部人事は対象外)';

-- ------------------------------------------------------------
-- updated_at
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['attendance', 'shifts', 'shift_requests', 'daily_reports'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format(
      'create trigger %I_touch before update on public.%I
         for each row execute function app.touch_updated_at()', t, t);
  end loop;
end $$;

-- ============================================================
-- 権限(RLS)
-- ============================================================

alter table public.attendance     enable row level security;
alter table public.shifts         enable row level security;
alter table public.shift_requests enable row level security;
alter table public.daily_reports  enable row level security;

-- ---------------- 勤怠 ----------------
-- 見える:自分 / 傘の中 / 全社(人事・事務・統括MG以上)
drop policy if exists attendance_select on public.attendance;
create policy attendance_select on public.attendance
  for select to authenticated
  using (
    member_id = app.current_member_id()
    or app.can_see_all_attendance()
    or app.can_see_member(app.current_member_id(), member_id)
  );

-- 打刻できる:本人だけ(人事は打刻しない。js/auth.js の kintai.punch と同じ)
drop policy if exists attendance_insert on public.attendance;
create policy attendance_insert on public.attendance
  for insert to authenticated
  with check (member_id = app.current_member_id() and app.my_rank()::text <> 'hr');

-- 直せる:本人(未承認のあいだ)/ 管轄の責任者 / 人事
-- ※ 承認済みの打刻を本人が書き換えられないようにする。給与に直結するため
drop policy if exists attendance_update on public.attendance;
create policy attendance_update on public.attendance
  for update to authenticated
  using (
    (member_id = app.current_member_id() and approved = false)
    or app.my_rank()::text in ('hr', 'ceo')
    or app.manages_store(store_id)
  )
  with check (
    (member_id = app.current_member_id() and approved = false)
    or app.my_rank()::text in ('hr', 'ceo')
    or app.manages_store(store_id)
  );

-- 消せる:人事と社長のみ(履歴を守る)
drop policy if exists attendance_delete on public.attendance;
create policy attendance_delete on public.attendance
  for delete to authenticated
  using (app.my_rank()::text in ('hr', 'ceo'));

-- ---------------- シフト ----------------
-- 見える:全社員(誰がいつ出るかは全員が知る必要がある)
drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts
  for select to authenticated using (true);

-- 組める:管轄の責任者・社長(人事は組まない。js/auth.js の shift.edit と同じ)
drop policy if exists shifts_write on public.shifts;
create policy shifts_write on public.shifts
  for all to authenticated
  using (app.my_rank()::text = 'ceo' or (app.my_rank()::text <> 'hr' and app.manages_store(store_id)))
  with check (app.my_rank()::text = 'ceo' or (app.my_rank()::text <> 'hr' and app.manages_store(store_id)));

-- ---------------- 希望休 ----------------
-- 見える:自分 / 傘の中(院長が部下の希望を見る)/ 人事
drop policy if exists shift_requests_select on public.shift_requests;
create policy shift_requests_select on public.shift_requests
  for select to authenticated
  using (
    member_id = app.current_member_id()
    or app.my_rank()::text in ('hr', 'ceo')
    or app.can_see_member(app.current_member_id(), member_id)
  );

-- 出せる・直せる:本人のみ
drop policy if exists shift_requests_write on public.shift_requests;
create policy shift_requests_write on public.shift_requests
  for all to authenticated
  using (member_id = app.current_member_id())
  with check (member_id = app.current_member_id());

-- ---------------- 日報 ----------------
-- 見える:自分 / 傘の中 / メンティー。本部人事と事務は対象外
drop policy if exists daily_reports_select on public.daily_reports;
create policy daily_reports_select on public.daily_reports
  for select to authenticated
  using (
    app.my_rank()::text not in ('hr', 'clerk')
    and (
      member_id = app.current_member_id()
      or app.can_see_member(app.current_member_id(), member_id)
    )
  );

-- 書ける:本人のみ(人事・事務は日報を書かない)
drop policy if exists daily_reports_write on public.daily_reports;
create policy daily_reports_write on public.daily_reports
  for all to authenticated
  using (member_id = app.current_member_id() and app.my_rank()::text not in ('hr', 'clerk'))
  with check (member_id = app.current_member_id() and app.my_rank()::text not in ('hr', 'clerk'));

grant select, insert, update, delete
  on public.attendance, public.shifts, public.shift_requests, public.daily_reports
  to authenticated;

-- ============================================================
-- アプリ向けビュー(uuid を出さず、安定コードで返す)
-- ============================================================

create or replace view public.v_app_attendance
  with (security_invoker = true) as
select
  a.app_id            as id,
  m.employee_no       as staff_id,
  st.code             as store_id,
  a.work_date         as date,
  a.shift_type,
  a.clock_in,
  a.clock_out,
  a.break_min,
  a.status,
  a.gps_ok,
  a.approved,
  am.employee_no      as approved_by,
  a.approved_at,
  a.note
from public.attendance a
join public.members m on m.id = a.member_id
left join public.stores  st on st.id = a.store_id
left join public.members am on am.id = a.approved_by;

create or replace view public.v_app_shifts
  with (security_invoker = true) as
select
  s.app_id       as id,
  m.employee_no  as staff_id,
  st.code        as store_id,
  s.work_date    as date,
  s.shift_type   as type,
  s.note
from public.shifts s
join public.members m on m.id = s.member_id
left join public.stores st on st.id = s.store_id;

create or replace view public.v_app_shift_requests
  with (security_invoker = true) as
select
  r.app_id       as id,
  m.employee_no  as staff_id,
  r.target_month as month,
  r.wishes,
  r.reasons,
  r.note,
  r.submitted_at
from public.shift_requests r
join public.members m on m.id = r.member_id;

create or replace view public.v_app_daily_reports
  with (security_invoker = true) as
select
  d.app_id       as id,
  m.employee_no  as staff_id,
  st.code        as store_id,
  d.report_date  as date,
  d.revenue,
  d.treatments,
  d.new_patients,
  d.proposals,
  d.contracts,
  d.goods,
  d.comment,
  d.ai_summary,
  d.status
from public.daily_reports d
join public.members m on m.id = d.member_id
left join public.stores st on st.id = d.store_id;

comment on view public.v_app_attendance     is '勤怠(アプリ用。社員番号・店舗コードで返す)';
comment on view public.v_app_shifts         is 'シフト(アプリ用)';
comment on view public.v_app_shift_requests is '希望休(アプリ用)';
comment on view public.v_app_daily_reports  is '日報(アプリ用)';

grant select on
  public.v_app_attendance, public.v_app_shifts,
  public.v_app_shift_requests, public.v_app_daily_reports
  to authenticated;

-- ============================================================
-- 書き込みの入口
--   アプリは社員番号・店舗コードしか持っていないので、
--   uuid への読み替えをサーバー側で引き受ける。
--   ビューに INSTEAD OF トリガを置き、PostgREST から
--   ビューへ upsert / update できるようにする。
-- ============================================================

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

-- ---------------- 勤怠 ----------------
create or replace function app.write_app_attendance()
returns trigger
language plpgsql
security invoker            -- RLS を効かせたまま書く(迂回させない)
set search_path = public, pg_catalog
as $$
declare v_member uuid; v_store uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.attendance where app_id = old.id;
    return old;
  end if;

  v_member := app.member_id_of(new.staff_id);
  v_store  := app.store_id_of(new.store_id);
  if v_member is null then
    raise exception '社員番号 % のメンバーが見つかりません', new.staff_id using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'UPDATE' then
    update public.attendance set
      store_id    = coalesce(v_store, store_id),
      shift_type  = coalesce(new.shift_type, shift_type),
      clock_in    = new.clock_in,
      clock_out   = new.clock_out,
      break_min   = coalesce(new.break_min, 0),
      status      = coalesce(new.status, 'normal'),
      gps_ok      = coalesce(new.gps_ok, true),
      note        = new.note,
      approved    = coalesce(new.approved, false),
      approved_by = case when coalesce(new.approved, false) and not approved
                         then app.current_member_id() else approved_by end,
      approved_at = case when coalesce(new.approved, false) and not approved
                         then now() else approved_at end
    where app_id = old.id;
    return new;
  end if;

  insert into public.attendance as a (
    app_id, member_id, store_id, work_date, shift_type,
    clock_in, clock_out, break_min, status, gps_ok, approved, note
  ) values (
    new.id, v_member, v_store, new.date, new.shift_type,
    new.clock_in, new.clock_out, coalesce(new.break_min, 0), coalesce(new.status, 'normal'),
    coalesce(new.gps_ok, true), coalesce(new.approved, false), new.note
  )
  on conflict (app_id) do update set
    store_id   = coalesce(excluded.store_id, a.store_id),
    shift_type = coalesce(excluded.shift_type, a.shift_type),
    clock_in   = excluded.clock_in,
    clock_out  = excluded.clock_out,
    break_min  = excluded.break_min,
    status     = excluded.status,
    gps_ok     = excluded.gps_ok,
    approved   = excluded.approved,
    note       = excluded.note,
    approved_by = case when excluded.approved and not a.approved
                       then app.current_member_id() else a.approved_by end,
    approved_at = case when excluded.approved and not a.approved
                       then now() else a.approved_at end;
  return new;
end;
$$;

drop trigger if exists v_app_attendance_write on public.v_app_attendance;
create trigger v_app_attendance_write
  instead of insert or update or delete on public.v_app_attendance
  for each row execute function app.write_app_attendance();

-- ---------------- シフト ----------------
create or replace function app.write_app_shifts()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare v_member uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.shifts where app_id = old.id;
    return old;
  end if;
  v_member := app.member_id_of(new.staff_id);
  if v_member is null then
    raise exception '社員番号 % のメンバーが見つかりません', new.staff_id using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'UPDATE' then
    update public.shifts set
      store_id   = coalesce(app.store_id_of(new.store_id), store_id),
      shift_type = coalesce(new.type, shift_type),
      note       = new.note
    where app_id = old.id;
    return new;
  end if;

  insert into public.shifts as s (app_id, member_id, store_id, work_date, shift_type, note)
  values (new.id, v_member, app.store_id_of(new.store_id), new.date, coalesce(new.type, 'full'), new.note)
  on conflict (app_id) do update set
    store_id   = coalesce(excluded.store_id, s.store_id),
    shift_type = excluded.shift_type,
    note       = excluded.note;
  return new;
end;
$$;

drop trigger if exists v_app_shifts_write on public.v_app_shifts;
create trigger v_app_shifts_write
  instead of insert or update or delete on public.v_app_shifts
  for each row execute function app.write_app_shifts();

-- ---------------- 希望休 ----------------
create or replace function app.write_app_shift_requests()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare v_member uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.shift_requests where app_id = old.id;
    return old;
  end if;
  v_member := app.member_id_of(new.staff_id);
  if v_member is null then
    raise exception '社員番号 % のメンバーが見つかりません', new.staff_id using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'UPDATE' then
    update public.shift_requests set
      wishes       = coalesce(new.wishes, '{}'::jsonb),
      reasons      = coalesce(new.reasons, '{}'::jsonb),
      note         = new.note,
      submitted_at = coalesce(new.submitted_at, submitted_at)
    where app_id = old.id;
    return new;
  end if;

  insert into public.shift_requests as r (app_id, member_id, target_month, wishes, reasons, note, submitted_at)
  values (new.id, v_member, new.month,
          coalesce(new.wishes, '{}'::jsonb), coalesce(new.reasons, '{}'::jsonb),
          new.note, coalesce(new.submitted_at, now()))
  on conflict (app_id) do update set
    wishes       = excluded.wishes,
    reasons      = excluded.reasons,
    note         = excluded.note,
    submitted_at = excluded.submitted_at;
  return new;
end;
$$;

drop trigger if exists v_app_shift_requests_write on public.v_app_shift_requests;
create trigger v_app_shift_requests_write
  instead of insert or update or delete on public.v_app_shift_requests
  for each row execute function app.write_app_shift_requests();

-- ---------------- 日報 ----------------
create or replace function app.write_app_daily_reports()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare v_member uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.daily_reports where app_id = old.id;
    return old;
  end if;
  v_member := app.member_id_of(new.staff_id);
  if v_member is null then
    raise exception '社員番号 % のメンバーが見つかりません', new.staff_id using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'UPDATE' then
    update public.daily_reports set
      store_id     = coalesce(app.store_id_of(new.store_id), store_id),
      revenue      = coalesce(new.revenue, 0),
      treatments   = coalesce(new.treatments, 0),
      new_patients = coalesce(new.new_patients, 0),
      proposals    = coalesce(new.proposals, 0),
      contracts    = coalesce(new.contracts, 0),
      goods        = coalesce(new.goods, 0),
      comment      = new.comment,
      ai_summary   = new.ai_summary,
      status       = coalesce(new.status, 'draft')
    where app_id = old.id;
    return new;
  end if;

  insert into public.daily_reports as d (
    app_id, member_id, store_id, report_date,
    revenue, treatments, new_patients, proposals, contracts, goods,
    comment, ai_summary, status
  ) values (
    new.id, v_member, app.store_id_of(new.store_id), new.date,
    coalesce(new.revenue, 0), coalesce(new.treatments, 0), coalesce(new.new_patients, 0),
    coalesce(new.proposals, 0), coalesce(new.contracts, 0), coalesce(new.goods, 0),
    new.comment, new.ai_summary, coalesce(new.status, 'draft')
  )
  on conflict (app_id) do update set
    store_id     = coalesce(excluded.store_id, d.store_id),
    revenue      = excluded.revenue,
    treatments   = excluded.treatments,
    new_patients = excluded.new_patients,
    proposals    = excluded.proposals,
    contracts    = excluded.contracts,
    goods        = excluded.goods,
    comment      = excluded.comment,
    ai_summary   = excluded.ai_summary,
    status       = excluded.status;
  return new;
end;
$$;

drop trigger if exists v_app_daily_reports_write on public.v_app_daily_reports;
create trigger v_app_daily_reports_write
  instead of insert or update or delete on public.v_app_daily_reports
  for each row execute function app.write_app_daily_reports();

grant insert, update, delete on
  public.v_app_attendance, public.v_app_shifts,
  public.v_app_shift_requests, public.v_app_daily_reports
  to authenticated;

-- ############################################################
-- # 0008_bootstrap_admin.sql
-- ############################################################

-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 08:最初の管理者を作る
--
-- 鶏と卵の問題を解く。
--   ・名簿を登録できるのは「統括マネージャー以上または本部人事」
--   ・でも最初はその人自身が名簿に居ない
--   → ログインはできるのに「名簿と紐付いていません」で止まる
--
-- そこで、SQL Editor から 1 回だけ実行して最初の管理者を作れるようにする。
--
--   select public.bootstrap_admin('admin@example.co.jp', '管理 太郎');
--
-- 手順:
--   1. Supabase → Authentication → Users → Add user で
--      メールアドレスとパスワードを決めてユーザーを作る
--      (パスワードはここで決める。SQL には書かない)
--   2. SQL Editor で上の 1 行を実行する
--   3. アプリにそのメールとパスワードでログインする
--
-- ------------------------------------------------------------
-- 安全のための決まりごと
--   ・ブラウザからは呼べない(anon / authenticated から実行権限を外す)
--     SQL Editor か service_role からしか実行できない
--   ・すでに別の管理者が居るときは断る。2人目以降は通常の
--     set_member_emails() + link_member_accounts() で紐付ける
--   ・同じ人に対して何度実行しても増えない(冪等)
-- ============================================================

create or replace function public.bootstrap_admin(
  p_email       text,
  p_name        text default '管理者',
  p_employee_no text default null,
  p_rank        text default 'ceo'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user_id  uuid;
  v_email    text := lower(btrim(p_email));
  v_key      text := app.name_key(p_name);
  v_emp      text := nullif(btrim(coalesce(p_employee_no, '')), '');
  v_member   public.members;
  v_other    text;
  v_action   text;
  v_store    text;
begin
  if v_email is null or v_email = '' then
    raise exception 'メールアドレスを指定してください' using errcode = 'invalid_parameter_value';
  end if;
  if p_rank not in ('ceo', 'exec', 'hr') then
    raise exception 'p_rank は ceo / exec / hr のいずれかにしてください(指定: %)', p_rank
      using errcode = 'invalid_parameter_value';
  end if;

  -- 1) Supabase Auth のユーザーを探す
  select u.id into v_user_id
    from auth.users u
   where lower(u.email) = v_email
   limit 1;

  if v_user_id is null then
    raise exception
      E'% のユーザーが Supabase Authentication にありません。\n'
      '先に Authentication → Users → Add user でメールとパスワードを登録してから、もう一度実行してください。', p_email
      using errcode = 'no_data_found';
  end if;

  -- 2) この人の名簿行を探す(紐付け済み → 同姓同名 → 同じメール の順)
  select * into v_member from public.members where auth_user_id = v_user_id;
  if v_member.id is null and v_key is not null then
    select * into v_member from public.members where name_key = v_key;
  end if;
  if v_member.id is null then
    select * into v_member from public.members where lower(email) = v_email;
  end if;

  -- 3) 初回だけ許す。すでに別の管理者が居るなら断る
  select m.full_name into v_other
    from public.members m
   where m.auth_user_id is not null
     and m.auth_user_id <> v_user_id
     and app.rank_level(m.rank) >= 6
   limit 1;

  if v_other is not null and (v_member.id is null or app.rank_level(v_member.rank) < 6) then
    raise exception
      E'管理者はすでに登録されています(%)。\n'
      '2人目以降は set_member_emails() と link_member_accounts()、'
      'または画面の「メンバー・組織図の一括登録」から紐付けてください。', v_other
      using errcode = 'unique_violation';
  end if;

  -- 4) 社員番号を決める(アプリはこれで人を識別する)
  if v_emp is null then v_emp := nullif(btrim(coalesce(v_member.employee_no, '')), ''); end if;
  if v_emp is null then
    v_emp := 'ADMIN001';
    while exists (select 1 from public.members where employee_no = v_emp) loop
      v_emp := 'ADMIN' || lpad((substring(v_emp from 6)::integer + 1)::text, 3, '0');
    end loop;
  end if;

  -- 5) 名簿に登録するか、既存の行を管理者に引き上げる
  if v_member.id is null then
    insert into public.members (
      name_key, employee_no, auth_user_id, full_name, email,
      rank, role_title, department, is_active
    ) values (
      coalesce(v_key, 'admin-' || left(v_user_id::text, 8)),
      v_emp, v_user_id, p_name, v_email,
      p_rank::public.member_rank,
      case p_rank when 'hr' then '本部人事' when 'exec' then '統括マネージャー' else '社長' end,
      'head_office'::public.department, true
    )
    returning * into v_member;
    v_action := 'created';
  else
    update public.members m
       set auth_user_id = v_user_id,
           email        = coalesce(nullif(btrim(m.email), ''), v_email),
           employee_no  = coalesce(nullif(btrim(m.employee_no), ''), v_emp),
           rank         = case when app.rank_level(m.rank) >= app.rank_level(p_rank::public.member_rank)
                               then m.rank else p_rank::public.member_rank end,
           is_active    = true,
           updated_at   = now()
     where m.id = v_member.id
    returning * into v_member;
    v_action := 'linked';
  end if;

  select s.name into v_store from public.stores s where s.id = v_member.primary_store_id;

  return jsonb_build_object(
    'action',       v_action,
    'member_id',    v_member.id,
    'employee_no',  v_member.employee_no,
    'full_name',    v_member.full_name,
    'rank',         v_member.rank,
    'rank_label',   app.rank_label(v_member.rank),
    'email',        v_member.email,
    'store',        coalesce(v_store, '(未所属)'),
    'can_edit_org', app.rank_level(v_member.rank) >= 6,
    'next',         'このメールアドレスとパスワードでアプリにログインできます'
  );
end;
$$;

comment on function public.bootstrap_admin is
  '最初の管理者を1人だけ作る。SQL Editor から実行する。2人目以降は link_member_accounts() を使う';

-- ブラウザからは絶対に呼べないようにする(呼べたら誰でも管理者になれてしまう)
revoke all on function public.bootstrap_admin(text, text, text, text) from public, anon, authenticated;
grant execute on function public.bootstrap_admin(text, text, text, text) to service_role;

-- ------------------------------------------------------------
-- 紐付けの状態をひと目で見る
--   「ログインできない」と言われたとき、まずこれを見る。
-- ------------------------------------------------------------
create or replace view public.v_login_status
  with (security_invoker = true) as
select
  u.email,
  m.full_name,
  m.employee_no,
  m.rank,
  app.rank_label(m.rank) as rank_label,
  s.name as store_name,
  case
    when m.id is null           then '名簿に未登録 — bootstrap_admin() か 名簿の取り込みが必要'
    when m.employee_no is null  then '社員番号が未設定 — fill_employee_numbers() が必要'
    when not m.is_active        then '退職扱い'
    else 'ログインできます'
  end as status
from auth.users u
left join public.members m on m.auth_user_id = u.id
left join public.stores  s on s.id = m.primary_store_id
order by u.email;

comment on view public.v_login_status is
  'Auth ユーザーと名簿の紐付き状況。ログインできない原因はここに出る';

grant select on public.v_login_status to authenticated;

-- ############################################################
-- # 0009_collaboration.sql
-- ############################################################

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
-- 0010 で列(auto_key)を足すので、2 回目以降の実行でも通るよう作り直す
drop view if exists public.v_app_chat_rooms;
create view public.v_app_chat_rooms
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

-- ############################################################
-- # 0010_members_and_rooms.sql
-- ############################################################

-- ============================================================
-- くまのみ 統合ポータル — 本番スキーマ 10:メンバーの手入力と、所属から自動で決まるチャットルーム
--
--   1. メンバーの手入力追加・編集
--        統括院長より上(マネージャー / 統括マネージャー / 社長)と本部人事が、
--        画面からメンバーを足したり、異動・退職・委員会の任命ができる。
--        アプリは uuid を持たないので、v_app_members ビュー越しに
--        社員番号・店舗コードのまま読み書きする(0007 と同じ作り)。
--
--   2. 所属(主所属・追加所属・委員会)からチャットルームを自動生成
--        ・全社ルーム         … 在籍者全員がずっと入っている
--        ・店舗ルーム         … その店舗が主所属 or 追加所属の人
--        ・委員会ルーム       … その委員会に任命された人
--        メンバーの所属が変わるとトリガでルームの参加者が更新される。
--        成増店 → 浦和店へ異動すると、成増店のルームから外れて浦和店のルームに入る。
--
--   3. 本人が自分のランク・所属・上司を書き換えられないようにするガード
--        (0004 の members_update_self はどの列でも直せてしまっていた)
-- ============================================================

-- ------------------------------------------------------------
-- 1. 委員会マスタ
-- ------------------------------------------------------------
create table if not exists public.committees (
  id          uuid primary key default gen_random_uuid(),
  code        text        not null unique,             -- 'cm-tech' などアプリ側の安定コード
  name        text        not null,
  icon        text,
  description text,
  sort_order  integer     not null default 0,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.committees is '委員会マスタ。メンバーは members.committee_codes で任命される';

drop trigger if exists committees_touch on public.committees;
create trigger committees_touch before update on public.committees
  for each row execute function app.touch_updated_at();

-- ------------------------------------------------------------
-- 2. メンバーの追加所属と委員会
-- ------------------------------------------------------------
alter table public.members add column if not exists store_codes     text[] not null default '{}';
alter table public.members add column if not exists committee_codes text[] not null default '{}';
comment on column public.members.store_codes     is '追加所属の店舗コード(主所属 primary_store_id とは別に兼務する店舗)';
comment on column public.members.committee_codes is '任命されている委員会のコード';

-- ------------------------------------------------------------
-- 3. 権限:メンバーを手入力で足せる人
--    統括院長(4)より上 = マネージャー(5)以上、または本部人事
-- ------------------------------------------------------------
create or replace function app.can_manage_members()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(app.my_rank_level() >= 5 or app.my_rank()::text = 'hr', false);
$$;

alter table public.committees enable row level security;
drop policy if exists committees_select on public.committees;
create policy committees_select on public.committees
  for select to authenticated using (true);
drop policy if exists committees_manage on public.committees;
create policy committees_manage on public.committees
  for all to authenticated
  using (app.can_manage_members()) with check (app.can_manage_members());
grant select, insert, update, delete on public.committees to authenticated;

-- メンバーの追加・編集(0004 の members_manage は統括MG以上+人事のまま残し、マネージャーにも開く)
drop policy if exists members_manage_by_manager on public.members;
create policy members_manage_by_manager on public.members
  for all to authenticated
  using (app.can_manage_members()) with check (app.can_manage_members());

-- 本人が直せるのはプロフィールだけ。ランク・所属・上司・社員番号などは元に戻す
create or replace function app.guard_member_self_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- SQL Editor / service_role / 管理者は対象外
  if auth.uid() is null or app.can_manage_members() then return new; end if;
  new.rank             := old.rank;
  new.role_title       := old.role_title;
  new.department       := old.department;
  new.primary_store_id := old.primary_store_id;
  new.reports_to_id    := old.reports_to_id;
  new.employee_no      := old.employee_no;
  new.name_key         := old.name_key;
  new.full_name        := old.full_name;
  new.store_codes      := old.store_codes;
  new.committee_codes  := old.committee_codes;
  new.is_active        := old.is_active;
  new.joined_on        := old.joined_on;
  new.left_on          := old.left_on;
  new.employment       := old.employment;
  new.sort_order       := old.sort_order;
  new.auth_user_id     := old.auth_user_id;
  new.email            := old.email;
  new.license          := old.license;
  new.gender           := old.gender;
  return new;
end;
$$;
drop trigger if exists members_guard_self on public.members;
create trigger members_guard_self before update on public.members
  for each row execute function app.guard_member_self_update();

-- ------------------------------------------------------------
-- 4. 管轄店舗に追加所属も数える(0006 の関数を差し替え)
-- ------------------------------------------------------------
create or replace function app.managed_store_ids(p_member_id uuid)
returns table (store_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rank  public.member_rank;
  v_level integer;
begin
  select m.rank into v_rank from public.members m where m.id = p_member_id;
  if v_rank is null then
    return;
  end if;

  if v_rank::text = 'hr' then
    return query select s.id from public.stores s where s.is_active;
    return;
  end if;

  v_level := app.rank_level(v_rank);

  return query
  with scope as (
    select p_member_id as id
    union
    select t.member_id from app.subtree_ids(p_member_id) t
  ),
  owned as (
    select a.store_id, m.rank
      from public.member_store_assignments a
      join scope on scope.id = a.member_id
      join public.members m on m.id = a.member_id
     where a.ended_on is null
    union all
    select m.primary_store_id, m.rank
      from public.members m
      join scope on scope.id = m.id
     where m.primary_store_id is not null
       and m.is_active
    union all
    -- 追加所属(画面から足した兼務)
    select s.id, m.rank
      from public.members m
      join scope on scope.id = m.id
      join public.stores s on s.code = any (m.store_codes)
     where m.is_active
  )
  select distinct o.store_id
    from owned o
   where o.store_id is not null
     and (v_level >= 3 or o.rank::text = 'manager');
end;
$$;

-- ------------------------------------------------------------
-- 5. 名簿ビューに追加所属・委員会・メールを足す(末尾への追加のみ)
-- ------------------------------------------------------------
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
  m.photo_url,
  m.store_codes,
  m.committee_codes,
  m.email
from public.members m
left join public.stores  s   on s.id = m.primary_store_id
left join public.members mgr on mgr.id = m.reports_to_id;

comment on view public.v_member_directory is
  'メンバー名簿。store_code / manager_employee_no はアプリ側の安定キー。store_codes は追加所属、committee_codes は委員会';
grant select on public.v_member_directory to authenticated;

-- ------------------------------------------------------------
-- 6. アプリ用の書き込みビュー v_app_members
--    社員番号・店舗コード・上司の社員番号のまま INSERT / UPDATE できる。
-- ------------------------------------------------------------
create or replace view public.v_app_members
  with (security_invoker = true) as
select
  m.employee_no,
  m.full_name,
  m.kana,
  m.role_title,
  m.rank::text        as rank,
  m.department::text  as department,
  s.code              as primary_store_code,
  mgr.employee_no     as manager_employee_no,
  m.color,
  m.joined_on,
  m.left_on,
  m.is_active,
  m.photo_url,
  m.email,
  m.phone,
  m.employment::text  as employment,
  m.sort_order,
  m.store_codes,
  m.committee_codes,
  m.license::text     as license,
  m.note
from public.members m
left join public.stores  s   on s.id = m.primary_store_id
left join public.members mgr on mgr.id = m.reports_to_id;

create or replace function app.write_app_members()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
declare
  v_store   uuid;
  v_mgr     uuid;
  v_key     text;
  v_rank    public.member_rank;
  v_dept    public.department;
  v_emp     public.employment_type;
  v_lic     public.license_type;
  v_no      text;
begin
  if tg_op = 'DELETE' then
    -- 消さずに退職扱いにする(履歴を守る)
    update public.members set is_active = false, left_on = coalesce(left_on, current_date)
     where employee_no = old.employee_no;
    return old;
  end if;

  v_no := nullif(btrim(coalesce(new.employee_no, '')), '');
  if v_no is null then
    raise exception '社員番号を指定してください' using errcode = 'not_null_violation';
  end if;
  if new.rank is not null and new.rank not in ('ceo','exec','area','chief','manager','mentor','staff','hr','clerk') then
    raise exception '不明なランクです: %', new.rank using errcode = 'invalid_parameter_value';
  end if;
  v_rank := new.rank::public.member_rank;
  v_dept := case when new.department in ('seitai','beauty','reception','management','head') then new.department::public.department else null end;
  v_emp  := case when new.employment is not null then new.employment::public.employment_type else null end;
  v_lic  := case when new.license is not null then new.license::public.license_type else null end;
  v_store := case when new.primary_store_code is null then null else app.store_id_of(new.primary_store_code) end;
  if new.primary_store_code is not null and v_store is null then
    raise exception '店舗コード % が見つかりません', new.primary_store_code using errcode = 'foreign_key_violation';
  end if;
  v_mgr := case when new.manager_employee_no is null then null else app.member_id_of(new.manager_employee_no) end;
  if new.manager_employee_no is not null and v_mgr is null then
    raise exception '上司の社員番号 % が見つかりません', new.manager_employee_no using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'UPDATE' then
    update public.members set
      employee_no      = v_no,
      full_name        = coalesce(new.full_name, full_name),
      kana             = coalesce(new.kana, kana),
      role_title       = coalesce(new.role_title, role_title),
      rank             = coalesce(v_rank, rank),
      department       = coalesce(v_dept, department),
      primary_store_id = case when new.primary_store_code is distinct from old.primary_store_code then v_store else primary_store_id end,
      reports_to_id    = case when new.manager_employee_no is distinct from old.manager_employee_no then v_mgr else reports_to_id end,
      color            = coalesce(new.color, color),
      joined_on        = coalesce(new.joined_on, joined_on),
      left_on          = case when new.left_on is distinct from old.left_on then new.left_on else left_on end,
      is_active        = coalesce(new.is_active, is_active),
      photo_url        = case when new.photo_url is distinct from old.photo_url then new.photo_url else photo_url end,
      email            = case when new.email is distinct from old.email then new.email else email end,
      phone            = case when new.phone is distinct from old.phone then new.phone else phone end,
      employment       = coalesce(v_emp, employment),
      sort_order       = coalesce(new.sort_order, sort_order),
      store_codes      = coalesce(new.store_codes, store_codes),
      committee_codes  = coalesce(new.committee_codes, committee_codes),
      license          = coalesce(v_lic, license),
      note             = case when new.note is distinct from old.note then new.note else note end
    where employee_no = old.employee_no;
    -- 名簿は全員が読めるのでビューの行は見えるが、書けるかは RLS が決める。
    -- 黙って何も起きないと同期が成功扱いになるので、はっきり断る
    if not found then
      raise exception '% の名簿を編集する権限がありません', old.employee_no using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- INSERT:取込キー(name_key)は氏名から作る。同姓同名がいれば社員番号を付けて区別する
  if new.full_name is null or btrim(new.full_name) = '' then
    raise exception '氏名を指定してください' using errcode = 'not_null_violation';
  end if;
  v_key := app.name_key(new.full_name);
  if exists (select 1 from public.members where name_key = v_key and employee_no is distinct from v_no) then
    v_key := v_key || '@' || v_no;
  end if;

  insert into public.members as m (name_key, employee_no, full_name, kana, role_title, rank, department,
    primary_store_id, reports_to_id, color, joined_on, is_active, photo_url, email, phone, employment,
    sort_order, store_codes, committee_codes, license, note)
  values (v_key, v_no, new.full_name, new.kana, coalesce(new.role_title, 'スタッフ'), coalesce(v_rank, 'staff'),
    coalesce(v_dept, 'seitai'), v_store, v_mgr, new.color, new.joined_on, coalesce(new.is_active, true),
    new.photo_url, new.email, new.phone, coalesce(v_emp, 'unknown'), coalesce(new.sort_order, 0),
    coalesce(new.store_codes, '{}'), coalesce(new.committee_codes, '{}'), coalesce(v_lic, 'unknown'), new.note)
  on conflict (employee_no) do update set
    full_name = excluded.full_name, kana = excluded.kana, role_title = excluded.role_title,
    rank = excluded.rank, department = excluded.department, primary_store_id = excluded.primary_store_id,
    reports_to_id = excluded.reports_to_id, color = excluded.color, joined_on = excluded.joined_on,
    is_active = excluded.is_active, email = excluded.email, phone = excluded.phone,
    employment = excluded.employment, store_codes = excluded.store_codes,
    committee_codes = excluded.committee_codes, license = excluded.license, note = excluded.note;
  return new;
end; $$;
drop trigger if exists v_app_members_write on public.v_app_members;
create trigger v_app_members_write instead of insert or update or delete on public.v_app_members
  for each row execute function app.write_app_members();
grant select, insert, update, delete on public.v_app_members to authenticated;

-- ------------------------------------------------------------
-- 7. 所属から自動で決まるチャットルーム
-- ------------------------------------------------------------
alter table public.chat_rooms add column if not exists auto_key text unique;
comment on column public.chat_rooms.auto_key is
  '自動ルームの識別子。all / store:<店舗コード> / committee:<委員会コード>。参加者は所属から自動で決まり、手では変えられない';

-- そのルームに居るべき人(社員番号)
create or replace function app.auto_room_member_nos(p_auto_key text)
returns text[]
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(array_agg(m.employee_no order by m.sort_order, m.employee_no), '{}')
    from public.members m
   where m.is_active
     and m.employee_no is not null
     and (
       p_auto_key = 'all'
       or (p_auto_key like 'store:%' and (
             m.primary_store_id = app.store_id_of(substr(p_auto_key, 7))
             or substr(p_auto_key, 7) = any (m.store_codes)))
       or (p_auto_key like 'committee:%' and substr(p_auto_key, 11) = any (m.committee_codes))
     );
$$;

-- 自動ルームを 1 つ用意して参加者を合わせる
create or replace function app.ensure_auto_room(
  p_auto_key text, p_app_id text, p_kind text, p_name text, p_icon text, p_desc text, p_store_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare v_members text[] := app.auto_room_member_nos(p_auto_key);
begin
  -- 「参加者は手で変えられない」ガード(guard_auto_room)を、この同期だけ通す
  perform set_config('app.room_sync', 'on', true);
  insert into public.chat_rooms (app_id, auto_key, kind, name, icon, description, store_id, member_nos, announce_only)
  values (p_app_id, p_auto_key, p_kind, p_name, p_icon, p_desc, p_store_id, v_members, false)
  on conflict (app_id) do update set
    auto_key = excluded.auto_key,
    name     = excluded.name,
    icon     = coalesce(public.chat_rooms.icon, excluded.icon),
    store_id = excluded.store_id;
  update public.chat_rooms
     set member_nos = v_members
   where auto_key = p_auto_key
     and member_nos is distinct from v_members;
  perform set_config('app.room_sync', '', true);
end;
$$;

-- 全社・全店舗・全委員会のルームをそろえ、参加者を所属に合わせる
create or replace function app.sync_auto_rooms()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare r record;
begin
  perform app.ensure_auto_room('all', 'cr-all', 'group', '全社アナウンス', '📢', '全社員向けの連絡(全員が参加)', null);
  for r in select s.id, s.code, s.name from public.stores s where s.is_active loop
    perform app.ensure_auto_room('store:' || r.code, 'cr-store-' || r.code, 'store',
      r.name, '🏠', r.name || 'のスタッフルーム(所属から自動で更新)', r.id);
  end loop;
  for r in select c.code, c.name, c.icon, c.description from public.committees c where c.is_active loop
    perform app.ensure_auto_room('committee:' || r.code, 'cr-committee-' || r.code, 'committee',
      r.name, coalesce(r.icon, '🗂'), coalesce(r.description, r.name || 'のルーム'), null);
  end loop;
end;
$$;

create or replace function app.trg_sync_auto_rooms()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  perform app.sync_auto_rooms();
  return null;
end;
$$;

drop trigger if exists members_sync_rooms on public.members;
create trigger members_sync_rooms
  after insert or update of primary_store_id, store_codes, committee_codes, is_active, employee_no, sort_order or delete
  on public.members
  for each statement execute function app.trg_sync_auto_rooms();

drop trigger if exists stores_sync_rooms on public.stores;
create trigger stores_sync_rooms
  after insert or update of is_active, name, code on public.stores
  for each statement execute function app.trg_sync_auto_rooms();

drop trigger if exists committees_sync_rooms on public.committees;
create trigger committees_sync_rooms
  after insert or update or delete on public.committees
  for each statement execute function app.trg_sync_auto_rooms();

-- 自動ルームの参加者・種類は手で変えない。消しもしない(所属が変わればまた作られる)
create or replace function app.guard_auto_room()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  -- ログイン中の人の操作だけを見る。SQL Editor と、所属からの自動同期(app.room_sync)は素通し
  v_user_edit boolean := auth.uid() is not null
                         and coalesce(current_setting('app.room_sync', true), '') <> 'on';
begin
  if tg_op = 'DELETE' then
    if old.auto_key is not null and v_user_edit then
      raise exception '所属から自動で作られるルームは削除できません' using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;
  if old.auto_key is not null and v_user_edit then
    new.member_nos := old.member_nos;
    new.auto_key   := old.auto_key;
    new.kind       := old.kind;
    new.store_id   := old.store_id;
  end if;
  return new;
end;
$$;
drop trigger if exists chat_rooms_guard_auto on public.chat_rooms;
create trigger chat_rooms_guard_auto before update or delete on public.chat_rooms
  for each row execute function app.guard_auto_room();

-- ビューに auto_key を出す(末尾に追加)
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
  app.employee_no_of(r.created_by) as created_by,
  r.auto_key
from public.chat_rooms r
left join public.stores st on st.id = r.store_id;
grant select, insert, update, delete on public.v_app_chat_rooms to authenticated;

-- 既存データに対して一度そろえる
select app.sync_auto_rooms();

-- ------------------------------------------------------------
-- 8. 自分の情報に追加所属・委員会を足す
-- ------------------------------------------------------------
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
    'store_codes',   to_jsonb(m.store_codes),
    'committee_codes', to_jsonb(m.committee_codes),
    'manager_id',    m.reports_to_id,
    'manager_employee_no', (select mgr.employee_no from public.members mgr where mgr.id = m.reports_to_id),
    'can_edit_org',  app.can_edit_org(),
    'can_manage_members', app.can_manage_members(),
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
