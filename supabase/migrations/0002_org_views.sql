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
