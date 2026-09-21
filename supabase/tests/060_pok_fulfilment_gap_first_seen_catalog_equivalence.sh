#!/usr/bin/env bash
# POK-FULFILMENT-1: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema plus the new
# migration describe the same database -- not approximately, byte for
# byte, across every catalog that can differ.
#
# Why this is a file rather than a procedure someone runs once. Two build
# paths exist in this repository and nothing has ever compared them: a
# fresh environment is created from schema.sql, while staging is migrated.
# They drift silently. A drift in this particular change is not
# theoretical: the CHECK constraint added here is NAMED explicitly only
# because an anonymous multi-column CHECK is auto-named <table>_check<n>
# with n depending on declaration order, which the two paths do not share.
# A manual comparison would have caught that once; this catches it on
# every run.
#
# What is compared, and why each section is here rather than "obviously
# unchanged":
#
#   columns       attnum ordering included. `add column` appends; a
#                 schema.sql that declares the column anywhere but last
#                 produces a different physical order.
#   constraints   names, definitions AND convalidated. A NOT VALID
#                 constraint has the same definition and a different
#                 meaning.
#   indexes       an index created on one path and not the other changes
#                 plans, not correctness -- and is exactly the kind of
#                 thing that goes unnoticed.
#   triggers      including tgtype, which is where "before update" and
#                 "before insert or update" differ.
#   functions     the full pg_get_functiondef of every function in the
#                 schema, plus prosecdef and proconfig. This migration
#                 restates a trigger function body wholesale; if the two
#                 copies ever diverge by one branch, this is what says so.
#   ACLs          function, table, COLUMN and schema. The migration
#                 re-issues its own REVOKEs independently of schema.sql,
#                 so the two paths genuinely can end up with different
#                 grants. They are expected not to differ, which is the
#                 reason to assert it.
#   RLS           relrowsecurity and relforcerowsecurity, plus every
#                 policy in the schema. An RLS flag that is on in one
#                 build and off in the other is a data-exposure
#                 difference that no column comparison would see.
#   types         the composite rowtype of every table in the schema, and
#                 the argument/return types of its functions.
#
# Every section must ALSO be non-vacuous, and that is enforced rather
# than hoped for: two identical EMPTY results are the failure mode a
# "byte-identical outputs" check silently passes. A typo in a relation
# name, a build that failed earlier, or a filter that matches nothing all
# produce identical emptiness. So each section requires a non-zero row
# count on BOTH sides, a zero exit status from psql, and empty stderr --
# and stderr is captured to its own file, never merged into the stdout
# that is later compared, so a matching error message can never be
# mistaken for matching catalog output.
#
# CORRECTED 21 September 2026: this file used to compare the WORKING
# TREE's supabase/schema.sql against its pinned base plus this
# migration. That premise held only while the working tree was exactly
# that base plus exactly this migration, so the first later schema change
# -- the ALL catalog expansion -- turned its documented default
# invocation red, reporting that change as a difference although nothing
# about POK-FULFILMENT-1 had moved. A harness that goes red for work it
# was never about is a harness people learn to skip.
#
# It now compares its OWN INTRODUCTION BOUNDARY: the schema.sql at the
# commit that first added this migration, against that migration's base
# plus this migration. Both sides are fixed points in history, so the
# default invocation is stable no matter what later work does to the
# working tree, and it keeps testing the one thing it was written to
# test. The only working-tree input left is the migration FILE itself --
# deliberately, because an applied migration must never be edited, and
# this is one of the few places that would notice.
#
# Usage, from the repository root:
#
#   ./supabase/tests/060_pok_fulfilment_gap_first_seen_catalog_equivalence.sh
#
# Requires psql and git on PATH, and a PostgreSQL server this user may
# create databases on (PGHOST/PGUSER/PGPORT as usual). It creates two
# disposable databases and drops them on exit. It NEVER touches staging,
# production, or any database it did not create. Exits non-zero on any
# difference, any error, or any empty comparison.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against: origin/staging at the time, the merge of PR #19.
BASE_REF="${BASE_REF:-30ab7cb9f6ee07056492a2a0a2de1d59d302d0cd}"
MIGRATION="${MIGRATION:-supabase/migrations/20260920181856_pok_fulfilment_gap_first_seen.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
# The path of the schema snapshot inside the repository. `SCHEMA` and
# `PATCHED_REF` are the overrides; see resolve_patched_schema.
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# The identifier that must be ABSENT from the base schema and PRESENT in
# the patched one. This is what makes "we resolved the wrong schema" a
# named failure instead of a confusing diff.
MARKER="${MARKER:-fulfilment_gap_first_seen_at}"
# This migration is merged, so there is no pre-commit case to allow. A
# tree that does not carry it is a tree this harness has nothing to say
# about, and it fails rather than comparing the working tree.
ALLOW_WORKTREE=0

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

for f in "$MIGRATION" "$STUB"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: $f not found -- run this from a checkout that carries the patch" >&2
    exit 1
  fi
done

# ============================================================
# Which "patched schema" is this harness comparing?
#
# This is the question that made the first version of this file go stale
# the moment the trunk moved. A catalog-equivalence harness has to
# compare the schema AS OF THIS MIGRATION'S INTRODUCTION against that
# migration's own base -- not against whatever the working tree happens
# to contain later. Pinning the base alone is not enough: the patched
# side has to be pinned to the same boundary, or every later schema
# change is reported as a difference and the harness is red forever
# through no fault of the change under test.
#
# Resolution order, highest precedence first:
#
#   SCHEMA       an explicit FILE to use as the patched schema. Wins over
#                everything. `SCHEMA=supabase/schema.sql` forces the
#                working-tree comparison at any time.
#   PATCHED_REF  an explicit COMMIT whose supabase/schema.sql is the
#                patched schema.
#   (automatic)  the single commit that first ADDED this migration. Once
#                the migration is committed, this is the introduction
#                boundary and never moves again.
#   (worktree)   only when the migration is NOT in this history at all --
#                the pre-commit case, where the patch is staged and the
#                working tree IS the patched schema. Harnesses for
#                already-merged migrations disable this.
#
# Zero candidate commits where the worktree fallback is not allowed, or
# more than one candidate, is a hard failure with the candidates named.
# It never silently falls back to a schema that is not the boundary,
# because a comparison against the wrong schema does not report "wrong
# schema" -- it reports whatever unrelated change happens to be in the
# tree, which is exactly how a harness teaches people to ignore it.
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
      # Not in this history. Either the patch is not committed yet, or
      # this harness is being run somewhere it does not belong.
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
      # The pre-commit comparison is only as good as the tree it reads,
      # so say so out loud when the tree is not what is staged. A warning
      # rather than a failure: an author iterating before `git add`
      # should still be able to run this.
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

SUFFIX="$$"
DB_A="librum_catalog_a_${SUFFIX}"
DB_B="librum_catalog_b_${SUFFIX}"
WORKDIR="$(mktemp -d)"

cleanup() {
  dropdb --if-exists "$DB_A" >/dev/null 2>&1 || true
  dropdb --if-exists "$DB_B" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# The base schema is read from git rather than from the working tree: the
# working tree's copy may be the PATCHED one, and comparing a file
# against itself proves nothing.
if ! git cat-file -e "${BASE_REF}:${SCHEMA_PATH}" 2>/dev/null; then
  echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} is not readable -- pass BASE_REF=<commit> for the base this migration targets" >&2
  exit 1
fi
git show "${BASE_REF}:${SCHEMA_PATH}" > "$WORKDIR/base_schema.sql"

resolve_patched_schema
echo "  patched schema: $PATCHED_LABEL"

# Both halves of the boundary are asserted, not assumed. A base that
# already carries the change, or a "patched" schema that does not, means
# the wrong schema was resolved -- and every comparison below would then
# pass or fail for a reason that has nothing to do with this migration.
if grep -q "$MARKER" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} already mentions $MARKER -- that is not the base this migration expands" >&2
  exit 1
fi
if ! grep -q "$MARKER" "$PATCHED_FILE"; then
  echo "FAIL: the resolved patched schema ($PATCHED_LABEL) does not mention $MARKER -- it does not carry this migration" >&2
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
echo "  building B: ${BASE_REF:0:9}:$SCHEMA_PATH + $MIGRATION"
build "$DB_B" "$STUB" "$WORKDIR/base_schema.sql" "$MIGRATION"

FAILURES=0
SECTIONS=0

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
  # The non-vacuity gate. Two identical empty results are not evidence of
  # equivalence; they are evidence that the query matched nothing.
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

MAPPING_TABLE="public.pok_book_checkout_orders"

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
select c.relname, con.conname, con.contype,
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

compare triggers "
select c.relname, t.tgname, t.tgtype, t.tgenabled,
       pg_catalog.pg_get_triggerdef(t.oid)
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal
 order by c.relname, t.tgname"

# The full body of every function in the schema, not only the two this
# migration touches: a migration that restates one function can just as
# easily leave another behind.
compare function_definitions "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       pg_catalog.pg_get_functiondef(p.oid)
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)"

compare function_security "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''), p.provolatile
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)"

compare function_acls "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       coalesce(p.proacl::text, '<default>')
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)"

compare table_acls "
select c.relname, c.relkind, coalesce(c.relacl::text, '<default>')
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
select c.relname, t.typname, t.typtype, t.typcategory
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

# A last, narrow assertion that the thing this migration actually adds is
# present on BOTH sides. Everything above proves the two agree; this
# proves they agree on a database that CARRIES the change, rather than on
# two copies of the base.
for db in "$DB_A" "$DB_B"; do
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      exists (select 1 from pg_catalog.pg_attribute
               where attrelid = '${MAPPING_TABLE}'::regclass
                 and attname = 'fulfilment_gap_first_seen_at' and not attisdropped)
      and exists (select 1 from pg_catalog.pg_constraint
                   where conrelid = '${MAPPING_TABLE}'::regclass
                     and conname = 'pok_book_checkout_orders_gap_first_seen_after_created_check')
      and exists (select 1 from pg_catalog.pg_trigger
                   where tgrelid = '${MAPPING_TABLE}'::regclass
                     and tgname = 'pok_book_checkout_orders_enforce_transition_rules'
                     and not tgisinternal)
    )::text")"
  if [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry the POK-FULFILMENT-1 column, constraint and trigger" >&2
    FAILURES=$((FAILURES + 1))
  fi
done

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 060_pok_fulfilment_gap_first_seen_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 060_pok_fulfilment_gap_first_seen_catalog_equivalence.sh -- $SECTIONS catalog sections identical between $PATCHED_LABEL and ${BASE_REF:0:9} + migration, none empty"
