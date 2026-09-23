#!/usr/bin/env bash
# ALL-TXN-CURRENCY-4: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema plus
# supabase/migrations/20260923160231_all_transaction_currency_provenance.sql
# describe the same database -- across every catalog that can differ --
# and that the four widened finance RPCs return exactly the rows, in
# exactly the order, they returned before the migration.
#
# Modelled on 064_all_discount_codes_acl_catalog_equivalence.sh; its
# generic machinery (schema resolution, the non-vacuous compare(), every
# catalog section) is carried over unchanged. This repository has two
# build paths -- a fresh environment is created from schema.sql,
# staging is migrated -- and nothing else compares them.
#
# Why the risk is concrete in THIS change:
#
#   * four finance.view RPCs change their RETURNS TABLE, which needs DROP
#     + CREATE on the migration path. A DROP discards the function's ACL,
#     so a migration that forgot to re-issue a grant would build cleanly
#     and silently lose EXECUTE on staging only. path A declares the
#     functions once, in place; path B drops and recreates them. The
#     function_acls section and the per-role effective EXECUTE section
#     see a lost or extra grant, and function_security sees a lost
#     SECURITY DEFINER, search_path or volatility.
#   * the helpers are appended to schema.sql but created mid-file on
#     the migration path; function_bodies and function_definitions
#     compare them byte for byte.
#   * adding a lateral join to a query can change its row count or its
#     order. Part 2 runs each finance RPC against the SAME populated
#     database before and after the migration and requires the original
#     columns to come back byte-identical, row for row, in order.
#
# Every section must ALSO be non-vacuous: each requires a non-zero row
# count on BOTH sides, a zero exit status from psql, and empty stderr,
# and stderr is captured separately from the compared stdout.
#
# Beyond equivalence, part 2 applies the migration over a POPULATED base
# (the fixture of 065_all_transaction_currency_provenance.test.sql,
# extracted from that file so there is one fixture, not two) and proves
# it rewrites no row.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer --
# schema.sql uses the MAINTAIN privilege):
#
#   ./supabase/tests/065_all_transaction_currency_provenance_catalog_equivalence.sh
#
# Overrides: BASE_REF, MIGRATION, STUB, SCHEMA_PATH, MARKER, and either
# SCHEMA (an explicit patched-schema file) or PATCHED_REF (an explicit
# patched-schema commit). Exits non-zero on any difference, any empty
# section, any non-zero psql exit, or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against: origin/staging at the time, the merge of PR #24.
BASE_REF="${BASE_REF:-2227cf7cf018bf565fd4bb6b1b50544f0c99afa4}"
MIGRATION="${MIGRATION:-supabase/migrations/20260923160231_all_transaction_currency_provenance.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
FIXTURE_SOURCE="${FIXTURE_SOURCE:-supabase/tests/065_all_transaction_currency_provenance.test.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-ALL-TXN-CURRENCY-4}"
# This migration may still be uncommitted, so the working-tree
# comparison is permitted here. Harnesses for merged migrations set 0.
ALLOW_WORKTREE=1

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

for f in "$MIGRATION" "$STUB" "$FIXTURE_SOURCE"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: $f not found -- run this from a checkout that carries the patch" >&2
    exit 1
  fi
done

SUFFIX="$$"
DB_A="librum_all_txn_currency_a_${SUFFIX}"
DB_B="librum_all_txn_currency_b_${SUFFIX}"
DB_C="librum_all_txn_currency_c_${SUFFIX}"
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
if ! git cat-file -e "${BASE_REF}:${SCHEMA_PATH}" 2>/dev/null; then
  echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} is not readable -- pass BASE_REF=<commit> for the base this migration targets" >&2
  exit 1
fi
git show "${BASE_REF}:${SCHEMA_PATH}" > "$WORKDIR/base_schema.sql"

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

# The base must actually carry the four finance RPCs in their OLD,
# narrower shape, or "widened by exactly two columns" is being proved
# against the wrong database.
for fn in list_refund_reconciliation_states list_finance_disputes \
          list_finance_checkout_exceptions list_finance_refund_entitlement_mismatches; do
  if ! grep -q "^create or replace function public.${fn}(" "$WORKDIR/base_schema.sql"; then
    echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} does not define public.${fn} -- wrong base" >&2
    exit 1
  fi
done
if grep -q "currency_state" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} already returns a currency_state -- that is not the base this migration changes" >&2
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

# Function sections: this migration adds six functions and recreates
# four, and these prove both paths end with the same ones --
# signatures, defaults, bodies, security and ACLs.
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

# Function ACLs. The recreated finance RPCs lose theirs on DROP and the
# migration re-issues them; this is where a missed grant would show.
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

# Effective EXECUTE, resolved per role rather than read off the ACL
# strings, so role membership and PUBLIC inheritance are included. A
# missing role prints '<no such role>' instead of erroring; both
# databases share one cluster, so that value is identical between them.
compare function_effective_execute "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid), role_name,
       case
         when role_name = 'public'
           or exists (select 1 from pg_catalog.pg_roles r where r.rolname = role_name)
         then has_function_privilege(role_name, p.oid, 'EXECUTE')::text
         else '<no such role>'
       end
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 cross join unnest(array['public','anon','authenticated','service_role','postgres']::text[]) as role_name
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid), role_name"

# ============================================================
# Beyond equivalence: the two databases must AGREE ON A DATABASE THAT
# CARRIES THE CHANGE, not on two copies of the base.
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      to_regprocedure('public.transaction_currency_evidence(text)') is not null
      and to_regprocedure('public.classify_transaction_currency(text[])') is not null
      and to_regprocedure('public.transaction_currency_provenance(text, uuid)') is not null
      and to_regprocedure('public.purchase_currency_provenance(text, integer)') is not null
      and has_function_privilege('authenticated', 'public.list_purchase_currencies(uuid[])', 'EXECUTE')
      and not has_function_privilege('anon', 'public.list_purchase_currencies(uuid[])', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.list_refund_request_currencies(uuid[])', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.transaction_currency_provenance(text, uuid)', 'EXECUTE')
      and (select bool_and(pg_catalog.pg_get_function_result(p.oid) like '%, currency_state text, currency text)')
             from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('list_refund_reconciliation_states', 'list_finance_disputes',
                                'list_finance_checkout_exceptions', 'list_finance_refund_entitlement_mismatches'))
      and (select count(*) from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('list_refund_reconciliation_states', 'list_finance_disputes',
                                'list_finance_checkout_exceptions', 'list_finance_refund_entitlement_mismatches')) = 4
      and has_function_privilege('service_role', 'public.list_finance_disputes(boolean, timestamptz, uuid, integer)', 'EXECUTE')
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry the ALL-TXN-CURRENCY-4 functions" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: four helpers, two caller-scoped RPCs (authenticated only), four finance RPCs each widened by trailing currency_state/currency, one overload each, service_role kept"
  fi
done

# The exact resulting ACLs of the changed functions, printed rather
# than only asserted: a measured fact for a reviewer to read.
for db in "$DB_A" "$DB_B"; do
  psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select '  measured [$db]: ' || p.proname || ' ' || coalesce(p.proacl::text, '<default>')
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname like '%currenc%' or p.proname in ('list_refund_reconciliation_states',
            'list_finance_disputes', 'list_finance_checkout_exceptions', 'list_finance_refund_entitlement_mismatches'))
     order by p.proname" 2>/dev/null
done

# ============================================================
# Part 2: the migration applied over POPULATED data.
#
#   (a) this migration writes no row: every financial table is
#       byte-identical after it;
#   (b) each finance RPC, called as a finance admin, returns the SAME
#       rows in the SAME order after the migration as before, compared
#       on the columns it returned before (read from the base catalog,
#       not typed here). The new trailing columns are printed as a
#       measured fact.
# ============================================================
awk '/^insert into auth\.users/{on=1} /^-- Fingerprint of every table/{on=0} on' "$FIXTURE_SOURCE" > "$WORKDIR/rows.sql"
if ! grep -q "insert into public.refund_requests" "$WORKDIR/rows.sql" || ! grep -q "insert into public.payment_disputes" "$WORKDIR/rows.sql"; then
  echo "FAIL: could not extract the fixture from $FIXTURE_SOURCE" >&2
  exit 1
fi

cat > "$WORKDIR/fingerprint.sql" <<'FINGERPRINT'
select 'purchases:' || md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) || ':' || count(*) from public.purchases t
union all
select 'payments:' || md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) || ':' || count(*) from public.payments t
union all
select 'book_checkout_intents:' || md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) || ':' || count(*) from public.book_checkout_intents t
union all
select 'bundle_checkout_snapshots:' || md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) || ':' || count(*) from public.bundle_checkout_snapshots t
union all
select 'refund_requests:' || md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) || ':' || count(*) from public.refund_requests t
union all
select 'refund_request_items:' || md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) || ':' || count(*) from public.refund_request_items t
union all
select 'payment_disputes:' || md5(coalesce(string_agg(row_to_json(t)::text, ',' order by t.id), '')) || ':' || count(*) from public.payment_disputes t
union all
select 'author_ledger_entries:' || count(*) from public.author_ledger_entries;
FINGERPRINT

run_file() {
  local db="$1" file="$2" out="$3" err="$4" rc
  set +e
  psql -X -q -t -A -F '|' -d "$db" -v ON_ERROR_STOP=1 -f "$file" > "$out" 2> "$err"
  rc=$?
  set -e
  return $rc
}

echo "  building C: ${BASE_REF:0:9}:$SCHEMA_PATH + the 065 fixture, then the migration"
build "$DB_C" "$STUB" "$WORKDIR/base_schema.sql" "$WORKDIR/rows.sql"

# The finance RPCs' ORIGINAL result columns, read from the base catalog.
base_columns() {
  psql -X -q -t -A -d "$DB_C" -v ON_ERROR_STOP=1 -c "
    select string_agg('t.' || quote_ident(a.name), ', ' order by a.ord)
      from pg_catalog.pg_proc p,
           unnest(p.proargnames, p.proargmodes::text[]) with ordinality as a(name, mode, ord)
     where p.pronamespace = 'public'::regnamespace and p.proname = '$1' and a.mode = 't'"
}
COLS_RECON="$(base_columns list_refund_reconciliation_states)"
COLS_DISPUTES="$(base_columns list_finance_disputes)"
COLS_EXCEPTIONS="$(base_columns list_finance_checkout_exceptions)"
COLS_MISMATCHES="$(base_columns list_finance_refund_entitlement_mismatches)"
for cols in "$COLS_RECON" "$COLS_DISPUTES" "$COLS_EXCEPTIONS" "$COLS_MISMATCHES"; do
  if [ -z "$cols" ] || printf '%s' "$cols" | grep -q currency_state; then
    echo "FAIL: could not read the base result columns of a finance RPC (got '$cols')" >&2
    exit 1
  fi
done

# Every call a finance page makes, plus the filters and a cursor page.
# One statement per call, as the finance admin of the fixture.
cat > "$WORKDIR/calls.sql" <<CALLS
begin;
select set_config('request.jwt.claim.sub', 'e0650000-0000-0000-0000-000000000005', true) is not null as _;
set local role authenticated;
select 'recon_all|' || row($COLS_RECON)::text from public.list_refund_reconciliation_states(p_limit => 100) t;
select 'recon_requested|' || row($COLS_RECON)::text from public.list_refund_reconciliation_states(p_operational_state => 'requested', p_limit => 100) t;
select 'recon_attention|' || row($COLS_RECON)::text from public.list_refund_reconciliation_states(p_needs_attention => true, p_limit => 100) t;
select 'recon_page2|' || row($COLS_RECON)::text from public.list_refund_reconciliation_states(p_cursor_requested_at => '2026-09-15T00:00:00Z', p_cursor_id => 'e0651000-0000-0000-0000-000000000015', p_limit => 2) t;
select 'recon_limit1|' || row($COLS_RECON)::text from public.list_refund_reconciliation_states(p_limit => 1) t;
select 'disputes_all|' || row($COLS_DISPUTES)::text from public.list_finance_disputes(p_limit => 100) t;
select 'disputes_attention|' || row($COLS_DISPUTES)::text from public.list_finance_disputes(p_needs_attention => true, p_limit => 100) t;
select 'disputes_page2|' || row($COLS_DISPUTES)::text from public.list_finance_disputes(p_cursor_created_at => '2026-09-22T00:00:00Z', p_cursor_id => 'e0651100-0000-0000-0000-000000000002', p_limit => 100) t;
select 'exceptions_all|' || row($COLS_EXCEPTIONS)::text from public.list_finance_checkout_exceptions(p_limit => 100) t;
select 'exceptions_limit1|' || row($COLS_EXCEPTIONS)::text from public.list_finance_checkout_exceptions(p_limit => 1) t;
select 'mismatches_all|' || row($COLS_MISMATCHES)::text from public.list_finance_refund_entitlement_mismatches(p_limit => 100) t;
select 'mismatches_limit2|' || row($COLS_MISMATCHES)::text from public.list_finance_refund_entitlement_mismatches(p_limit => 2) t;
rollback;
CALLS

cat > "$WORKDIR/currencies.sql" <<'CURRENCIES'
begin;
select set_config('request.jwt.claim.sub', 'e0650000-0000-0000-0000-000000000005', true) is not null as _;
set local role authenticated;
select 'recon|' || refund_request_id || '|' || currency_state || '|' || coalesce(currency, '-') from public.list_refund_reconciliation_states(p_limit => 100);
select 'dispute|' || id || '|' || currency_state || '|' || coalesce(currency, '-') from public.list_finance_disputes(p_limit => 100);
select 'exception|' || intent_id || '|' || currency_state || '|' || coalesce(currency, '-') from public.list_finance_checkout_exceptions(p_limit => 100);
select 'mismatch|' || mismatch_type || '|' || refund_request_id || '|' || currency_state || '|' || coalesce(currency, '-') from public.list_finance_refund_entitlement_mismatches(p_limit => 100);
rollback;
CURRENCIES

SECTIONS=$((SECTIONS + 1))
STEP_RC=0
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/before.out" "$WORKDIR/before.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/calls.sql" "$WORKDIR/calls_before.out" "$WORKDIR/calls_before.err" || STEP_RC=1
run_file "$DB_C" "$MIGRATION" "$WORKDIR/migrate.out" "$WORKDIR/migrate.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after.out" "$WORKDIR/after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/calls.sql" "$WORKDIR/calls_after.out" "$WORKDIR/calls_after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/currencies.sql" "$WORKDIR/currencies.out" "$WORKDIR/currencies.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after_again.out" "$WORKDIR/after_again.err" || STEP_RC=1

if [ "$STEP_RC" -ne 0 ] || [ -s "$WORKDIR/before.err" ] || [ -s "$WORKDIR/after.err" ] \
   || [ -s "$WORKDIR/calls_before.err" ] || [ -s "$WORKDIR/calls_after.err" ] || [ -s "$WORKDIR/migrate.err" ] \
   || [ -s "$WORKDIR/currencies.err" ] || [ -s "$WORKDIR/after_again.err" ]; then
  echo "FAIL [populated_migration]: a step errored or wrote to stderr" >&2
  tail -n 5 "$WORKDIR"/*.err >&2 || true
  FAILURES=$((FAILURES + 1))
# author_ledger_entries is counted, not hashed: it is empty by design
# here, and must stay empty (no read may post to the ledger).
elif [ ! -s "$WORKDIR/before.out" ] || grep -Eq ':[0-9a-f]{32}:0$' "$WORKDIR/before.out"; then
  echo "FAIL [populated_migration]: a fixture table is empty -- this comparison would pass vacuously" >&2
  cat "$WORKDIR/before.out" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/after.out" || ! cmp -s "$WORKDIR/after.out" "$WORKDIR/after_again.out"; then
  echo "FAIL [populated_migration]: the migration or a read changed existing rows" >&2
  diff "$WORKDIR/before.out" "$WORKDIR/after.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated_migration]: every financial table is byte-identical after the migration and after every read ($(wc -l < "$WORKDIR/before.out" | tr -d ' ') tables fingerprinted)"
fi

SECTIONS=$((SECTIONS + 1))
grep '|' "$WORKDIR/calls_before.out" > "$WORKDIR/calls_before.rows" || true
grep '|' "$WORKDIR/calls_after.out" > "$WORKDIR/calls_after.rows" || true
MISSING_LABELS=""
for label in recon_all recon_requested recon_page2 recon_limit1 disputes_all disputes_attention disputes_page2 exceptions_all exceptions_limit1 mismatches_all mismatches_limit2; do
  if ! grep -q "^${label}|" "$WORKDIR/calls_before.rows"; then MISSING_LABELS="$MISSING_LABELS $label"; fi
done
if [ -n "$MISSING_LABELS" ]; then
  echo "FAIL [finance_rows_unchanged]: these calls returned no rows before the migration, so they would compare vacuously:$MISSING_LABELS" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/calls_before.rows" "$WORKDIR/calls_after.rows"; then
  echo "FAIL [finance_rows_unchanged]: a finance RPC returned different rows or a different order after the migration" >&2
  diff "$WORKDIR/calls_before.rows" "$WORKDIR/calls_after.rows" | head -n 40 >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [finance_rows_unchanged]: $(wc -l < "$WORKDIR/calls_before.rows" | tr -d ' ') rows across 12 finance calls (filters, cursors, limits) identical in content and order before and after"
fi

SECTIONS=$((SECTIONS + 1))
EXPECT_CURRENCIES="recon|e0651000-0000-0000-0000-000000000017|conflict|-
recon|e0651000-0000-0000-0000-000000000016|resolved|ALL
recon|e0651000-0000-0000-0000-000000000015|resolved|USD
recon|e0651000-0000-0000-0000-000000000014|conflict|-
recon|e0651000-0000-0000-0000-000000000013|unknown|-
recon|e0651000-0000-0000-0000-000000000012|resolved|ALL
recon|e0651000-0000-0000-0000-000000000011|resolved|USD
dispute|e0651100-0000-0000-0000-000000000002|resolved|ALL
dispute|e0651100-0000-0000-0000-000000000001|resolved|USD
dispute|e0651100-0000-0000-0000-000000000003|unknown|-
exception|e0650e00-0000-0000-0000-0000000000e1|resolved|ALL
exception|e0650e00-0000-0000-0000-0000000000e2|resolved|USD"
GOT_CURRENCIES="$(grep -E '^(recon|dispute|exception)\|' "$WORKDIR/currencies.out" || true)"
if [ "$GOT_CURRENCIES" != "$EXPECT_CURRENCIES" ]; then
  echo "FAIL [currency_columns]: the new columns do not carry each row's own currency" >&2
  diff <(printf '%s\n' "$EXPECT_CURRENCIES") <(printf '%s\n' "$GOT_CURRENCIES") >&2 || true
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [currency_columns]: every reconciliation, dispute and exception row carries its own transaction's currency (resolved USD, resolved ALL, unknown, conflict)"
  grep '^mismatch|' "$WORKDIR/currencies.out" | sed 's/^/    measured: /'
fi

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 065_all_transaction_currency_provenance_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 065_all_transaction_currency_provenance_catalog_equivalence.sh -- $SECTIONS sections identical between $PATCHED_LABEL and ${BASE_REF:0:9} + migration, none empty"
