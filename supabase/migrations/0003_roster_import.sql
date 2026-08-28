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
