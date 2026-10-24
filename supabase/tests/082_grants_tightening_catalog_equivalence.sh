#!/usr/bin/env bash
# SECURITY-9B: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema (3c949f0) plus
# supabase/migrations/20261024200000_grants_tightening.sql describe the
# same database -- across every catalog that can differ, default
# privileges included -- and that the migration over POPULATED data
# changes no row.
#
# Modelled on 080_book_downloads_catalog_equivalence.sh; its generic
# machinery (schema resolution, the non-vacuous compare(), every
# catalog section) is carried over unchanged, with the effective-
# privilege sections pointed at the five tables whose grants change.
# Added: pg_default_acl compared on both paths, and a REBUILD check:
# the patched schema built with and without the platform's old
# function default (00 stub) gives identical function privileges, so a
# rebuild no longer depends on that default.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer, because
# schema.sql uses the MAINTAIN privilege; on 16 pass stripped copies via
# BASE_SCHEMA, SCHEMA, MIGRATION and STUB). Connect as postgres: the
# migration sets postgres's own default privileges.
#
#   ./supabase/tests/082_grants_tightening_catalog_equivalence.sh
#
# Overrides: BASE_REF, BASE_SCHEMA, MIGRATION, STUB, SCHEMA_PATH, MARKER,
# and either SCHEMA (an explicit patched-schema file) or PATCHED_REF (an
# explicit patched-schema commit). Exits non-zero on any difference, any
# empty section, any non-zero psql exit, or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against (staging after item 7, PR #82). If SECURITY-9A
# (migration 20261024190000) lands on staging first, this becomes the
# commit 9B is rebased onto.
BASE_REF="${BASE_REF:-3c949f037a9c9ccf41e18826f362dc54532d5008}"
MIGRATION="${MIGRATION:-supabase/migrations/20261024200000_grants_tightening.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-SECURITY-9B}"
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
DB_A="librum_sec9b_a_${SUFFIX}"
DB_B="librum_sec9b_b_${SUFFIX}"
DB_C="librum_sec9b_c_${SUFFIX}"
WORKDIR="$(mktemp -d)"

cleanup() {
  dropdb --if-exists "$DB_A" >/dev/null 2>&1 || true
  dropdb --if-exists "$DB_B" >/dev/null 2>&1 || true
  dropdb --if-exists "$DB_C" >/dev/null 2>&1 || true
  dropdb --if-exists "${DB_C}_d" >/dev/null 2>&1 || true
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

# The base must carry DOWNLOADS-1 (book_downloads) and GRANTS-1's
# full anon grants on wishlist_items.
if ! grep -q "create table public.book_downloads" "$WORKDIR/base_schema.sql" \
   || ! grep -q "^-- anon: kept exactly as today; RLS is on for all four and decides" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: the base schema is not the 3c949f0 base (book_downloads, GRANTS-1 anon grants) -- wrong base" >&2
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

# Function sections: the four trigger functions, the four RPCs and the
# restated staff_has_permission(), author_payout_eligibility() and
# list_admin_audit_events() -- definition, security and ACL must be
# identical.
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
for tbl in wishlist_items book_reports book_views bundle_checkout_reservations bundle_checkout_reader_holds; do
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
# Default privileges, both paths (the public-only sections above do
# not read pg_default_acl).
# ============================================================
compare default_acls "
select o.t, coalesce((select d.defaclacl::text
                        from pg_catalog.pg_default_acl d
                       where d.defaclrole = 'postgres'::regrole
                         and d.defaclnamespace = 'public'::regnamespace
                         and d.defaclobjtype = o.t), '<none>')
  from unnest(array['r','S','f','T','n']::\"char\"[]) as o(t)
 order by 1"

# ============================================================
# Beyond equivalence: both databases CARRY THE CHANGE.
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      not has_table_privilege('anon', 'public.wishlist_items', 'SELECT')
      and not has_table_privilege('anon', 'public.book_reports', 'INSERT')
      and not has_table_privilege('authenticated', 'public.wishlist_items', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.book_views', 'INSERT')
      and not has_table_privilege('authenticated', 'public.bundle_checkout_reservations', 'SELECT')
      and has_table_privilege('authenticated', 'public.wishlist_items', 'SELECT, INSERT, DELETE')
      and has_function_privilege('service_role', 'public.user_owns_book(uuid)', 'EXECUTE')
      and not has_function_privilege('service_role', 'public.payment_intent_has_lost_dispute(text)', 'EXECUTE')
      and not exists (select 1 from pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) a
                       where d.defaclrole = 'postgres'::regrole
                         and d.defaclnamespace = 'public'::regnamespace
                         and a.grantee in ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole))
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry SECURITY-9B" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: five tables narrowed, service_role function grants explicit, postgres defaults closed"
  fi
done

# ============================================================
# Rebuild check: the patched schema built WITHOUT the platform's old
# function default gives the same function privileges as with it.
# ============================================================
grep -v '^alter default privileges in schema public grant execute on functions' "$STUB" > "$WORKDIR/stub_nofn.sql"
if cmp -s "$STUB" "$WORKDIR/stub_nofn.sql"; then
  echo "FAIL [rebuild]: the stub does not model the platform's function default" >&2
  FAILURES=$((FAILURES + 1))
else
  DB_D="${DB_C}_d"
  build "$DB_D" "$WORKDIR/stub_nofn.sql" "$PATCHED_FILE"
  FN_SQL="
select p.oid::regprocedure::text, r, has_function_privilege(r, p.oid, 'EXECUTE')::text
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 cross join unnest(array['public','anon','authenticated','service_role']::text[]) as r
 where n.nspname = 'public'
   and not exists (select 1 from pg_catalog.pg_depend d where d.objid = p.oid and d.deptype = 'e')
 order by 1, 2"
  SECTIONS=$((SECTIONS + 1))
  set +e
  psql -X -q -t -A -F '|' -d "$DB_A" -v ON_ERROR_STOP=1 -c "$FN_SQL" > "$WORKDIR/fn_with.out" 2> "$WORKDIR/fn_with.err"
  psql -X -q -t -A -F '|' -d "$DB_D" -v ON_ERROR_STOP=1 -c "$FN_SQL" > "$WORKDIR/fn_without.out" 2> "$WORKDIR/fn_without.err"
  set -e
  if [ -s "$WORKDIR/fn_with.err" ] || [ -s "$WORKDIR/fn_without.err" ] || [ ! -s "$WORKDIR/fn_with.out" ] \
     || ! cmp -s "$WORKDIR/fn_with.out" "$WORKDIR/fn_without.out"; then
    echo "FAIL [rebuild]: function privileges depend on the platform's function default" >&2
    diff "$WORKDIR/fn_with.out" "$WORKDIR/fn_without.out" | head -n 20 >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [rebuild]: $(wc -l < "$WORKDIR/fn_with.out" | tr -d ' ') function privilege rows identical with and without the old function default"
  fi
  dropdb --if-exists "$DB_D" >/dev/null 2>&1 || true
fi

# ============================================================
# Part 2: the migration over POPULATED base data, then the old-code
# paths and the new functions, all rolled back.
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0828000-0000-4000-8000-00000000000a', 'q082-a@test', now(), '{"role":"author","display_name":"Q082 Ana"}'),
  ('e0828000-0000-4000-8000-0000000000a1', 'q082-r@test', now(), '{"role":"reader","display_name":"Q082 Reader"}');
insert into public.books (id, author_id, title, description, status, price_all, published_at, file_path) values
  ('e0828001-0000-4000-8000-0000000000b1', 'e0828000-0000-4000-8000-00000000000a', 'Q082 Live', 'x', 'published', 0, now(),
   'e0828000-0000-4000-8000-00000000000a/e0828001-0000-4000-8000-0000000000b1.epub');
insert into public.wishlist_items (reader_id, book_id) values
  ('e0828000-0000-4000-8000-0000000000a1', 'e0828001-0000-4000-8000-0000000000b1');
insert into public.book_reports (book_id, reporter_id, reason) values
  ('e0828001-0000-4000-8000-0000000000b1', 'e0828000-0000-4000-8000-0000000000a1', 'other');
insert into public.book_views (book_id) values ('e0828001-0000-4000-8000-0000000000b1');
FIXTURES

# The five tables whose grants change, as an ordered text dump.
cat > "$WORKDIR/fingerprint.sql" <<'FINGERPRINT'
select 'wishlist_items', coalesce(string_agg(t::text, ';' order by t.id), '<none>') from public.wishlist_items t;
select 'book_reports', coalesce(string_agg(t::text, ';' order by t.id), '<none>') from public.book_reports t;
select 'book_views', coalesce(string_agg(t::text, ';' order by t.id), '<none>') from public.book_views t;
select 'books', coalesce(string_agg(t::text, ';' order by t.id), '<none>') from public.books t;
FINGERPRINT

# What the application does after the migration. Rolled back.
cat > "$WORKDIR/oldcode.sql" <<'OLDCODE'
begin;
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare v_state text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate;
  return v_state;
end;
$$;
grant execute on function pg_temp.try(text) to public;
create function pg_temp.check(p_ok boolean, p_label text) returns text language sql as $$
  select case when p_ok then 'ok ' else 'BAD ' end || p_label
$$;
create temp table probe (label text, result text);
grant all on probe to public;
do $$ begin perform set_config('request.jwt.claim.sub', 'e0828000-0000-4000-8000-0000000000a1', true); end $$;
set local role authenticated;
insert into probe select 'wish_read', pg_temp.try($q$select 1 from public.wishlist_items$q$);
insert into probe select 'wish_delete', pg_temp.try($q$delete from public.wishlist_items where reader_id = 'e0828000-0000-4000-8000-0000000000a1'$q$);
insert into probe select 'wish_add', pg_temp.try($q$insert into public.wishlist_items (reader_id, book_id) values ('e0828000-0000-4000-8000-0000000000a1', 'e0828001-0000-4000-8000-0000000000b1')$q$);
insert into probe select 'report', pg_temp.try($q$insert into public.book_reports (book_id, reporter_id, reason) values ('e0828001-0000-4000-8000-0000000000b1', 'e0828000-0000-4000-8000-0000000000a1', 'other')$q$);
insert into probe select 'wish_update', pg_temp.try($q$update public.wishlist_items set book_id = book_id$q$);
reset role;
set local role anon;
insert into probe select 'anon_wish', pg_temp.try($q$select 1 from public.wishlist_items$q$);
reset role;
set local role service_role;
insert into probe select 'svc_view', pg_temp.try($q$insert into public.book_views (book_id) values ('e0828001-0000-4000-8000-0000000000b1')$q$);
insert into probe select 'svc_public_books', pg_temp.try($q$select 1 from public.public_books$q$);
reset role;
select pg_temp.check((select bool_and(result = 'OK') from probe where label in ('wish_read', 'wish_delete', 'wish_add', 'report')),
  'reader_wishlist_and_report_work');
select pg_temp.check((select result = '42501' from probe where label = 'wish_update'), 'reader_update_refused');
select pg_temp.check((select result = '42501' from probe where label = 'anon_wish'), 'anon_refused');
select pg_temp.check((select result = 'OK' from probe where label = 'svc_view'), 'service_role_records_a_view');
select pg_temp.check((select result = 'OK' from probe where label = 'svc_public_books'), 'service_role_reads_public_books');
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
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/before.out" "$WORKDIR/before.err" || STEP_RC=1
run_file "$DB_C" "$MIGRATION" "$WORKDIR/migrate.out" "$WORKDIR/migrate.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after.out" "$WORKDIR/after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/oldcode.sql" "$WORKDIR/oldcode.out" "$WORKDIR/oldcode.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after_again.out" "$WORKDIR/after_again.err" || STEP_RC=1

ERRS=0
for e in before migrate after oldcode after_again; do
  [ -s "$WORKDIR/$e.err" ] && ERRS=1
done
if [ "$STEP_RC" -ne 0 ] || [ "$ERRS" -ne 0 ]; then
  echo "FAIL [populated_migration]: a step errored or wrote to stderr" >&2
  tail -n 5 "$WORKDIR"/*.err >&2 || true
  FAILURES=$((FAILURES + 1))
elif [ ! -s "$WORKDIR/before.out" ] || grep -q '<none>' "$WORKDIR/before.out"; then
  echo "FAIL [populated_migration]: the fixture left a fingerprinted table or view empty" >&2
  grep '<none>' "$WORKDIR/before.out" >&2 || true
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/after.out" \
     || ! cmp -s "$WORKDIR/after.out" "$WORKDIR/after_again.out"; then
  echo "FAIL [populated_migration]: an existing row or a view's rows changed (or a probe left a change)" >&2
  diff "$WORKDIR/before.out" "$WORKDIR/after.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated_migration]: $(wc -l < "$WORKDIR/before.out" | tr -d ' ') fingerprints (the five tables, books) byte-identical; rolled-back probes left nothing"
fi

SECTIONS=$((SECTIONS + 1))
if [ ! -s "$WORKDIR/oldcode.out" ] || grep -q '^BAD ' "$WORKDIR/oldcode.out" || [ "$(grep -c '^ok ' "$WORKDIR/oldcode.out")" -ne 5 ]; then
  echo "FAIL [oldcode]:" >&2
  cat "$WORKDIR/oldcode.out" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [oldcode]: $(grep -c '^ok ' "$WORKDIR/oldcode.out") checks -- $(grep '^ok ' "$WORKDIR/oldcode.out" | sed 's/^ok //' | tr '\n' ' ')"
fi

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 082_grants_tightening_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 082_grants_tightening_catalog_equivalence.sh -- $SECTIONS sections: catalog identical between $PATCHED_LABEL and the base + migration, none empty; populated-data and old-code checks pass"
