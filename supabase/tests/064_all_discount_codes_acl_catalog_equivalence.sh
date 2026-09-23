#!/usr/bin/env bash
# ALL-DISCOUNT-3: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema plus
# supabase/migrations/20260923112502_all_discount_codes_acl.sql describe
# the same database -- across every catalog that can differ, not just
# "does the grant exist".
#
# Modelled on 063_all_search_books_price_all_catalog_equivalence.sh; its
# generic machinery (schema resolution, the non-vacuous compare(), every
# catalog section) is carried over unchanged. This repository has two
# build paths -- a fresh environment is created from schema.sql,
# staging is migrated -- and nothing else compares them.
#
# Why the risk is concrete in THIS change. It is an ACL-only migration,
# and ACLs are exactly where the two paths are built differently:
#
#   * path A creates the table fresh and then issues `revoke all`,
#     `grant select, delete`, `grant insert (cols)` and
#     `grant update (active)`;
#   * path B starts from the base's table-level `grant select, insert,
#     delete` and must arrive at the same place by REVOKING. Revoking a
#     table-level privilege also removes that role's column-level
#     privileges of the same type, so a migration that forgot to
#     re-grant `update (active)` would build cleanly and silently break
#     toggleDiscountCode on staging only. The column_acls section sees
#     that.
#   * a surviving table-level INSERT on path B would make the column
#     grant decorative: amount_off_cents writable on staging, closed on
#     a fresh build. The table_acls section, and the per-role effective
#     privileges below, see that.
#
# Every section must ALSO be non-vacuous: each requires a non-zero row
# count on BOTH sides, a zero exit status from psql, and empty stderr,
# and stderr is captured separately from the compared stdout.
#
# Beyond equivalence, part 2 applies the migration over a POPULATED base
# and proves it rewrites no row, while measuring the one intended
# behaviour change: an authenticated author's raw amount_off_cents
# INSERT succeeds before and is refused after.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer --
# schema.sql uses the MAINTAIN privilege):
#
#   ./supabase/tests/064_all_discount_codes_acl_catalog_equivalence.sh
#
# Overrides: BASE_REF, MIGRATION, STUB, SCHEMA_PATH, MARKER, and either
# SCHEMA (an explicit patched-schema file) or PATCHED_REF (an explicit
# patched-schema commit). Exits non-zero on any difference, any empty
# section, any non-zero psql exit, or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against: origin/staging at the time, the merge of PR #23.
BASE_REF="${BASE_REF:-76d3cba0aa5fc5545e775710fd3b916d30ab846a}"
MIGRATION="${MIGRATION:-supabase/migrations/20260923112502_all_discount_codes_acl.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-ALL-DISCOUNT-3}"
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
DB_A="librum_all_discount_a_${SUFFIX}"
DB_B="librum_all_discount_b_${SUFFIX}"
DB_C="librum_all_discount_c_${SUFFIX}"
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

# The base must actually carry the OLD table-level INSERT, or "the hole
# is closed" is being proved against a database that never had it.
if ! grep -q '^grant select, insert, delete$' "$WORKDIR/base_schema.sql"; then
  echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} does not carry the table-level 'grant select, insert, delete' on discount_codes -- wrong base" >&2
  exit 1
fi
if ! grep -q '^grant update (active)$' "$WORKDIR/base_schema.sql"; then
  echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} does not carry 'grant update (active)' -- wrong base" >&2
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

# Function sections: this migration touches no function, and these
# prove that -- signatures, defaults, bodies, security and ACLs are the
# same on both paths.
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

# Function ACLs. Unchanged by this migration; compared anyway.
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
compare discount_codes_effective_column_privileges "
select role_name, a.attname, priv,
       case
         when role_name = 'public'
           or exists (select 1 from pg_catalog.pg_roles r where r.rolname = role_name)
         then has_column_privilege(role_name, 'public.discount_codes', a.attname, priv)::text
         else '<no such role>'
       end
  from unnest(array['public','anon','authenticated','service_role','postgres']::text[]) as role_name
 cross join unnest(array['SELECT','INSERT','UPDATE','REFERENCES']::text[]) as priv
 cross join pg_catalog.pg_attribute a
 where a.attrelid = 'public.discount_codes'::regclass and a.attnum > 0 and not a.attisdropped
 order by role_name, a.attname, priv"

compare discount_codes_effective_table_privileges "
select role_name, priv,
       case
         when role_name = 'public'
           or exists (select 1 from pg_catalog.pg_roles r where r.rolname = role_name)
         then has_table_privilege(role_name, 'public.discount_codes', priv)::text
         else '<no such role>'
       end
  from unnest(array['public','anon','authenticated','service_role','postgres']::text[]) as role_name
 cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']::text[]) as priv
 order by role_name, priv"

# ============================================================
# Beyond equivalence: the two databases must AGREE ON A DATABASE THAT
# CARRIES THE CHANGE, not on two copies of the base.
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      -- the legacy column is unwritable by every client-facing role
      not has_column_privilege('authenticated', 'public.discount_codes', 'amount_off_cents', 'INSERT')
      and not has_column_privilege('authenticated', 'public.discount_codes', 'amount_off_cents', 'UPDATE')
      and not has_column_privilege('anon', 'public.discount_codes', 'amount_off_cents', 'INSERT')
      and not has_column_privilege('public', 'public.discount_codes', 'amount_off_cents', 'INSERT')
      -- no table-level INSERT or UPDATE survives for authenticated
      and not has_table_privilege('authenticated', 'public.discount_codes', 'INSERT')
      and not has_table_privilege('authenticated', 'public.discount_codes', 'UPDATE')
      -- the supported creation columns are insertable
      and has_column_privilege('authenticated', 'public.discount_codes', 'percent_off', 'INSERT')
      and has_column_privilege('authenticated', 'public.discount_codes', 'amount_off_all', 'INSERT')
      and has_column_privilege('authenticated', 'public.discount_codes', 'id', 'INSERT')
      -- UPDATE is still exactly active
      and has_column_privilege('authenticated', 'public.discount_codes', 'active', 'UPDATE')
      and not has_column_privilege('authenticated', 'public.discount_codes', 'amount_off_all', 'UPDATE')
      -- SELECT and DELETE unchanged
      and has_table_privilege('authenticated', 'public.discount_codes', 'SELECT')
      and has_table_privilege('authenticated', 'public.discount_codes', 'DELETE')
      -- service_role not narrowed
      and has_table_privilege('service_role', 'public.discount_codes', 'INSERT')
      and has_column_privilege('service_role', 'public.discount_codes', 'amount_off_cents', 'UPDATE')
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry the ALL-DISCOUNT-3 discount_codes ACL" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: amount_off_cents unwritable by public/anon/authenticated, column INSERT on the create path, update(active) kept, service_role intact"
  fi
done

# The exact resulting table and column ACLs, printed rather than only
# asserted: a measured fact for a reviewer to read. Equivalence itself
# is claimed by the sections above, not by these lines.
for db in "$DB_A" "$DB_B"; do
  ACL="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select coalesce(c.relacl::text, '<default>') from pg_catalog.pg_class c
     where c.oid = 'public.discount_codes'::regclass" 2>/dev/null)"
  COLACL="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select string_agg(a.attname || '=' || a.attacl::text, ' ' order by a.attnum)
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.discount_codes'::regclass and a.attacl is not null" 2>/dev/null)"
  echo "  measured [$db]: relacl=$ACL"
  echo "  measured [$db]: attacl=$COLACL"
done

# ============================================================
# Part 2: the migration applied over POPULATED data.
#
#   (a) this migration writes no row: every pre-existing discount code
#       (legacy USD, percentage and ALL) is byte-identical after it;
#   (b) applying it is NOT behaviour-free, and the harness measures the
#       intended change: an authenticated author's raw amount_off_cents
#       INSERT succeeds against the base and is refused after, while
#       their percentage and ALL inserts and their `active` update work
#       on both sides. The probes run inside a transaction that is
#       rolled back, and a fingerprint after each proves they left
#       nothing behind.
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0640f00-0000-0000-0000-000000000001', 'p064-harness-author@test', now(),
   '{"role":"author","display_name":"P064 Harness Author"}');

update public.profiles set role = 'author'
  where id = 'e0640f00-0000-0000-0000-000000000001';

insert into public.books (id, author_id, title, status, price_all) values
  ('e0640f01-0000-0000-0000-000000000001', 'e0640f00-0000-0000-0000-000000000001',
   'P064 Harness Book', 'published', 500);

insert into public.discount_codes (id, author_id, book_id, code, percent_off, amount_off_cents, amount_off_all, active, expires_at) values
  ('e0640f02-0000-0000-0000-000000000001', 'e0640f00-0000-0000-0000-000000000001',
   'e0640f01-0000-0000-0000-000000000001', 'P064H-USD', null, 500, null, true, null),
  ('e0640f02-0000-0000-0000-000000000002', 'e0640f00-0000-0000-0000-000000000001',
   'e0640f01-0000-0000-0000-000000000001', 'P064H-PCT', 25, null, null, false, '2030-01-01T00:00:00Z'),
  ('e0640f02-0000-0000-0000-000000000003', 'e0640f00-0000-0000-0000-000000000001',
   'e0640f01-0000-0000-0000-000000000001', 'P064H-ALL', null, null, 150, true, null);
FIXTURES

cat > "$WORKDIR/fingerprint.sql" <<'FINGERPRINT'
select 'discount_codes:' || coalesce(string_agg(row_to_json(d)::text, ',' order by d.id), '<none>')
  from public.discount_codes d
union all
select 'books:' || coalesce(string_agg(b.id::text || ':' || b.status || ':' || coalesce(b.price_all::text, '-'), ',' order by b.id), '<none>')
  from public.books b;
FINGERPRINT

# One probe per statement, as the author, all rolled back. Each prints
# '<label>=OK' or '<label>=<sqlstate>'.
cat > "$WORKDIR/probe.sql" <<'PROBE'
begin;
create function pg_temp.probe(p_label text, p_sql text) returns text language plpgsql as $$
declare v_state text;
begin
  perform set_config('request.jwt.claim.sub', 'e0640f00-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    execute p_sql;
    v_state := 'OK';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  reset role;
  return p_label || '=' || v_state;
end $$;
select pg_temp.probe('insert_cents', $q$insert into public.discount_codes (author_id, book_id, code, amount_off_cents) values ('e0640f00-0000-0000-0000-000000000001', 'e0640f01-0000-0000-0000-000000000001', 'P064H-NEW-USD', 700)$q$);
select pg_temp.probe('update_cents', $q$update public.discount_codes set amount_off_cents = 1 where id = 'e0640f02-0000-0000-0000-000000000001'$q$);
select pg_temp.probe('insert_percent', $q$insert into public.discount_codes (id, author_id, book_id, code, percent_off, expires_at) values (gen_random_uuid(), 'e0640f00-0000-0000-0000-000000000001', 'e0640f01-0000-0000-0000-000000000001', 'P064H-NEW-PCT', 10, null)$q$);
select pg_temp.probe('insert_all', $q$insert into public.discount_codes (id, author_id, book_id, code, amount_off_all, expires_at) values (gen_random_uuid(), 'e0640f00-0000-0000-0000-000000000001', 'e0640f01-0000-0000-0000-000000000001', 'P064H-NEW-ALL', 10, null)$q$);
select pg_temp.probe('update_active', $q$update public.discount_codes set active = false where id = 'e0640f02-0000-0000-0000-000000000003'$q$);
rollback;
PROBE

run_file() {
  local db="$1" file="$2" out="$3" err="$4" rc
  set +e
  psql -X -q -t -A -F '|' -d "$db" -v ON_ERROR_STOP=1 -f "$file" > "$out" 2> "$err"
  rc=$?
  set -e
  return $rc
}

echo "  building C: ${BASE_REF:0:9}:$SCHEMA_PATH + rows, then the migration"
build "$DB_C" "$STUB" "$WORKDIR/base_schema.sql" "$WORKDIR/rows.sql"

SECTIONS=$((SECTIONS + 1))
STEP_RC=0
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/before.out" "$WORKDIR/before.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/probe.sql" "$WORKDIR/probe_before.out" "$WORKDIR/probe_before.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/before_again.out" "$WORKDIR/before_again.err" || STEP_RC=1
run_file "$DB_C" "$MIGRATION" "$WORKDIR/migrate.out" "$WORKDIR/migrate.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after.out" "$WORKDIR/after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/probe.sql" "$WORKDIR/probe_after.out" "$WORKDIR/probe_after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after_again.out" "$WORKDIR/after_again.err" || STEP_RC=1

if [ "$STEP_RC" -ne 0 ] || [ -s "$WORKDIR/before.err" ] || [ -s "$WORKDIR/after.err" ] \
   || [ -s "$WORKDIR/probe_before.err" ] || [ -s "$WORKDIR/probe_after.err" ] || [ -s "$WORKDIR/migrate.err" ] \
   || [ -s "$WORKDIR/before_again.err" ] || [ -s "$WORKDIR/after_again.err" ]; then
  echo "FAIL [populated_migration]: a step errored or wrote to stderr" >&2
  tail -n 5 "$WORKDIR"/*.err >&2 || true
  FAILURES=$((FAILURES + 1))
elif [ ! -s "$WORKDIR/before.out" ] || grep -q '<none>' "$WORKDIR/before.out"; then
  echo "FAIL [populated_migration]: the fixture inserted nothing -- this comparison would pass vacuously" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/after.out"; then
  echo "FAIL [populated_migration]: the migration changed existing rows" >&2
  diff "$WORKDIR/before.out" "$WORKDIR/after.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/before_again.out" || ! cmp -s "$WORKDIR/after.out" "$WORKDIR/after_again.out"; then
  echo "FAIL [populated_migration]: a rolled-back probe left a change behind" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated_migration]: the three pre-existing discount codes (legacy USD, percentage, ALL) and the book are byte-identical after the migration; the probes left nothing behind"
fi

SECTIONS=$((SECTIONS + 1))
PB="$(grep '=' "$WORKDIR/probe_before.out" | tr '\n' ' ' || true)"
PA="$(grep '=' "$WORKDIR/probe_after.out" | tr '\n' ' ' || true)"
EXPECT_BEFORE="insert_cents=OK update_cents=42501 insert_percent=OK insert_all=OK update_active=OK "
EXPECT_AFTER="insert_cents=42501 update_cents=42501 insert_percent=OK insert_all=OK update_active=OK "
if [ "$PB" != "$EXPECT_BEFORE" ]; then
  echo "FAIL [rollout_effect]: the BASE did not behave as expected, so there is no change to measure" >&2
  echo "  before='$PB' expected='$EXPECT_BEFORE'" >&2
  FAILURES=$((FAILURES + 1))
elif [ "$PA" != "$EXPECT_AFTER" ]; then
  echo "FAIL [rollout_effect]: after the migration: '$PA' expected '$EXPECT_AFTER'" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [rollout_effect]: an author's raw amount_off_cents INSERT succeeds BEFORE and is refused AFTER; percentage and ALL inserts and the active update work throughout"
  echo "    measured: before=[$PB] after=[$PA]"
fi

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 064_all_discount_codes_acl_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 064_all_discount_codes_acl_catalog_equivalence.sh -- $SECTIONS catalog sections identical between $PATCHED_LABEL and ${BASE_REF:0:9} + migration, none empty"
