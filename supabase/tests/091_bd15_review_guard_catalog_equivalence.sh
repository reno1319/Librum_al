#!/usr/bin/env bash
# BD15 P5a: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema (a1024c00) plus
# supabase/migrations/20261104120000_bd15_review_guard.sql describe the
# same database -- across every catalog that can differ -- that the
# migration over POPULATED data (a draft waiting for review among them)
# changes no stored value, that both databases carry the guard as
# intended, and that the rollback (091_bd15_review_guard.rollback.sql),
# run twice, leaves every catalog section identical to a fresh build of
# the base schema (no residue: the migration adds no column or table).
#
# Modelled on 090_bd15_upload_flow_foundation_catalog_equivalence.sh; its
# generic machinery (schema resolution, the non-vacuous compare(), every
# catalog section) is carried over unchanged, with the effective-
# privilege sections pointed at books, book_contributors,
# book_ai_disclosures, book_rights_declarations and book_reviews.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer):
#
#   ./supabase/tests/091_bd15_review_guard_catalog_equivalence.sh
#
# Overrides: BASE_REF, BASE_SCHEMA, MIGRATION, ROLLBACK, STUB,
# SCHEMA_PATH, MARKER, and either SCHEMA (an explicit patched-schema
# file) or PATCHED_REF (an explicit patched-schema commit). Exits
# non-zero on any difference, any empty section, any non-zero psql exit,
# or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against (staging after PR #156, BD15 P4).
BASE_REF="${BASE_REF:-a1024c004dd1729e5b8b35ccd6dbfc6c06ec8c4d}"
MIGRATION="${MIGRATION:-supabase/migrations/20261104120000_bd15_review_guard.sql}"
ROLLBACK="${ROLLBACK:-supabase/tests/091_bd15_review_guard.rollback.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-BD15 P5a}"
# This migration may still be uncommitted, so the working-tree
# comparison is permitted here. Harnesses for merged migrations set 0.
ALLOW_WORKTREE=1

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

for f in "$MIGRATION" "$ROLLBACK" "$STUB"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: $f not found -- run this from a checkout that carries the patch" >&2
    exit 1
  fi
done

SUFFIX="$$"
DB_A="librum_sq091_a_${SUFFIX}"
DB_B="librum_sq091_b_${SUFFIX}"
DB_C="librum_sq091_c_${SUFFIX}"
DB_D="librum_sq091_d_${SUFFIX}"
WORKDIR="$(mktemp -d)"

cleanup() {
  # By name, not through DB_A/DB_B: the rollback comparison reuses those.
  dropdb --if-exists "librum_sq091_a_${SUFFIX}" >/dev/null 2>&1 || true
  dropdb --if-exists "librum_sq091_b_${SUFFIX}" >/dev/null 2>&1 || true
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

# The base must carry BD15 P1 (book_ai_disclosures) and none of P5a.
if ! grep -q "create table public.book_ai_disclosures" "$WORKDIR/base_schema.sql" \
   || grep -q "book_is_locked_for_review" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: the base schema is not the a1024c00 base (BD15 P1 book_ai_disclosures, no review lock) -- wrong base" >&2
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
# The tables the new triggers sit on, and book_reviews.
for tbl in books book_contributors book_ai_disclosures book_rights_declarations book_reviews; do
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
# Beyond equivalence: both databases CARRY THE CHANGE as intended.
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      pg_catalog.pg_get_functiondef('public.request_book_review(uuid)'::regprocedure) like '%LB489%'
      and (select prosecdef and proconfig = array['search_path=\"\"']
             from pg_catalog.pg_proc where oid = 'public.request_book_review(uuid)'::regprocedure)
      and has_function_privilege('authenticated', 'public.request_book_review(uuid)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.request_book_review(uuid)', 'EXECUTE')
      and (select prosecdef and provolatile = 's' and proconfig = array['search_path=\"\"']
             from pg_catalog.pg_proc where oid = 'public.book_is_locked_for_review(uuid)'::regprocedure)
      and not has_function_privilege('anon', 'public.book_is_locked_for_review(uuid)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.book_is_locked_for_review(uuid)', 'EXECUTE')
      and not has_function_privilege('service_role', 'public.book_is_locked_for_review(uuid)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.books_refuse_change_while_in_review()', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.book_children_refuse_change_while_in_review()', 'EXECUTE')
      and (select count(*) = 4 from pg_catalog.pg_trigger
            where not tgisinternal and tgname in (
              'books_refuse_change_while_in_review',
              'book_contributors_refuse_change_while_in_review',
              'book_ai_disclosures_refuse_change_while_in_review',
              'book_rights_declarations_refuse_while_in_review'))
      and pg_catalog.pg_get_triggerdef((select oid from pg_catalog.pg_trigger where tgname = 'books_refuse_change_while_in_review'))
          like '%pen_name_id, series_id, series_position%'
      and pg_catalog.pg_get_functiondef('public.book_children_refuse_change_while_in_review()'::regprocedure)
          like '%for key share%'
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry BD15 P5a as intended" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: request_book_review has LB489, definer with empty search_path, authenticated only; the lock helper and trigger functions closed to the app roles; the four triggers present; pen name and series locked; child writes take a key-share lock on the book"
  fi
done

# ============================================================
# Audit r1 F2, two sessions: a child-table write waits for a "Send for
# review" in flight (request_book_review holds the book row FOR UPDATE)
# and is then refused, instead of slipping in beside it.
# ============================================================
SECTIONS=$((SECTIONS + 1))
psql -X -q -d "$DB_A" -v ON_ERROR_STOP=1 > /dev/null 2> "$WORKDIR/race_fix.err" <<'RACEFIX'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0918000-0000-4000-8000-00000000000a', 'r091-a@test', now(), '{"role":"author","display_name":"R091 Ana"}');
insert into public.books (id, author_id, title, description, price_all, file_path, cover_path) values
  ('e0918001-0000-4000-8000-000000000001', 'e0918000-0000-4000-8000-00000000000a', 'R091 race', 'D.', 0,
   'e0918000-0000-4000-8000-00000000000a/e0918001-0000-4000-8000-000000000001/v1.epub', 'e0918009-0000-4000-8000-000000000001/cover.jpg');
insert into public.book_ai_disclosures (book_id, ai_used) values ('e0918001-0000-4000-8000-000000000001', false);
RACEFIX
# Session 1: the author's send, held open for 3 seconds after it ran.
psql -X -q -d "$DB_A" -v ON_ERROR_STOP=1 > "$WORKDIR/race_s1.out" 2> "$WORKDIR/race_s1.err" <<'S1' &
begin;
select set_config('request.jwt.claim.sub', 'e0918000-0000-4000-8000-00000000000a', true) is not null;
set local role authenticated;
select public.request_book_review('e0918001-0000-4000-8000-000000000001') is not null;
select pg_sleep(3);
commit;
S1
S1_PID=$!
sleep 1
# Session 2: the catalog writer's AI-answer upsert, while session 1 is open.
RACE_OUT="$(psql -X -q -t -A -d "$DB_A" -c "
  set role service_role;
  do \$\$ begin
    insert into public.book_ai_disclosures (book_id, ai_used) values ('e0918001-0000-4000-8000-000000000001', true)
      on conflict (book_id) do update set ai_used = excluded.ai_used;
    raise notice 'accepted';
  exception when sqlstate 'LB490' then raise notice 'refused';
  end \$\$;" 2>&1)"
wait "$S1_PID" || true
AI_AFTER="$(psql -X -q -t -A -d "$DB_A" -c "select ai_used::text from public.book_ai_disclosures where book_id = 'e0918001-0000-4000-8000-000000000001'")"
if [ -s "$WORKDIR/race_fix.err" ] || [ -s "$WORKDIR/race_s1.err" ] \
   || ! printf '%s' "$RACE_OUT" | grep -q 'NOTICE:  refused' || [ "$AI_AFTER" != "false" ]; then
  echo "FAIL [child_write_race]: the AI answer slipped in beside a send in flight" >&2
  cat "$WORKDIR/race_fix.err" "$WORKDIR/race_s1.err" >&2 || true
  printf '%s\n' "$RACE_OUT" "ai_used after: $AI_AFTER" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [child_write_race]: an AI-answer write during a send in flight waited and was refused (LB490); the answer is unchanged"
fi

# ============================================================
# Part 2: the migration over POPULATED base data, then the rollback.
#   A  author: a draft WAITING FOR REVIEW (with a contributor, an AI
#      answer and a rights declaration), a published book, a plain draft
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0919000-0000-4000-8000-00000000000a', 'q091-a@test', now(), '{"role":"author","display_name":"Q091 Ana"}');
insert into public.books (id, author_id, title, description, status, price_all, published_at, file_path, cover_path) values
  ('e0919001-0000-4000-8000-000000000001', 'e0919000-0000-4000-8000-00000000000a', 'Q091 in review', 'D.', 'draft', 0, null,
   'e0919000-0000-4000-8000-00000000000a/e0919001-0000-4000-8000-000000000001/v1.epub', 'e0919009-0000-4000-8000-000000000001/cover.jpg'),
  ('e0919001-0000-4000-8000-000000000002', 'e0919000-0000-4000-8000-00000000000a', 'Q091 plain draft', 'D.', 'draft', null, null, null, null);
insert into public.book_contributors (book_id, name, role) values
  ('e0919001-0000-4000-8000-000000000001', 'Q091 Editor', 'Editor');
insert into public.book_ai_disclosures (book_id, ai_used) values ('e0919001-0000-4000-8000-000000000001', false);
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, status)
  values ('e0919001-0000-4000-8000-000000000001', 'Q091 in review', 'e0919000-0000-4000-8000-00000000000a',
          'e0919000-0000-4000-8000-00000000000a/e0919001-0000-4000-8000-000000000001/v1.epub',
          'e0919009-0000-4000-8000-000000000001/cover.jpg', 'pending');
FIXTURES

cat > "$WORKDIR/fingerprint.sql" <<'FINGERPRINT'
select 'books', coalesce(string_agg(to_jsonb(t)::text, ';' order by t.id), '<none>') from public.books t;
select 'book_reviews', coalesce(string_agg((to_jsonb(t) - 'id')::text, ';' order by t.book_id, t.status), '<none>') from public.book_reviews t;
select 'book_contributors', coalesce(string_agg((to_jsonb(t) - 'id')::text, ';' order by t.book_id, t.name), '<none>') from public.book_contributors t;
select 'book_ai_disclosures', coalesce(string_agg(to_jsonb(t)::text, ';' order by t.book_id), '<none>') from public.book_ai_disclosures t;
FINGERPRINT

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
run_file "$DB_C" "$MIGRATION" "$WORKDIR/migrate.out" "$WORKDIR/migrate.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after.out" "$WORKDIR/after.err" || STEP_RC=1
ERRS=0
for e in before migrate after; do
  [ -s "$WORKDIR/$e.err" ] && ERRS=1
done
if [ "$STEP_RC" -ne 0 ] || [ "$ERRS" -ne 0 ]; then
  echo "FAIL [populated]: a step errored" >&2
  cat "$WORKDIR"/*.err >&2 || true
  FAILURES=$((FAILURES + 1))
elif [ ! -s "$WORKDIR/before.out" ] || grep -q '<none>' "$WORKDIR/before.out"; then
  echo "FAIL [populated]: the fixture rows are missing -- the check would be vacuous" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/after.out"; then
  echo "FAIL [populated]: the migration changed a stored value" >&2
  diff "$WORKDIR/before.out" "$WORKDIR/after.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated]: the migration changed no stored value (a draft waiting for review among the rows)"
fi

# The guard is live on the migrated populated database: the waiting
# draft refuses a catalog-writer edit, the plain draft does not.
SECTIONS=$((SECTIONS + 1))
LIVE="$(psql -X -q -t -A -d "$DB_C" -v ON_ERROR_STOP=1 -c "
  begin;
  set local role service_role;
  update public.books set title = 'x' where id = 'e0919001-0000-4000-8000-000000000002';
  rollback;" -c "
  do \$\$ begin
    set local role service_role;
    update public.books set title = 'x' where id = 'e0919001-0000-4000-8000-000000000001';
    raise exception 'not refused';
  exception when sqlstate 'LB490' then null;
  end \$\$;" -c "select 'guard live'" 2> "$WORKDIR/live.err")"
if [ -s "$WORKDIR/live.err" ] || [ "$(printf '%s' "$LIVE" | tail -n 1)" != "guard live" ]; then
  echo "FAIL [guard_live]: the guard does not hold on the migrated populated database" >&2
  cat "$WORKDIR/live.err" >&2 || true
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [guard_live]: the waiting draft refuses an edit (LB490); the plain draft accepts one"
fi

# The rollback, twice: stored values unchanged, and every catalog section
# identical to a FRESH build of the base schema.
SECTIONS=$((SECTIONS + 1))
STEP_RC=0
run_file "$DB_C" "$ROLLBACK" "$WORKDIR/rb1.out" "$WORKDIR/rb1.err" || STEP_RC=1
run_file "$DB_C" "$ROLLBACK" "$WORKDIR/rb2.out" "$WORKDIR/rb2.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/rolled_back.out" "$WORKDIR/rolled_back.err" || STEP_RC=1
ERRS=0
[ -s "$WORKDIR/rolled_back.err" ] && ERRS=1
# rb*.err may carry the NOTICEs of DROP ... IF EXISTS on the second run.
if grep -v '^psql:.*NOTICE:' "$WORKDIR/rb1.err" "$WORKDIR/rb2.err" | grep -q .; then
  ERRS=1
fi
if [ "$STEP_RC" -ne 0 ] || [ "$ERRS" -ne 0 ] || ! cmp -s "$WORKDIR/before.out" "$WORKDIR/rolled_back.out"; then
  echo "FAIL [rollback]:" >&2
  cat "$WORKDIR"/rb1.err "$WORKDIR"/rb2.err >&2 || true
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [rollback]: twice without error; stored values unchanged"
fi

echo "  building D: the base schema, to compare the rolled-back catalog against"
build "$DB_D" "$STUB" "$WORKDIR/base_schema.sql"
echo "  comparing every catalog section: C (rolled back) vs D (base)"
DB_A="$DB_C"
DB_B="$DB_D"
catalog_sections

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 091_bd15_review_guard_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 091_bd15_review_guard_catalog_equivalence.sh -- $SECTIONS sections: catalog identical between $PATCHED_LABEL and the base + migration, none empty; both carry the guard; the migration changes no stored value; after the rollback the catalog is identical to the base"
