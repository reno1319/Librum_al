#!/usr/bin/env bash
# BD15 P1: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema (367b956b) plus
# supabase/migrations/20261103200000_bd15_upload_flow_foundation.sql
# describe the same database -- across every catalog that can differ --
# that the migration over POPULATED data writes only its backfill
# (categories, edition_number), that the new rules hold, and that the
# rollback (090_bd15_upload_flow_foundation.rollback.sql), run twice,
# leaves EXACTLY the documented residue: every catalog section of the
# rolled-back database equals a fresh build of the base schema plus
# 090_bd15_upload_flow_foundation_residue.sql.
#
# Modelled on 089_bd14_pen_name_public_gate_catalog_equivalence.sh; its
# generic machinery (schema resolution, the non-vacuous compare(), every
# catalog section) is carried over unchanged, with the effective-
# privilege sections pointed at public_books, public_bundles, books,
# pd_works, book_ai_disclosures.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer):
#
#   ./supabase/tests/090_bd15_upload_flow_foundation_catalog_equivalence.sh
#
# Overrides: BASE_REF, BASE_SCHEMA, MIGRATION, ROLLBACK, RESIDUE, STUB,
# SCHEMA_PATH, MARKER, and either SCHEMA (an explicit patched-schema
# file) or PATCHED_REF (an explicit patched-schema commit). Exits
# non-zero on any difference, any empty section, any non-zero psql exit,
# or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against (staging after PR #151, BD14).
BASE_REF="${BASE_REF:-367b956b1c15e7617b8739fcae90764537b748de}"
MIGRATION="${MIGRATION:-supabase/migrations/20261103200000_bd15_upload_flow_foundation.sql}"
ROLLBACK="${ROLLBACK:-supabase/tests/090_bd15_upload_flow_foundation.rollback.sql}"
RESIDUE="${RESIDUE:-supabase/tests/090_bd15_upload_flow_foundation_residue.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-BD15 P1}"
# This migration may still be uncommitted, so the working-tree
# comparison is permitted here. Harnesses for merged migrations set 0.
ALLOW_WORKTREE=1

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

for f in "$MIGRATION" "$ROLLBACK" "$RESIDUE" "$STUB"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: $f not found -- run this from a checkout that carries the patch" >&2
    exit 1
  fi
done

SUFFIX="$$"
DB_A="librum_sqbd15_a_${SUFFIX}"
DB_B="librum_sqbd15_b_${SUFFIX}"
DB_C="librum_sqbd15_c_${SUFFIX}"
DB_D="librum_sqbd15_d_${SUFFIX}"
WORKDIR="$(mktemp -d)"

cleanup() {
  # By name, not through DB_A/DB_B: the rollback comparison reuses those.
  dropdb --if-exists "librum_sqbd15_a_${SUFFIX}" >/dev/null 2>&1 || true
  dropdb --if-exists "librum_sqbd15_b_${SUFFIX}" >/dev/null 2>&1 || true
  dropdb --if-exists "$DB_C" >/dev/null 2>&1 || true
  dropdb --if-exists "$DB_D" >/dev/null 2>&1 || true
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

# The base must carry BD14 (book_makes_pen_name_public) and no pd_works
# anywhere.
if ! grep -q "book_makes_pen_name_public" "$WORKDIR/base_schema.sql" \
   || grep -q "pd_works" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: the base schema is not the 367b956b base (BD14 book_makes_pen_name_public, no pd_works) -- wrong base" >&2
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


# Every catalog section, as one function: run once for A vs B (patched
# schema vs base + migration) and again, after the rollback, for C vs D
# (rolled-back populated database vs a fresh base build).
catalog_sections() {
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

# Function sections: every public function, the two new ones included
# -- definition, security and ACL must be identical.
compare function_signatures "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       -- BD14: argument types by NAME (088 printed raw OIDs, which
       -- differ between two builds for a table's row type, as books).
       p.pronargs, p.pronargdefaults, p.proargtypes::oid[]::regtype[]::text,
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

# This migration adds no storage policy; the storage schema's policies
# are still compared, so an accidental change would show.
compare storage_policies "
select schemaname, tablename, policyname, permissive,
       coalesce(array_to_string(roles, ','), ''), cmd,
       coalesce(qual, ''), coalesce(with_check, '')
  from pg_catalog.pg_policies
 where schemaname = 'storage'
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
# public_books and public_bundles (the two views BD15 P1 replaces),
# books (new columns) and the two new tables.
for tbl in public_books public_bundles books pd_works book_ai_disclosures; do
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
}

catalog_sections

# ============================================================
# ============================================================
# Beyond equivalence: both databases CARRY THE CHANGE as intended.
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      (select reloptions from pg_catalog.pg_class where oid = 'public.public_books'::regclass) = array['security_barrier=true']
      and (select reloptions from pg_catalog.pg_class where oid = 'public.public_bundles'::regclass) = array['security_barrier=true']
      and (select string_agg(attname, ',' order by attnum) from pg_catalog.pg_attribute
            where attrelid = 'public.public_books'::regclass and attnum > 0)
          = 'id,title,subtitle,description,preview_text,keywords,isbn,language,publisher,edition,original_publication_date,genre,series_id,series_position,price_cents,cover_path,status,published_at,created_at,updated_at,price_all,librum_choice_at,pen_name_id,original_author,categories,is_adult,reading_age_min,edition_number,pd_work_id,pd_editor_credit'
      and (select string_agg(attname, ',' order by attnum) from pg_catalog.pg_attribute
            where attrelid = 'public.public_bundles'::regclass and attnum > 0)
          = 'id,title,description,price_cents,status,created_at,updated_at,price_all,pen_name_id'
      and pg_catalog.pg_get_viewdef('public.public_books'::regclass) like '%book_is_publicly_listed%'
      and pg_catalog.pg_get_viewdef('public.public_books'::regclass) not like '%ai_used%'
      and pg_catalog.pg_get_viewdef('public.public_bundles'::regclass) like '%book_makes_pen_name_public%'
      and (select provolatile = 'i' and not prosecdef and proconfig is null
             from pg_catalog.pg_proc where oid = 'public.book_is_publicly_listed(public.books)'::regprocedure)
      and (select provolatile = 'i' and not prosecdef and proconfig is null
             from pg_catalog.pg_proc where oid = 'public.book_makes_pen_name_public(public.books)'::regprocedure)
      and has_function_privilege('anon', 'public.book_is_publicly_listed(public.books)', 'EXECUTE')
      and not has_table_privilege('anon', 'public.pd_works', 'SELECT')
      and not has_table_privilege('authenticated', 'public.pd_works', 'SELECT')
      and not has_table_privilege('anon', 'public.book_ai_disclosures', 'SELECT')
      and not has_table_privilege('authenticated', 'public.book_ai_disclosures', 'SELECT')
      and has_table_privilege('service_role', 'public.book_ai_disclosures', 'SELECT')
      and not exists (select 1 from pg_catalog.pg_attribute
                       where attrelid = 'public.books'::regclass and attname = 'ai_used')
      and has_table_privilege('anon', 'public.public_books', 'SELECT')
      and not has_table_privilege('anon', 'public.books', 'SELECT')
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry BD15 P1 as intended" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: public_books and public_bundles security_barrier with the intended columns (no ai_used); both helpers immutable, invoker, no SET; pd_works and book_ai_disclosures closed to anon and authenticated"
  fi
done

# ============================================================
# Part 2: the migration over POPULATED base data, then the rollback.
#   A  author: one PUBLISHED book (genre Poezi, edition " 2 ") and one
#      DRAFT (no genre, edition "Botimi i dytë"), and a PUBLISHED bundle
#   B  author: one DRAFT book in genre "Për fëmijë", edition "0"
#   R  reader, owns nothing
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0909000-0000-4000-8000-00000000000a', 'q090-a@test', now(), '{"role":"author","display_name":"Q090 Ana"}'),
  ('e0909000-0000-4000-8000-00000000000b', 'q090-b@test', now(), '{"role":"author","display_name":"Q090 Ben"}'),
  ('e0909000-0000-4000-8000-0000000000aa', 'q090-r@test', now(), '{"role":"reader","display_name":"Q090 Reader"}');
insert into public.books (id, author_id, title, status, price_all, published_at, genre, edition, language) values
  ('e0909001-0000-4000-8000-00000000000a', 'e0909000-0000-4000-8000-00000000000a', 'Q090 A live', 'published', 199, now(), 'Poezi', ' 2 ', 'sq'),
  ('e0909001-0000-4000-8000-0000000000a2', 'e0909000-0000-4000-8000-00000000000a', 'Q090 A draft', 'draft', 199, null, null, 'Botimi i dytë', 'en'),
  ('e0909001-0000-4000-8000-00000000000b', 'e0909000-0000-4000-8000-00000000000b', 'Q090 B draft', 'draft', null, null, 'Për fëmijë', '0', null);
insert into public.bundles (id, author_id, title, status, price_all, pen_name_id)
  select 'e0909002-0000-4000-8000-00000000000a', 'e0909000-0000-4000-8000-00000000000a', 'Q090 bundle', 'published', 299, b.pen_name_id
    from public.books b where b.id = 'e0909001-0000-4000-8000-00000000000a';
FIXTURES

# Every stored base-column value, as an ordered text dump. The new
# columns are left out here and checked on their own below.
cat > "$WORKDIR/fingerprint.sql" <<'FINGERPRINT'
select 'pen_names', coalesce(string_agg(to_jsonb(t)::text, ';' order by t.id), '<none>') from public.pen_names t;
select 'books', coalesce(string_agg((to_jsonb(t) - array['categories','is_adult','reading_age_min','edition_number','pd_work_id','pd_editor_credit'])::text, ';' order by t.id), '<none>') from public.books t;
select 'bundles', coalesce(string_agg(to_jsonb(t)::text, ';' order by t.id), '<none>') from public.bundles t;
FINGERPRINT

# What anon, author A and reader R see, base columns only.
cat > "$WORKDIR/visible.sql" <<'VISIBLE'
set role anon;
select 'anon', coalesce(string_agg(title || ':' || (pen_name_id is not null)::text, ',' order by title), '-') from public.public_books where title like 'Q090%';
select 'anon', coalesce(string_agg(title || ':' || (pen_name_id is not null)::text, ',' order by title), '-') from public.public_bundles where title like 'Q090%';
reset role;
begin;
select set_config('request.jwt.claim.sub', 'e0909000-0000-4000-8000-00000000000a', true) is not null;
set local role authenticated;
select 'A', coalesce(string_agg(title || ':' || (pen_name_id is not null)::text, ',' order by title), '-') from public.public_books where title like 'Q090%';
select 'A', coalesce(string_agg(title || ':' || (pen_name_id is not null)::text, ',' order by title), '-') from public.public_bundles where title like 'Q090%';
commit;
begin;
select set_config('request.jwt.claim.sub', 'e0909000-0000-4000-8000-0000000000aa', true) is not null;
set local role authenticated;
select 'R', coalesce(string_agg(title || ':' || (pen_name_id is not null)::text, ',' order by title), '-') from public.public_books where title like 'Q090%';
select 'R', coalesce(string_agg(title || ':' || (pen_name_id is not null)::text, ',' order by title), '-') from public.public_bundles where title like 'Q090%';
commit;
VISIBLE

# The backfill: categories from genre, edition_number from a plain
# whole number 1..999 only.
cat > "$WORKDIR/backfill.sql" <<'BACKFILL'
select title, coalesce(categories::text, '<null>'), coalesce(edition_number::text, '<null>'), is_adult, pd_editor_credit
  from public.books where title like 'Q090%' order by title;
BACKFILL

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
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/before.out" "$WORKDIR/before.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/visible.sql" "$WORKDIR/vis_before.out" "$WORKDIR/vis_before.err" || STEP_RC=1
run_file "$DB_C" "$MIGRATION" "$WORKDIR/migrate.out" "$WORKDIR/migrate.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after.out" "$WORKDIR/after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/visible.sql" "$WORKDIR/vis_after.out" "$WORKDIR/vis_after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/backfill.sql" "$WORKDIR/backfill.out" "$WORKDIR/backfill.err" || STEP_RC=1
ERRS=0
for e in before vis_before migrate after vis_after backfill; do
  [ -s "$WORKDIR/$e.err" ] && ERRS=1
done
VIS_EXPECTED="t
t
anon|Q090 A live:true
anon|Q090 bundle:true
A|Q090 A draft:true,Q090 A live:true
A|Q090 bundle:true
R|Q090 A live:true
R|Q090 bundle:true"
BACKFILL_EXPECTED="Q090 A draft|<null>|<null>|f|f
Q090 A live|{Poezi}|2|f|f
Q090 B draft|{\"Për fëmijë\"}|<null>|f|f"
normalize() { grep -v '^$' "$1" | sort; }
if [ "$STEP_RC" -ne 0 ] || [ "$ERRS" -ne 0 ]; then
  echo "FAIL [populated]: a step errored" >&2
  cat "$WORKDIR"/*.err >&2 || true
  FAILURES=$((FAILURES + 1))
elif [ ! -s "$WORKDIR/before.out" ] || grep -q '<none>' "$WORKDIR/before.out"; then
  echo "FAIL [populated]: the fixture rows are missing -- the check would be vacuous" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/after.out"; then
  echo "FAIL [populated]: the migration changed a stored base-column value" >&2
  diff "$WORKDIR/before.out" "$WORKDIR/after.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
elif [ "$(normalize "$WORKDIR/vis_before.out")" != "$(printf '%s\n' "$VIS_EXPECTED" | sort)" ] \
  || ! cmp -s "$WORKDIR/vis_before.out" "$WORKDIR/vis_after.out"; then
  echo "FAIL [populated]: visibility is not as intended" >&2
  echo "--- before:" >&2; cat "$WORKDIR/vis_before.out" >&2
  echo "--- after:" >&2; cat "$WORKDIR/vis_after.out" >&2
  FAILURES=$((FAILURES + 1))
elif [ "$(grep -v '^$' "$WORKDIR/backfill.out")" != "$BACKFILL_EXPECTED" ]; then
  echo "FAIL [populated]: the backfill is not as intended" >&2
  cat "$WORKDIR/backfill.out" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated]: no stored base-column value changed; categories and edition_number backfilled as intended; anon, author and reader see the same books and bundles (with pen names) before and after"
fi

# The rollback, twice: stored values unchanged (the new columns too),
# visibility the same, and every catalog section identical to a FRESH
# build of the base schema plus the documented residue (E).
run_file "$DB_C" "$WORKDIR/backfill.sql" "$WORKDIR/bf_pre_rb.out" "$WORKDIR/bf_pre_rb.err" || true
SECTIONS=$((SECTIONS + 1))
STEP_RC=0
run_file "$DB_C" "$ROLLBACK" "$WORKDIR/rb1.out" "$WORKDIR/rb1.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/visible.sql" "$WORKDIR/vis_rb1.out" "$WORKDIR/vis_rb1.err" || STEP_RC=1
run_file "$DB_C" "$ROLLBACK" "$WORKDIR/rb2.out" "$WORKDIR/rb2.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/visible.sql" "$WORKDIR/vis_rb2.out" "$WORKDIR/vis_rb2.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/rolled_back.out" "$WORKDIR/rolled_back.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/backfill.sql" "$WORKDIR/bf_rb.out" "$WORKDIR/bf_rb.err" || STEP_RC=1
ERRS=0
# rb*.err may carry the NOTICEs of DROP ... IF EXISTS on the second run.
for e in vis_rb1 vis_rb2 rolled_back bf_rb bf_pre_rb; do
  [ -s "$WORKDIR/$e.err" ] && ERRS=1
done
if grep -v '^psql:.*NOTICE:' "$WORKDIR/rb1.err" "$WORKDIR/rb2.err" | grep -q .; then
  ERRS=1
fi
if [ "$STEP_RC" -ne 0 ] || [ "$ERRS" -ne 0 ] \
   || ! cmp -s "$WORKDIR/vis_before.out" "$WORKDIR/vis_rb1.out" \
   || ! cmp -s "$WORKDIR/vis_before.out" "$WORKDIR/vis_rb2.out" \
   || ! cmp -s "$WORKDIR/before.out" "$WORKDIR/rolled_back.out" \
   || ! cmp -s "$WORKDIR/bf_pre_rb.out" "$WORKDIR/bf_rb.out"; then
  echo "FAIL [rollback]:" >&2
  cat "$WORKDIR"/rb1.err "$WORKDIR"/rb2.err "$WORKDIR/vis_rb1.out" >&2 || true
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [rollback]: twice without error; visibility the same; stored values (new columns included) unchanged"
fi

echo "  building D: base schema + the documented residue, to compare the rolled-back catalog against"
build "$DB_D" "$STUB" "$WORKDIR/base_schema.sql" "$RESIDUE"
echo "  comparing every catalog section: C (rolled back) vs D (base + residue)"
DB_A="$DB_C"
DB_B="$DB_D"
catalog_sections

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 090_bd15_upload_flow_foundation_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 090_bd15_upload_flow_foundation_catalog_equivalence.sh -- $SECTIONS sections: catalog identical between $PATCHED_LABEL and the base + migration, none empty; populated-data, backfill and visibility checks pass; after the rollback the catalog is identical to base + the documented residue"
