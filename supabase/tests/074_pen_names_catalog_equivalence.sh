#!/usr/bin/env bash
# PEN-NAMES-1: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema (8d4d652) plus
# supabase/migrations/20261019184512_pen_names.sql describe the same
# database -- across every catalog that can differ -- and that the
# migration's backfill does what its header says over POPULATED data.
#
# Modelled on 073_public_author_profiles_require_book_catalog_equivalence.sh;
# its generic machinery (schema resolution, the non-vacuous compare(),
# every catalog section) is carried over unchanged, with the effective-
# privilege sections widened to every table this migration touches.
#
# Why the risk is concrete here: schema.sql declares pen_name_id inline
# (NOT NULL, last column) on books, series and bundles, while the
# migration adds it with ALTER TABLE and sets NOT NULL after the
# backfill; search_books() moved in schema.sql (it now reads
# public_pen_names); the bundle RPCs, eleven new functions and their
# triggers, two new tables, a view and their ACLs must all come out
# byte-identical.
#
# Part 2 builds the BASE, inserts rows covering every backfill case
# (default from public_author_name, case variants, a pen name equal to
# the public name, a mixed series and bundle, follows), applies the
# migration and asserts the result, then exercises the old-code paths
# the rollout order relies on (insert without pen_name_id, write only
# books.pen_name, author_follows insert/delete, bundle RPC create).
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer, because
# schema.sql uses the MAINTAIN privilege; on 16 pass stripped copies via
# BASE_SCHEMA, SCHEMA, MIGRATION and STUB):
#
#   ./supabase/tests/074_pen_names_catalog_equivalence.sh
#
# Overrides: BASE_REF, BASE_SCHEMA, MIGRATION, STUB, SCHEMA_PATH, MARKER,
# and either SCHEMA (an explicit patched-schema file) or PATCHED_REF (an
# explicit patched-schema commit). Exits non-zero on any difference, any
# empty section, any non-zero psql exit, or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against: origin/staging at the time, the merge of PR #60.
BASE_REF="${BASE_REF:-8d4d652915ca5772a39956bd0441cb4d2c888fd4}"
MIGRATION="${MIGRATION:-supabase/migrations/20261019184512_pen_names.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-PEN-NAMES-1}"
# This migration may still be uncommitted, so the working-tree
# comparison is permitted here. Harnesses for merged migrations set 0.
ALLOW_WORKTREE=1

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

for f in "$MIGRATION" "$STUB"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: $f not found -- run this from a checkout that carries the patch" >&2
    exit 1
  fi
done

SUFFIX="$$"
DB_A="librum_pen_a_${SUFFIX}"
DB_B="librum_pen_b_${SUFFIX}"
DB_C="librum_pen_c_${SUFFIX}"
WORKDIR="$(mktemp -d)"

cleanup() {
  dropdb --if-exists "$DB_A" >/dev/null 2>&1 || true
  dropdb --if-exists "$DB_B" >/dev/null 2>&1 || true
  dropdb --if-exists "$DB_C" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# ============================================================
# Which "patched schema" is this harness comparing?
#
# Resolution order, highest precedence first:
#
#   SCHEMA       an explicit FILE to use as the patched schema.
#   PATCHED_REF  an explicit COMMIT whose supabase/schema.sql is it.
#   (automatic)  the single commit that first ADDED this migration --
#                the introduction boundary, which never moves again
#                once the migration is committed.
#   (worktree)   only when the migration is NOT in this history at all.
#
# A comparison against the wrong schema does not report "wrong schema";
# it reports whatever unrelated change happens to be in the tree, which
# is exactly how a harness teaches people to ignore it. So zero
# candidates where the worktree fallback is disallowed, or more than
# one candidate, is a hard failure naming the candidates.
# ============================================================
resolve_patched_schema() {
  if [ -n "${SCHEMA:-}" ]; then
    if [ ! -f "$SCHEMA" ]; then
      echo "FAIL: SCHEMA=$SCHEMA is not a readable file" >&2
      exit 1
    fi
    PATCHED_FILE="$SCHEMA"
    PATCHED_LABEL="explicit file $SCHEMA"
    return
  fi

  if [ -z "${PATCHED_REF:-}" ]; then
    local candidates count
    candidates="$(git log --full-history --diff-filter=A --format=%H -- "$MIGRATION" || true)"
    count="$(printf '%s' "$candidates" | grep -c . || true)"

    if [ "$count" -gt 1 ]; then
      echo "FAIL: $MIGRATION was added by more than one commit, so its introduction boundary is ambiguous:" >&2
      printf '%s\n' "$candidates" | sed 's/^/  /' >&2
      echo "  pass PATCHED_REF=<commit> (or SCHEMA=<file>) to say which schema is the patched one" >&2
      exit 1
    fi

    if [ "$count" -eq 1 ]; then
      PATCHED_REF="$candidates"
    else
      if [ "${ALLOW_WORKTREE:-0}" != "1" ]; then
        echo "FAIL: no commit in this history adds $MIGRATION, and this harness does not compare working trees." >&2
        echo "  It pins an already-introduced migration; pass PATCHED_REF=<commit> or SCHEMA=<file> if you mean something else." >&2
        exit 1
      fi
      if [ ! -f "$MIGRATION" ]; then
        echo "FAIL: $MIGRATION is neither committed nor present in the working tree" >&2
        exit 1
      fi
      if git cat-file -e "HEAD:$MIGRATION" 2>/dev/null; then
        echo "FAIL: $MIGRATION exists at HEAD but no commit adds it -- refusing to guess its introduction boundary" >&2
        exit 1
      fi
      PATCHED_FILE="$SCHEMA_PATH"
      PATCHED_LABEL="working tree $SCHEMA_PATH (migration not committed yet)"
      if ! git diff --quiet -- "$SCHEMA_PATH" "$MIGRATION" 2>/dev/null; then
        echo "  NOTE: the working tree differs from the index for $SCHEMA_PATH or $MIGRATION;" >&2
        echo "        this run compares the WORKING TREE, not what is staged." >&2
      fi
      return
    fi
  fi

  if ! git cat-file -e "${PATCHED_REF}:${SCHEMA_PATH}" 2>/dev/null; then
    echo "FAIL: ${PATCHED_REF}:${SCHEMA_PATH} is not readable" >&2
    exit 1
  fi
  git show "${PATCHED_REF}:${SCHEMA_PATH}" > "$WORKDIR/patched_schema.sql"
  PATCHED_FILE="$WORKDIR/patched_schema.sql"
  PATCHED_LABEL="${PATCHED_REF:0:9}:$SCHEMA_PATH (the commit that introduced this migration)"
}

# The base schema is read from git rather than from the working tree:
# the working tree's copy is the PATCHED one, and comparing a file
# against itself proves nothing.
# BASE_SCHEMA (an explicit file) overrides it, for a cluster that needs
# a locally adjusted copy; the marker checks below still apply to it.
if [ -n "${BASE_SCHEMA:-}" ]; then
  if [ ! -f "$BASE_SCHEMA" ]; then
    echo "FAIL: BASE_SCHEMA=$BASE_SCHEMA is not a readable file" >&2
    exit 1
  fi
  cp "$BASE_SCHEMA" "$WORKDIR/base_schema.sql"
  echo "  base schema: explicit file $BASE_SCHEMA"
else
  if ! git cat-file -e "${BASE_REF}:${SCHEMA_PATH}" 2>/dev/null; then
    echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} is not readable -- pass BASE_REF=<commit> for the base this migration targets" >&2
    exit 1
  fi
  git show "${BASE_REF}:${SCHEMA_PATH}" > "$WORKDIR/base_schema.sql"
fi

resolve_patched_schema
echo "  patched schema: $PATCHED_LABEL"

# Both halves of the boundary are asserted, not assumed.
if grep -q "$MARKER" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} already mentions $MARKER -- that is not the base this migration changes" >&2
  exit 1
fi
if ! grep -q "$MARKER" "$PATCHED_FILE"; then
  echo "FAIL: the resolved patched schema ($PATCHED_LABEL) does not mention $MARKER -- it does not carry this migration" >&2
  exit 1
fi

# The base must carry 20261019154308's view body and no pen_names table.
if ! grep -q "      where b.author_id = p.id" "$WORKDIR/base_schema.sql" \
   || grep -q "create table public.pen_names" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: the base schema is not the 8d4d652 base (view body / pen_names) -- wrong base" >&2
  exit 1
fi

build() {
  local db="$1"; shift
  dropdb --if-exists "$db" >/dev/null 2>&1 || true
  createdb "$db"
  local f
  for f in "$@"; do
    if ! psql -X -q -d "$db" -v ON_ERROR_STOP=1 -f "$f" > "$WORKDIR/build.out" 2> "$WORKDIR/build.err"; then
      echo "FAIL: building $db from $f errored" >&2
      tail -n 20 "$WORKDIR/build.err" >&2
      exit 1
    fi
  done
}

echo "  building A: $PATCHED_LABEL"
build "$DB_A" "$STUB" "$PATCHED_FILE"
echo "  building B: base schema + $MIGRATION"
build "$DB_B" "$STUB" "$WORKDIR/base_schema.sql" "$MIGRATION"

FAILURES=0
SECTIONS=0

# MAINTAIN exists from PostgreSQL 17; leave it out on an older server.
if [ "$(psql -X -q -t -A -d "$DB_A" -c 'show server_version_num')" -ge 170000 ]; then
  TABLE_PRIVS="'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'"
else
  TABLE_PRIVS="'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'"
  echo "  NOTE: server older than PostgreSQL 17 -- MAINTAIN left out of the effective table privileges"
fi

# Run one catalog query against both databases and require:
#   exit 0 on both, empty stderr on both, a non-zero row count on both,
#   and byte-identical stdout.
compare() {
  local label="$1" sql="$2"
  SECTIONS=$((SECTIONS + 1))
  local db out err rc rows_a rows_b
  for db in "$DB_A" "$DB_B"; do
    out="$WORKDIR/${label}.${db}.out"
    err="$WORKDIR/${label}.${db}.err"
    set +e
    # stdout and stderr go to SEPARATE files on purpose: merging them
    # would let two identical error messages compare equal and report a
    # pass.
    psql -X -q -t -A -F '|' -d "$db" -v ON_ERROR_STOP=1 -c "$sql" > "$out" 2> "$err"
    rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
      echo "FAIL [$label]: the query errored against $db" >&2
      tail -n 5 "$err" >&2
      FAILURES=$((FAILURES + 1))
      return 0
    fi
    if [ -s "$err" ]; then
      echo "FAIL [$label]: the query wrote to stderr against $db" >&2
      tail -n 5 "$err" >&2
      FAILURES=$((FAILURES + 1))
      return 0
    fi
  done

  rows_a="$(wc -l < "$WORKDIR/${label}.${DB_A}.out" | tr -d ' ')"
  rows_b="$(wc -l < "$WORKDIR/${label}.${DB_B}.out" | tr -d ' ')"
  if [ "$rows_a" -eq 0 ] || [ "$rows_b" -eq 0 ]; then
    echo "FAIL [$label]: empty result (A=$rows_a rows, B=$rows_b rows) -- this comparison would pass vacuously" >&2
    FAILURES=$((FAILURES + 1))
    return 0
  fi
  if ! cmp -s "$WORKDIR/${label}.${DB_A}.out" "$WORKDIR/${label}.${DB_B}.out"; then
    echo "FAIL [$label]: the two build paths disagree" >&2
    diff "$WORKDIR/${label}.${DB_A}.out" "$WORKDIR/${label}.${DB_B}.out" | head -n 40 >&2
    FAILURES=$((FAILURES + 1))
    return 0
  fi
  echo "  ok [$label]: $rows_a rows identical"
}

compare columns "
select c.relname, a.attnum, a.attname,
       pg_catalog.format_type(a.atttypid, a.atttypmod),
       a.attnotnull, a.attidentity, a.attgenerated,
       coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '')
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
 where n.nspname = 'public' and c.relkind = 'r'
   and a.attnum > 0 and not a.attisdropped
 order by c.relname, a.attnum"

compare constraints "
select c.relname, con.conname, con.contype::text,
       pg_catalog.pg_get_constraintdef(con.oid), con.convalidated
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class c on c.oid = con.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
 order by c.relname, con.conname"

compare indexes "
select schemaname, tablename, indexname, indexdef
  from pg_catalog.pg_indexes
 where schemaname = 'public'
 order by tablename, indexname"

compare views "
select c.relname, pg_catalog.pg_get_viewdef(c.oid, true), c.reloptions::text
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('v', 'm')
 order by c.relname"

compare triggers "
select c.relname, t.tgname, t.tgtype, t.tgenabled,
       pg_catalog.pg_get_triggerdef(t.oid)
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal
 order by c.relname, t.tgname"

compare function_definitions "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       pg_catalog.pg_get_functiondef(p.oid)
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)"

# Function sections: new trigger functions, the replaced search_books()
# and bundle RPCs -- definition, security and ACL must be identical.
compare function_signatures "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       p.pronargs, p.pronargdefaults, p.proargtypes::text,
       coalesce(array_to_string(p.proargnames, ','), ''),
       pg_catalog.pg_get_function_arguments(p.oid),
       pg_catalog.pg_get_function_result(p.oid),
       p.proretset, p.prokind::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)"

# Argument DEFAULTS as expressions, separately from the rendered
# signature above.
compare function_argument_defaults "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       p.pronargdefaults,
       coalesce(pg_catalog.pg_get_expr(p.proargdefaults, 0), '<none>')
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)"

# Function bodies, byte for byte.
compare function_bodies "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       p.prolang::regtype::text, pg_catalog.md5(p.prosrc), pg_catalog.length(p.prosrc), p.prosrc
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)"

compare function_security "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''), p.provolatile::text,
       p.proowner::regrole::text, p.proleakproof, p.proparallel::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)"

# Function ACLs.
compare function_acls "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       coalesce(p.proacl::text, '<default>')
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)"

compare table_acls "
select c.relname, c.relkind::text, c.relowner::regrole::text,
       coalesce(c.relacl::text, '<default>')
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'S')
 order by c.relname"

compare column_acls "
select c.relname, a.attname, coalesce(a.attacl::text, '<default>')
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
   and a.attnum > 0 and not a.attisdropped
 order by c.relname, a.attnum"

compare row_level_security "
select c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by c.relname"

compare policies "
select schemaname, tablename, policyname, permissive,
       coalesce(array_to_string(roles, ','), ''), cmd,
       coalesce(qual, ''), coalesce(with_check, '')
  from pg_catalog.pg_policies
 where schemaname = 'public'
 order by tablename, policyname"

compare types "
select c.relname, t.typname, t.typtype::text, t.typcategory::text
  from pg_catalog.pg_class c
  join pg_catalog.pg_type t on t.oid = c.reltype
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
 order by c.relname"

compare schema_acls "
select n.nspname, coalesce(n.nspacl::text, '<default>')
  from pg_catalog.pg_namespace n
 where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
 order by n.nspname"

compare extensions "
select e.extname, n.nspname, e.extversion
  from pg_catalog.pg_extension e
  join pg_catalog.pg_namespace n on n.oid = e.extnamespace
 order by e.extname"

# Object comments. This migration ships none, and "ships none" is a
# claim worth checking on both paths: a comment added to the migration
# and not to schema.sql is invisible to every other section here.
compare object_comments "
select c.relname, coalesce(a.attname, '<table>'), d.objsubid, d.description
  from pg_catalog.pg_description d
  join pg_catalog.pg_class c on c.oid = d.objoid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  left join pg_catalog.pg_attribute a
    on a.attrelid = d.objoid and a.attnum = d.objsubid and d.objsubid > 0
 where n.nspname = 'public'
 order by c.relname, d.objsubid"

# LEFT JOIN from pg_proc, not an inner join from pg_description: this
# repository comments no function at all, so an inner join yields zero
# rows on both paths -- two identical empty results, which is precisely
# the vacuous pass the non-vacuity gate exists to reject. Driving from
# pg_proc makes '<none>' an asserted fact rather than an absent one.
compare function_comments "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       coalesce(d.description, '<none>')
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  left join pg_catalog.pg_description d
    on d.objoid = p.oid and d.objsubid = 0 and d.classoid = 'pg_proc'::regclass
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)"

# Effective privileges, resolved per role, per column and per privilege
# type rather than read off the ACL strings, so role membership and
# PUBLIC inheritance are included. A missing role prints
# '<no such role>' instead of erroring (see 063 for why); both databases
# share one cluster, so that value is identical between them.
for tbl in profiles books series bundles bundle_books pen_names pen_name_follows public_pen_names public_author_profiles author_follows book_rights_declarations; do
compare "${tbl}_effective_column_privileges" "
select role_name, a.attname, priv,
       case
         when role_name = 'public'
           or exists (select 1 from pg_catalog.pg_roles r where r.rolname = role_name)
         then has_column_privilege(role_name, 'public.${tbl}', a.attname, priv)::text
         else '<no such role>'
       end
  from unnest(array['public','anon','authenticated','service_role','postgres']::text[]) as role_name
 cross join unnest(array['SELECT','INSERT','UPDATE','REFERENCES']::text[]) as priv
 cross join pg_catalog.pg_attribute a
 where a.attrelid = 'public.${tbl}'::regclass and a.attnum > 0 and not a.attisdropped
 order by role_name, a.attname, priv"

compare "${tbl}_effective_table_privileges" "
select role_name, priv,
       case
         when role_name = 'public'
           or exists (select 1 from pg_catalog.pg_roles r where r.rolname = role_name)
         then has_table_privilege(role_name, 'public.${tbl}', priv)::text
         else '<no such role>'
       end
  from unnest(array['public','anon','authenticated','service_role','postgres']::text[]) as role_name
 cross join unnest(array[${TABLE_PRIVS}]::text[]) as priv
 order by role_name, priv"
done


# ============================================================
# Beyond equivalence: both databases CARRY THE CHANGE.
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      (select array_agg(attname::text order by attnum) from pg_catalog.pg_attribute
        where attrelid = 'public.public_pen_names'::regclass and attnum > 0)
        = array['id','name','bio','avatar_path','links']
      and (select reloptions from pg_catalog.pg_class where oid = 'public.public_pen_names'::regclass) is null
      and has_table_privilege('anon', 'public.public_pen_names', 'SELECT')
      and not has_table_privilege('anon', 'public.public_pen_names', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      and not has_table_privilege('anon', 'public.pen_names', 'SELECT')
      and not has_table_privilege('anon', 'public.pen_name_follows', 'SELECT')
      and not has_column_privilege('authenticated', 'public.pen_names', 'author_id', 'UPDATE')
      and not has_column_privilege('authenticated', 'public.pen_names', 'avatar_path', 'UPDATE')
      and not has_column_privilege('authenticated', 'public.pen_names', 'is_default', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.pen_names', 'INSERT')
      and not has_table_privilege('authenticated', 'public.pen_names', 'DELETE')
      and (select attnotnull from pg_catalog.pg_attribute where attrelid = 'public.books'::regclass and attname = 'pen_name_id')
      and (select attnotnull from pg_catalog.pg_attribute where attrelid = 'public.series'::regclass and attname = 'pen_name_id')
      and (select attnotnull from pg_catalog.pg_attribute where attrelid = 'public.bundles'::regclass and attname = 'pen_name_id')
      and pg_catalog.pg_get_functiondef('public.search_books(text,text,integer,integer,integer)'::regprocedure) ~ 'public_pen_names'
      and pg_catalog.pg_get_functiondef('public.search_books(text,text,integer,integer,integer)'::regprocedure) !~ 'public_author_profiles'
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry PEN-NAMES-1" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: public_pen_names (id,name,bio,avatar_path,links), owner-only pen_names, NOT NULL pen_name_id x3, search_books reads public_pen_names"
  fi
done

# ============================================================
# Part 2: the migration over POPULATED base data (backfill), then the
# old-code paths of the rollout window.
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
-- A: author, public name 'Ana Writer'; books: none, 'ana writer' (= public
--    name, other case), 'Night Owl', 'night owl' (case variant, later),
--    'Rose'. Series S1 (Night Owl books only), S2 (mixed: Night Owl +
--    Rose), S3 (empty). Bundles U1 (Night Owl x2), U2 (mixed).
-- B: author, public name '  Ben Spaced ' (trimmed into the default).
-- R: reader, follows A; F: reader, follows A and B.
-- r4 (17a): A has a profile bio and a canonical photo (both copied onto
-- the default); B a blank bio and a non-canonical photo (neither
-- copied); R a bio and photo but no pen name (a reader).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0744f00-0000-4000-8000-00000000000a', 'p074-a@test', now(), '{"role":"author","display_name":"Ana Writer"}'),
  ('e0744f00-0000-4000-8000-00000000000b', 'p074-b@test', now(), '{"role":"author","display_name":"  Ben Spaced "}'),
  ('e0744f00-0000-4000-8000-0000000000aa', 'p074-r@test', now(), '{"role":"reader","display_name":"P074 Reader"}'),
  ('e0744f00-0000-4000-8000-0000000000ff', 'p074-f@test', now(), '{"role":"reader","display_name":"P074 Follower"}');

update public.profiles set bio = 'Ana bio', avatar_path = 'e0744f00-0000-4000-8000-00000000000a/avatar.png'
 where id = 'e0744f00-0000-4000-8000-00000000000a';
update public.profiles set bio = '   ', avatar_path = 'legacy/ben.png'
 where id = 'e0744f00-0000-4000-8000-00000000000b';
update public.profiles set bio = 'Reader bio', avatar_path = 'e0744f00-0000-4000-8000-0000000000aa/avatar.jpg'
 where id = 'e0744f00-0000-4000-8000-0000000000aa';

insert into public.series (id, author_id, title) values
  ('e0744f02-0000-4000-8000-000000000001', 'e0744f00-0000-4000-8000-00000000000a', 'S1 owl'),
  ('e0744f02-0000-4000-8000-000000000002', 'e0744f00-0000-4000-8000-00000000000a', 'S2 mixed'),
  ('e0744f02-0000-4000-8000-000000000003', 'e0744f00-0000-4000-8000-00000000000a', 'S3 empty');

insert into public.books (id, author_id, title, status, price_cents, price_all, published_at, pen_name, series_id, created_at) values
  ('e0744f01-0000-4000-8000-000000000001', 'e0744f00-0000-4000-8000-00000000000a', 'A plain',      'published', 0, 199, now(), null,          null, '2026-01-01'),
  ('e0744f01-0000-4000-8000-000000000002', 'e0744f00-0000-4000-8000-00000000000a', 'A same name',  'published', 0, 199, now(), 'ana writer',  null, '2026-01-02'),
  ('e0744f01-0000-4000-8000-000000000003', 'e0744f00-0000-4000-8000-00000000000a', 'A owl 1',      'published', 0, 199, now(), 'Night Owl',   'e0744f02-0000-4000-8000-000000000001', '2026-01-03'),
  ('e0744f01-0000-4000-8000-000000000004', 'e0744f00-0000-4000-8000-00000000000a', 'A owl 2',      'published', 0, 199, now(), 'night owl',   'e0744f02-0000-4000-8000-000000000001', '2026-01-04'),
  ('e0744f01-0000-4000-8000-000000000005', 'e0744f00-0000-4000-8000-00000000000a', 'A owl 3',      'published', 0, 199, now(), 'Night Owl',   'e0744f02-0000-4000-8000-000000000002', '2026-01-05'),
  ('e0744f01-0000-4000-8000-000000000006', 'e0744f00-0000-4000-8000-00000000000a', 'A rose',       'draft',     0, 199, null,  'Rose',        'e0744f02-0000-4000-8000-000000000002', '2026-01-06'),
  ('e0744f01-0000-4000-8000-000000000007', 'e0744f00-0000-4000-8000-00000000000b', 'B plain',      'published', 0, 199, now(), null,          null, '2026-01-07');

insert into public.bundles (id, author_id, title, status, price_all) values
  ('e0744f03-0000-4000-8000-000000000001', 'e0744f00-0000-4000-8000-00000000000a', 'U1 owls', 'published', 299),
  ('e0744f03-0000-4000-8000-000000000002', 'e0744f00-0000-4000-8000-00000000000a', 'U2 mixed', 'draft', 299);
insert into public.bundle_books (bundle_id, book_id) values
  ('e0744f03-0000-4000-8000-000000000001', 'e0744f01-0000-4000-8000-000000000003'),
  ('e0744f03-0000-4000-8000-000000000001', 'e0744f01-0000-4000-8000-000000000004'),
  ('e0744f03-0000-4000-8000-000000000002', 'e0744f01-0000-4000-8000-000000000001'),
  ('e0744f03-0000-4000-8000-000000000002', 'e0744f01-0000-4000-8000-000000000005');

insert into public.author_follows (follower_id, author_id) values
  ('e0744f00-0000-4000-8000-0000000000aa', 'e0744f00-0000-4000-8000-00000000000a'),
  ('e0744f00-0000-4000-8000-0000000000ff', 'e0744f00-0000-4000-8000-00000000000a'),
  ('e0744f00-0000-4000-8000-0000000000ff', 'e0744f00-0000-4000-8000-00000000000b');
FIXTURES

cat > "$WORKDIR/profiles_fp.sql" <<'FP'
select 'profiles:' || coalesce(string_agg(pg_catalog.to_jsonb(p)::text, ',' order by p.id), '<none>') from public.profiles p;
select 'books:' || coalesce(string_agg((pg_catalog.to_jsonb(b) - 'pen_name' - 'pen_name_id')::text, ',' order by b.id), '<none>') from public.books b;
select 'author_follows:' || coalesce(string_agg(pg_catalog.to_jsonb(f)::text, ',' order by f.id), '<none>') from public.author_follows f;
FP

cat > "$WORKDIR/backfill_assert.sql" <<'ASSERT'
create function pg_temp.check(ok boolean, msg text) returns text language sql as $$
  select case when ok then 'ok ' || msg else 'BAD ' || msg end $$;
create function pg_temp.pen(p_author text, p_name text) returns uuid language sql as $$
  select id from public.pen_names where author_id = p_author::uuid and lower(name) = lower(p_name) $$;
create function pg_temp.dflt(p_author text) returns uuid language sql as $$
  select id from public.pen_names where author_id = p_author::uuid and is_default $$;
select pg_temp.check((select string_agg(name || ':' || is_default, ',' order by is_default desc, name)
                        from public.pen_names where author_id = 'e0744f00-0000-4000-8000-00000000000a')
                     = 'Ana Writer:true,Night Owl:false,Rose:false', 'A_pen_names');
select pg_temp.check((select string_agg(name || ':' || is_default, ',') from public.pen_names
                       where author_id = 'e0744f00-0000-4000-8000-00000000000b') = 'Ben Spaced:true', 'B_default_trimmed');
select pg_temp.check((select string_agg(name || ':' || coalesce(bio, '<null>') || ':' || coalesce(avatar_path, '<null>'), ',' order by is_default desc, name)
                        from public.pen_names where author_id = 'e0744f00-0000-4000-8000-00000000000a')
                     = 'Ana Writer:Ana bio:e0744f00-0000-4000-8000-00000000000a/avatar.png,Night Owl:<null>:<null>,Rose:<null>:<null>',
                     'A_default_takes_profile_bio_photo');
select pg_temp.check((select bio is null and avatar_path is null from public.pen_names
                       where author_id = 'e0744f00-0000-4000-8000-00000000000b' and is_default),
                     'B_blank_bio_noncanonical_photo_not_copied');
select pg_temp.check((select count(*) from public.pen_names
                       where author_id in ('e0744f00-0000-4000-8000-0000000000aa','e0744f00-0000-4000-8000-0000000000ff')) = 0, 'readers_no_pen_name');
select pg_temp.check(
  (select string_agg(title || '=' || coalesce(pen_name, '<null>') || '/' ||
      case when pen_name_id = pg_temp.dflt(author_id::text) then 'default' else (select name from public.pen_names where id = pen_name_id) end,
      ',' order by title) from public.books where id::text like 'e0744f01-%')
  = 'A owl 1=Night Owl/Night Owl,A owl 2=Night Owl/Night Owl,A owl 3=Night Owl/Night Owl,A plain=<null>/default,A rose=Rose/Rose,A same name=<null>/default,B plain=<null>/default',
  'books_backfill');
select pg_temp.check((select pen_name_id from public.series where id = 'e0744f02-0000-4000-8000-000000000001') = pg_temp.pen('e0744f00-0000-4000-8000-00000000000a', 'Night Owl'), 'series_single_pen');
select pg_temp.check((select pen_name_id from public.series where id = 'e0744f02-0000-4000-8000-000000000002') = pg_temp.dflt('e0744f00-0000-4000-8000-00000000000a'), 'series_mixed_default');
select pg_temp.check((select pen_name_id from public.series where id = 'e0744f02-0000-4000-8000-000000000003') = pg_temp.dflt('e0744f00-0000-4000-8000-00000000000a'), 'series_empty_default');
select pg_temp.check((select pen_name_id from public.bundles where id = 'e0744f03-0000-4000-8000-000000000001') = pg_temp.pen('e0744f00-0000-4000-8000-00000000000a', 'Night Owl'), 'bundle_single_pen');
select pg_temp.check((select pen_name_id from public.bundles where id = 'e0744f03-0000-4000-8000-000000000002') = pg_temp.dflt('e0744f00-0000-4000-8000-00000000000a'), 'bundle_mixed_default');
select pg_temp.check((select count(*) from public.pen_name_follows) = 3
  and exists (select 1 from public.pen_name_follows where follower_id = 'e0744f00-0000-4000-8000-0000000000aa' and pen_name_id = pg_temp.dflt('e0744f00-0000-4000-8000-00000000000a'))
  and exists (select 1 from public.pen_name_follows where follower_id = 'e0744f00-0000-4000-8000-0000000000ff' and pen_name_id = pg_temp.dflt('e0744f00-0000-4000-8000-00000000000b')),
  'follows_to_default');
ASSERT

# Old code after the migration, all rolled back.
cat > "$WORKDIR/oldcode.sql" <<'OLDCODE'
begin;
create function pg_temp.check(ok boolean, msg text) returns text language sql as $$
  select case when ok then 'ok ' || msg else 'BAD ' || msg end $$;
-- old createBook: no pen_name_id, typed text for a NEW pen name
insert into public.books (id, author_id, title, pen_name) values
  ('e0744f01-0000-4000-8000-0000000000a1', 'e0744f00-0000-4000-8000-00000000000a', 'old new pen', 'Fresh Pen');
select pg_temp.check((select pn.name from public.books b join public.pen_names pn on pn.id = b.pen_name_id
                       where b.id = 'e0744f01-0000-4000-8000-0000000000a1') = 'Fresh Pen'
                     and (select pen_name from public.books where id = 'e0744f01-0000-4000-8000-0000000000a1') = 'Fresh Pen', 'old_insert_text_creates_pen');
-- old createBook: no pen name at all
insert into public.books (id, author_id, title) values
  ('e0744f01-0000-4000-8000-0000000000a2', 'e0744f00-0000-4000-8000-00000000000b', 'old plain');
select pg_temp.check((select pn.is_default from public.books b join public.pen_names pn on pn.id = b.pen_name_id
                       where b.id = 'e0744f01-0000-4000-8000-0000000000a2'), 'old_insert_default');
-- old edit: text only, book not in a series or bundle
update public.books set pen_name = 'rose' where id = 'e0744f01-0000-4000-8000-0000000000a2';
select pg_temp.check((select pen_name from public.books where id = 'e0744f01-0000-4000-8000-0000000000a2') = 'rose'
                     and (select count(*) from public.pen_names where author_id = 'e0744f00-0000-4000-8000-00000000000b') = 2, 'old_update_text_other_author_new_pen');
-- old createSeries / createBundle-less insert: default
insert into public.series (id, author_id, title) values ('e0744f02-0000-4000-8000-0000000000a1', 'e0744f00-0000-4000-8000-00000000000b', 'old series');
select pg_temp.check((select pn.is_default from public.series s join public.pen_names pn on pn.id = s.pen_name_id where s.id = 'e0744f02-0000-4000-8000-0000000000a1'), 'old_series_default');
-- old follow / unfollow
insert into public.author_follows (follower_id, author_id) values ('e0744f00-0000-4000-8000-0000000000aa', 'e0744f00-0000-4000-8000-00000000000b');
select pg_temp.check((select count(*) from public.pen_name_follows where follower_id = 'e0744f00-0000-4000-8000-0000000000aa') = 2, 'old_follow_mirrored');
delete from public.author_follows where follower_id = 'e0744f00-0000-4000-8000-0000000000aa' and author_id = 'e0744f00-0000-4000-8000-00000000000a';
select pg_temp.check((select count(*) from public.pen_name_follows where follower_id = 'e0744f00-0000-4000-8000-0000000000aa') = 1, 'old_unfollow_mirrored');
-- old createBundle through the unchanged RPC signature, as service_role
set local role service_role;
select pg_temp.check((select count(*) from public.create_bundle_with_membership(
  'e0744f03-0000-4000-8000-0000000000a1', 'e0744f00-0000-4000-8000-00000000000a', 'old bundle', '', 299,
  array['e0744f01-0000-4000-8000-000000000003','e0744f01-0000-4000-8000-000000000004']::uuid[])) = 2, 'old_bundle_rpc');
reset role;
select pg_temp.check((select pn.name from public.bundles bu join public.pen_names pn on pn.id = bu.pen_name_id where bu.id = 'e0744f03-0000-4000-8000-0000000000a1') = 'Night Owl', 'old_bundle_rpc_pen_from_books');
rollback;
OLDCODE

run_file() {
  local db="$1" file="$2" out="$3" err="$4" rc
  set +e
  psql -X -q -t -A -F '|' -d "$db" -v ON_ERROR_STOP=1 -f "$file" > "$out" 2> "$err"
  rc=$?
  set -e
  return $rc
}

echo "  building C: base schema + rows, then the migration"
build "$DB_C" "$STUB" "$WORKDIR/base_schema.sql" "$WORKDIR/rows.sql"

SECTIONS=$((SECTIONS + 1))
STEP_RC=0
run_file "$DB_C" "$WORKDIR/profiles_fp.sql" "$WORKDIR/before.out" "$WORKDIR/before.err" || STEP_RC=1
# NOTICEs from the migration (the mixed series/bundle list) go to stderr
# by design; they are kept and printed, not treated as an error.
set +e
psql -X -q -d "$DB_C" -v ON_ERROR_STOP=1 -f "$MIGRATION" > "$WORKDIR/migrate.out" 2> "$WORKDIR/migrate.notice"
[ $? -eq 0 ] || STEP_RC=1
set -e
run_file "$DB_C" "$WORKDIR/profiles_fp.sql" "$WORKDIR/after.out" "$WORKDIR/after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/backfill_assert.sql" "$WORKDIR/backfill.out" "$WORKDIR/backfill.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/oldcode.sql" "$WORKDIR/oldcode.out" "$WORKDIR/oldcode.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/profiles_fp.sql" "$WORKDIR/after_again.out" "$WORKDIR/after_again.err" || STEP_RC=1

ERRS=0
for e in before after backfill oldcode after_again; do
  [ -s "$WORKDIR/$e.err" ] && ERRS=1
done
if grep -v '^NOTICE:\|^psql:.*NOTICE:' "$WORKDIR/migrate.notice" | grep -q .; then ERRS=1; fi
if [ "$STEP_RC" -ne 0 ] || [ "$ERRS" -ne 0 ]; then
  echo "FAIL [populated_migration]: a step errored or wrote to stderr" >&2
  tail -n 5 "$WORKDIR"/*.err "$WORKDIR/migrate.notice" >&2 || true
  FAILURES=$((FAILURES + 1))
elif [ ! -s "$WORKDIR/before.out" ] || grep -q '<none>' "$WORKDIR/before.out"; then
  echo "FAIL [populated_migration]: the fixture inserted nothing" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/after.out" || ! cmp -s "$WORKDIR/after.out" "$WORKDIR/after_again.out"; then
  echo "FAIL [populated_migration]: profiles, author_follows or a books column other than pen_name/pen_name_id changed (or a probe left a change)" >&2
  diff "$WORKDIR/before.out" "$WORKDIR/after.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated_migration]: profiles, author_follows and every books column but pen_name/pen_name_id are byte-identical; rolled-back probes left nothing"
  echo "    migration notices: $(grep -o 'pen names backfill:.*' "$WORKDIR/migrate.notice" | tr '\n' ' ')"
fi

for f in backfill oldcode; do
  SECTIONS=$((SECTIONS + 1))
  if [ ! -s "$WORKDIR/$f.out" ] || grep -q '^BAD ' "$WORKDIR/$f.out"; then
    echo "FAIL [$f]:" >&2
    cat "$WORKDIR/$f.out" >&2
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [$f]: $(grep -c '^ok ' "$WORKDIR/$f.out") checks -- $(grep '^ok ' "$WORKDIR/$f.out" | sed 's/^ok //' | tr '\n' ' ')"
  fi
done

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 074_pen_names_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 074_pen_names_catalog_equivalence.sh -- $SECTIONS sections: catalog identical between $PATCHED_LABEL and the base + migration, none empty; backfill and rollout-window checks pass"
