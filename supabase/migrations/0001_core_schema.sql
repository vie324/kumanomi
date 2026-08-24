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
