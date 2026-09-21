#!/usr/bin/env bash
# ALL-CATALOG-1: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema plus the new
# migration describe the same database -- not approximately, across
# every catalog that can differ.
#
# Modelled on 060_pok_fulfilment_gap_first_seen_catalog_equivalence.sh,
# which exists for the same reason: two build paths exist in this
# repository -- a fresh environment is created from schema.sql, staging
# is migrated -- and nothing else compares them.
#
# Why the risk is concrete in THIS change rather than theoretical:
#
#   * three columns are appended by `add column` on one path and
#     declared inside `create table` on the other. `add column` always
#     appends; a schema.sql that declares the column anywhere but last
#     produces a different physical column order that no "the column
#     exists" check would see.
#   * this migration DROPS an existing constraint and adds a
#     replacement. The dropped one, `discount_codes_check`, was
#     auto-named from declaration order. Getting the replacement's name
#     or definition even slightly different between the two files
#     produces two databases that both look correct in isolation and
#     disagree with each other.
#   * the replacement is the ONLY thing standing between the two legacy
#     discount columns and the new one. A path that ends up without it
#     accepts a discount row with two discount types, or none.
#
# Every section must ALSO be non-vacuous, and that is enforced rather
# than hoped for: two identical EMPTY results are the failure mode a
# "byte-identical outputs" check silently passes. So each section
# requires a non-zero row count on BOTH sides, a zero exit status from
# psql, and empty stderr -- and stderr is captured to its own file,
# never merged into the stdout that is later compared, so a matching
# error message can never be mistaken for matching catalog output.
#
# This harness adds one comparison 060 does not have: object COMMENTS.
# This migration and schema.sql each carry three `comment on column`
# statements, and a comment that exists on one path and not the other is
# documentation drift that every other section here would pass over.
#
# BEFORE AND AFTER THE COMMIT. This harness is written to be run with no
# arguments, both while the patch is only staged and forever afterwards.
# Before the migration is committed it compares the working tree; once it
# is committed it resolves the commit that first added the migration and
# compares THAT commit's schema.sql, so later schema work cannot turn
# this file red. See `resolve_patched_schema` below for the full
# precedence order and for what it refuses to guess.
#
# Usage, from the repository root:
#
#   ./supabase/tests/061_all_catalog_schema_expansion_catalog_equivalence.sh
#
# Requires psql and git on PATH, and a PostgreSQL server this user may
# create databases on (PGHOST/PGUSER/PGPORT as usual). PostgreSQL 17 or
# newer: supabase/schema.sql uses the MAINTAIN privilege. It creates four
# disposable databases and drops them on exit. It NEVER touches staging,
# production, or any database it did not create. Exits non-zero on any
# difference, any error, or any empty comparison.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against: origin/staging at the time, the merge of PR #20.
BASE_REF="${BASE_REF:-6abdb3d957808578b295e14eca99acdf254ad830}"
MIGRATION="${MIGRATION:-supabase/migrations/20260921153012_all_catalog_schema_expansion.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
# The path of the schema snapshot inside the repository. `SCHEMA` and
# `PATCHED_REF` are the overrides; see resolve_patched_schema.
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# The identifier that must be ABSENT from the base schema and PRESENT in
# the patched one. This is what makes "we resolved the wrong schema" a
# named failure instead of a confusing diff.
MARKER="${MARKER:-price_all}"
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
DB_A="librum_all_catalog_a_${SUFFIX}"
DB_B="librum_all_catalog_b_${SUFFIX}"
WORKDIR="$(mktemp -d)"

cleanup() {
  dropdb --if-exists "$DB_A" >/dev/null 2>&1 || true
  dropdb --if-exists "$DB_B" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# The base schema is read from git rather than from the working tree:
# the working tree's copy may be the PATCHED one, and comparing a file
# against itself proves nothing.
if ! git cat-file -e "${BASE_REF}:${SCHEMA_PATH}" 2>/dev/null; then
  echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} is not readable -- pass BASE_REF=<commit> for the base this migration targets" >&2
  exit 1
fi
git show "${BASE_REF}:${SCHEMA_PATH}" > "$WORKDIR/base_schema.sql"

resolve_patched_schema
echo "  patched schema: $PATCHED_LABEL"

# Both halves of the boundary are asserted, not assumed. A base that
# already carries the change, or a "patched" schema that does not,
# means the wrong schema was resolved -- and every comparison below
# would then pass or fail for a reason that has nothing to do with this
# migration.
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
  # The non-vacuity gate. Two identical empty results are not evidence
  # of equivalence; they are evidence that the query matched nothing.
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

compare function_security "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''), p.provolatile::text
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
select c.relname, c.relkind::text, coalesce(c.relacl::text, '<default>')
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

# Object comments. Not in 060, added here because this change ships six
# `comment on column` statements -- three in schema.sql and three in the
# migration -- and nothing else in this file would notice if one path
# carried a comment the other did not.
compare column_comments "
select c.relname, a.attname, d.description
  from pg_catalog.pg_description d
  join pg_catalog.pg_class c on c.oid = d.objoid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attribute a
    on a.attrelid = d.objoid and a.attnum = d.objsubid
 where n.nspname = 'public' and d.objsubid > 0
 order by c.relname, a.attnum"

# A last, narrow assertion that the thing this migration actually adds
# is present on BOTH sides. Everything above proves the two agree; this
# proves they agree on a database that CARRIES the change, rather than
# on two copies of the base.
for db in "$DB_A" "$DB_B"; do
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      exists (select 1 from pg_catalog.pg_attribute
               where attrelid = 'public.books'::regclass
                 and attname = 'price_all' and not attisdropped)
      and exists (select 1 from pg_catalog.pg_attribute
                   where attrelid = 'public.bundles'::regclass
                     and attname = 'price_all' and not attisdropped)
      and exists (select 1 from pg_catalog.pg_attribute
                   where attrelid = 'public.discount_codes'::regclass
                     and attname = 'amount_off_all' and not attisdropped)
      and exists (select 1 from pg_catalog.pg_constraint
                   where conrelid = 'public.books'::regclass
                     and conname = 'books_price_all_range_check')
      and exists (select 1 from pg_catalog.pg_constraint
                   where conrelid = 'public.bundles'::regclass
                     and conname = 'bundles_price_all_range_check')
      and exists (select 1 from pg_catalog.pg_constraint
                   where conrelid = 'public.discount_codes'::regclass
                     and conname = 'discount_codes_amount_off_all_range_check')
      and exists (select 1 from pg_catalog.pg_constraint
                   where conrelid = 'public.discount_codes'::regclass
                     and conname = 'discount_codes_exactly_one_discount_type_check')
      -- and the constraint the migration replaced is GONE on both
      -- paths. An equivalence run in which both databases still carry
      -- it would mean the migration's guard silently declined to fire.
      and not exists (select 1 from pg_catalog.pg_constraint
                       where conrelid = 'public.discount_codes'::regclass
                         and conname = 'discount_codes_check')
    )::text")"
  if [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry the ALL-CATALOG-1 columns and constraints, or still carries discount_codes_check" >&2
    FAILURES=$((FAILURES + 1))
  fi
done

# ============================================================
# Part 2: the migration applied over POPULATED data.
#
# Everything above compares two EMPTY databases, which is the right way
# to compare shape and the wrong way to learn what happens to rows that
# already exist. Two things are only provable here:
#
#   * `alter table ... add constraint ... check` VALIDATES existing
#     rows. A schema-only comparison never runs that validation against
#     a single row, so it cannot tell you the migration applies to a
#     database that has data in it -- which is the only kind staging is.
#   * "existing rows are not backfilled" is a claim about rows that
#     existed BEFORE the migration ran. A suite running against an
#     already-built schema can only show that a NEW row defaults to
#     null, which is a weaker statement.
# ============================================================
DB_C="librum_all_catalog_c_${SUFFIX}"
DB_D="librum_all_catalog_d_${SUFFIX}"

cleanup_cd() {
  dropdb --if-exists "$DB_C" >/dev/null 2>&1 || true
  dropdb --if-exists "$DB_D" >/dev/null 2>&1 || true
}
trap 'cleanup; cleanup_cd' EXIT

cat > "$WORKDIR/legacy_rows.sql" <<'FIXTURES'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0610f00-0000-0000-0000-000000000001', 'p061-harness-author@test', now(),
   '{"role":"author","display_name":"P061 Harness Author"}');

insert into public.books (id, author_id, title, price_cents, status) values
  ('e0610f01-0000-0000-0000-000000000001', 'e0610f00-0000-0000-0000-000000000001', 'P061 Harness Free Book', 0, 'published'),
  ('e0610f01-0000-0000-0000-000000000002', 'e0610f00-0000-0000-0000-000000000001', 'P061 Harness Legacy USD Book', 799, 'published');

insert into public.bundles (id, author_id, title, price_cents, status) values
  ('e0610f02-0000-0000-0000-000000000001', 'e0610f00-0000-0000-0000-000000000001', 'P061 Harness Legacy USD Bundle', 1499, 'published');

-- Both surviving legacy discount shapes are represented here. The
-- migration must preserve every shape admitted by the base constraint,
-- regardless of which shapes happen to exist in any current
-- environment.
insert into public.discount_codes (author_id, book_id, code, percent_off) values
  ('e0610f00-0000-0000-0000-000000000001', 'e0610f01-0000-0000-0000-000000000002', 'P061-HARNESS-PCT', 10);

insert into public.discount_codes (author_id, book_id, code, amount_off_cents) values
  ('e0610f00-0000-0000-0000-000000000001', 'e0610f01-0000-0000-0000-000000000002', 'P061-HARNESS-CENTS', 500);
FIXTURES

echo "  building C: ${BASE_REF:0:9}:$SCHEMA_PATH + legacy rows + $MIGRATION"
build "$DB_C" "$STUB" "$WORKDIR/base_schema.sql" "$WORKDIR/legacy_rows.sql" "$MIGRATION"

SECTIONS=$((SECTIONS + 1))
POPULATED="$(psql -X -q -t -A -d "$DB_C" -v ON_ERROR_STOP=1 -c "
  select (
    (select count(*) from public.books where price_all is not null) = 0
    and (select count(*) from public.bundles where price_all is not null) = 0
    and (select count(*) from public.discount_codes where amount_off_all is not null) = 0
    and (select count(*) from public.books) = 2
    and (select count(*) from public.bundles) = 1
    and (select count(*) from public.discount_codes) = 2
    -- the legacy values themselves are untouched
    and (select price_cents from public.books where id = 'e0610f01-0000-0000-0000-000000000002') = 799
    and (select price_cents from public.bundles where id = 'e0610f02-0000-0000-0000-000000000001') = 1499
    and (select percent_off from public.discount_codes where code = 'P061-HARNESS-PCT') = 10
    and (select amount_off_cents from public.discount_codes where code = 'P061-HARNESS-CENTS') = 500
  )::text" 2> "$WORKDIR/populated.err")"
if [ -s "$WORKDIR/populated.err" ] || [ "$POPULATED" != "true" ]; then
  echo "FAIL [populated_migration]: rows that existed before the migration did not survive it unchanged with null new columns" >&2
  tail -n 5 "$WORKDIR/populated.err" >&2 || true
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated_migration]: 5 pre-existing rows kept their legacy values and null new columns"
fi

# The migration's own guard, and the fact that it now runs BEFORE any
# DDL.
#
# Two claims are checked here, and the second is the one that needed the
# guard moved to the top of the file:
#
#   1. the migration refuses a database whose discount invariant it does
#      not recognise, with its own message and a non-zero exit;
#   2. after that refusal the database is STRUCTURALLY UNCHANGED -- no
#      column, no constraint, no comment was left behind.
#
# The second claim is only interesting when the file is applied WITHOUT
# `--single-transaction`, which is exactly how it is run below: psql in
# autocommit, one statement at a time, the way a console session or a
# tool that splits on semicolons would do it. With the guard at the end
# of the file that run would commit three `add column`s, four
# constraints and three comments before refusing, and leave an operator
# reconciling a half-applied migration by hand. This asserts it does
# not.
#
# This does NOT license applying the migration outside a transaction.
# The guard only covers a failure AT the guard; a failure at any later
# statement still leaves a partial schema. The rollout requirement is
# still a single transaction, and the migration's own header says so.
echo "  checking the migration's guard refuses, and leaves nothing behind"
SECTIONS=$((SECTIONS + 1))
# The probe database is built with the same `build` helper the others
# use, which judges success by psql's EXIT STATUS. Judging it by "did
# anything reach stderr" would be wrong here: schema.sql emits NOTICEs
# on every build.
build "$DB_D" "$STUB" "$WORKDIR/base_schema.sql"
set +e
psql -X -q -d "$DB_D" -v ON_ERROR_STOP=1 \
  -c "alter table public.discount_codes drop constraint discount_codes_check" > /dev/null 2> "$WORKDIR/d_build.err"
D_RC=$?
set -e

# The catalog fingerprint of the probe database, taken before and after
# the refused run. Columns, constraints and comments over the whole
# public schema, not only the three tables this migration touches.
guard_fingerprint() {
  psql -X -q -t -A -F '|' -d "$DB_D" -v ON_ERROR_STOP=1 -c "
    select 'col|' || c.relname || '|' || a.attnum || '|' || a.attname || '|' ||
           pg_catalog.format_type(a.atttypid, a.atttypmod)
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and a.attnum > 0 and not a.attisdropped
    union all
    select 'con|' || c.relname || '|' || con.conname || '|' ||
           pg_catalog.pg_get_constraintdef(con.oid)
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
    union all
    select 'com|' || c.relname || '|' || a.attname || '|' || d.description
      from pg_catalog.pg_description d
      join pg_catalog.pg_class c on c.oid = d.objoid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a
        on a.attrelid = d.objoid and a.attnum = d.objsubid
     where n.nspname = 'public' and d.objsubid > 0
    order by 1" 2> "$WORKDIR/guard_fp.err"
}

if [ "$D_RC" -ne 0 ]; then
  echo "FAIL [migration_guard]: could not remove discount_codes_check from the probe database" >&2
  tail -n 5 "$WORKDIR/d_build.err" >&2
  FAILURES=$((FAILURES + 1))
else
  guard_fingerprint > "$WORKDIR/guard_before.out"
  if [ -s "$WORKDIR/guard_fp.err" ] || [ ! -s "$WORKDIR/guard_before.out" ]; then
    echo "FAIL [migration_guard]: could not fingerprint the probe database before the run" >&2
    FAILURES=$((FAILURES + 1))
  else
    set +e
    # DELIBERATELY NOT --single-transaction. See the note above.
    psql -X -q -d "$DB_D" -v ON_ERROR_STOP=1 -f "$MIGRATION" > /dev/null 2> "$WORKDIR/guard.err"
    GUARD_RC=$?
    set -e
    GUARD_FAILED=0

    if [ "$GUARD_RC" -eq 0 ]; then
      echo "FAIL [migration_guard]: the migration applied to a database with no discount_codes_check -- the guard did not fire" >&2
      GUARD_FAILED=1
    elif ! grep -q 'ALL-CATALOG-1: public.discount_codes has no constraint named discount_codes_check' "$WORKDIR/guard.err"; then
      echo "FAIL [migration_guard]: the migration failed, but not with the guard's own message" >&2
      tail -n 5 "$WORKDIR/guard.err" >&2
      GUARD_FAILED=1
    fi

    # Nothing may have been created. Named individually so a partial
    # application says WHICH object leaked, not merely that something
    # did.
    LEAKED="$(psql -X -q -t -A -F '|' -d "$DB_D" -v ON_ERROR_STOP=1 -c "
      select string_agg(x, ', ' order by x) from (
        select 'column public.books.price_all' as x
          from pg_catalog.pg_attribute
         where attrelid = 'public.books'::regclass
           and attname = 'price_all' and not attisdropped
        union all
        select 'column public.bundles.price_all'
          from pg_catalog.pg_attribute
         where attrelid = 'public.bundles'::regclass
           and attname = 'price_all' and not attisdropped
        union all
        select 'column public.discount_codes.amount_off_all'
          from pg_catalog.pg_attribute
         where attrelid = 'public.discount_codes'::regclass
           and attname = 'amount_off_all' and not attisdropped
        union all
        select 'constraint ' || conname
          from pg_catalog.pg_constraint
         where conname in ('books_price_all_range_check',
                           'bundles_price_all_range_check',
                           'discount_codes_amount_off_all_range_check',
                           'discount_codes_exactly_one_discount_type_check')
        union all
        select 'comment on ' || c.relname || '.' || a.attname
          from pg_catalog.pg_description d
          join pg_catalog.pg_class c on c.oid = d.objoid
          join pg_catalog.pg_attribute a
            on a.attrelid = d.objoid and a.attnum = d.objsubid
         where d.objsubid > 0
           and a.attname in ('price_all', 'amount_off_all')
           and c.relname in ('books', 'bundles', 'discount_codes')
      ) s" 2> "$WORKDIR/leak.err")"

    if [ -s "$WORKDIR/leak.err" ]; then
      echo "FAIL [migration_guard]: could not check the probe database for leaked objects" >&2
      tail -n 3 "$WORKDIR/leak.err" >&2
      GUARD_FAILED=1
    elif [ -n "$LEAKED" ]; then
      echo "FAIL [migration_guard]: the refused migration left objects behind: $LEAKED" >&2
      GUARD_FAILED=1
    fi

    # And the whole-schema fingerprint, which also catches anything the
    # list above does not name.
    guard_fingerprint > "$WORKDIR/guard_after.out"
    if [ -s "$WORKDIR/guard_fp.err" ] || [ ! -s "$WORKDIR/guard_after.out" ]; then
      echo "FAIL [migration_guard]: could not fingerprint the probe database after the run" >&2
      GUARD_FAILED=1
    elif ! cmp -s "$WORKDIR/guard_before.out" "$WORKDIR/guard_after.out"; then
      echo "FAIL [migration_guard]: the refused migration changed the database's catalog" >&2
      diff "$WORKDIR/guard_before.out" "$WORKDIR/guard_after.out" | head -n 20 >&2
      GUARD_FAILED=1
    fi

    if [ "$GUARD_FAILED" -ne 0 ]; then
      FAILURES=$((FAILURES + 1))
    else
      echo "  ok [migration_guard]: refused with its own message, non-zero, and left the catalog byte-identical"
    fi
  fi
fi

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 061_all_catalog_schema_expansion_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 061_all_catalog_schema_expansion_catalog_equivalence.sh -- $SECTIONS catalog sections identical between $PATCHED_LABEL and ${BASE_REF:0:9} + migration, none empty"
