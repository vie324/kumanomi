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
