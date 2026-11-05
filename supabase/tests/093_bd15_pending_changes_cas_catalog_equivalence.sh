#!/usr/bin/env bash
# BD15 P5b-3b: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema (56c839c6) plus
# supabase/migrations/20261105120000_bd15_pending_changes_cas.sql
# describe the same database -- across every catalog that can differ --
# that the migration over POPULATED data changes no stored value (the
# waiting rows already there get version 1), that both databases carry
# the change as intended, that two first saves at the same moment never
# overwrite each other (the second is refused, LB496), that a takedown
# while a discard is held open waits and succeeds (audit P5b-1 r2, R2-1),
# and that the rollback (093_bd15_pending_changes_cas.rollback.sql), run
# twice, leaves every catalog section identical to a fresh build of the
# base schema.
#
# Modelled on 092_bd15_live_pending_changes_catalog_equivalence.sh; its
# generic machinery (schema resolution, the non-vacuous compare(), every
# catalog section) is carried over unchanged.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer):
#
#   ./supabase/tests/093_bd15_pending_changes_cas_catalog_equivalence.sh
#
# Overrides: BASE_REF, BASE_SCHEMA, MIGRATION, ROLLBACK, STUB,
# SCHEMA_PATH, MARKER, and either SCHEMA (an explicit patched-schema
# file) or PATCHED_REF (an explicit patched-schema commit). Exits
# non-zero on any difference, any empty section, any non-zero psql exit,
# or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against (staging after PR #162, P5b-3a).
BASE_REF="${BASE_REF:-56c839c697d360d1f9b0f3b86fdc4851e48fd6e0}"
MIGRATION="${MIGRATION:-supabase/migrations/20261105120000_bd15_pending_changes_cas.sql}"
ROLLBACK="${ROLLBACK:-supabase/tests/093_bd15_pending_changes_cas.rollback.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-BD15 P5b-3b}"
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
DB_A="librum_sq093_a_${SUFFIX}"
DB_B="librum_sq093_b_${SUFFIX}"
DB_C="librum_sq093_c_${SUFFIX}"
DB_D="librum_sq093_d_${SUFFIX}"
WORKDIR="$(mktemp -d)"

cleanup() {
  # By name, not through DB_A/DB_B: the rollback comparison reuses those.
  dropdb --if-exists "librum_sq093_a_${SUFFIX}" >/dev/null 2>&1 || true
  dropdb --if-exists "librum_sq093_b_${SUFFIX}" >/dev/null 2>&1 || true
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

# The base must carry BD15 P5b-1 (the waiting changes) and no version.
if ! grep -q "create table public.book_pending_changes" "$WORKDIR/base_schema.sql" \
   || grep -q "book_pending_changes_set_version" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: the base schema is not the 56c839c6 base (BD15 P5b-1 waiting changes, no version) -- wrong base" >&2
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
# The tables the new triggers sit on, book_reviews, and the new table
# while it exists (not in the rolled-back comparison).
for tbl in $PRIV_TABLES; do
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

PRIV_TABLES="books book_contributors book_ai_disclosures book_rights_declarations book_reviews book_pending_changes"
catalog_sections

# ============================================================
# Beyond equivalence: both databases CARRY THE CHANGE as intended.
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      to_regprocedure('public.save_book_pending_changes(uuid,uuid,text,text,text,boolean,text)') is null
      and to_regprocedure('public.discard_book_pending_changes(uuid,uuid)') is null
      and pg_catalog.pg_get_functiondef('public.save_book_pending_changes(uuid,uuid,bigint,text,text,text,boolean,text)'::regprocedure) like '%LB496%'
      and pg_catalog.pg_get_functiondef('public.discard_book_pending_changes(uuid,uuid,bigint)'::regprocedure) like '%LB496%'
      and (select prosecdef and proconfig = array['search_path=\"\"'] and prorettype = 'bigint'::regtype
             from pg_catalog.pg_proc
            where oid = 'public.save_book_pending_changes(uuid,uuid,bigint,text,text,text,boolean,text)'::regprocedure)
      and has_function_privilege('service_role', 'public.save_book_pending_changes(uuid,uuid,bigint,text,text,text,boolean,text)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.save_book_pending_changes(uuid,uuid,bigint,text,text,text,boolean,text)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.save_book_pending_changes(uuid,uuid,bigint,text,text,text,boolean,text)', 'EXECUTE')
      and has_function_privilege('service_role', 'public.discard_book_pending_changes(uuid,uuid,bigint)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.discard_book_pending_changes(uuid,uuid,bigint)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.book_pending_changes_set_version()', 'EXECUTE')
      and not has_function_privilege('service_role', 'public.book_pending_changes_set_version()', 'EXECUTE')
      and (select attnotnull from pg_catalog.pg_attribute
            where attrelid = 'public.book_pending_changes'::regclass and attname = 'version')
      and pg_catalog.pg_get_triggerdef((select oid from pg_catalog.pg_trigger where tgname = 'book_pending_changes_set_version'))
          like '%BEFORE INSERT OR UPDATE%'
      and has_table_privilege('service_role', 'public.book_pending_changes', 'SELECT')
      and not has_table_privilege('service_role', 'public.book_pending_changes', 'UPDATE')
      and pg_catalog.pg_get_functiondef('public.book_pending_changes_set_version()'::regprocedure)
          like '%nextval(''public.book_pending_changes_version_seq'')%'
      and not has_sequence_privilege('service_role', 'public.book_pending_changes_version_seq', 'USAGE')
      and not has_sequence_privilege('authenticated', 'public.book_pending_changes_version_seq', 'USAGE')
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry BD15 P5b-3b as intended" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: old save/discard forms gone; the compare-and-set forms (LB496) for service_role only; the version column, its trigger and its owner-only sequence present"
  fi
done

psql -X -q -d "$DB_A" -v ON_ERROR_STOP=1 > /dev/null 2> "$WORKDIR/race_fix.err" <<'RACEFIX'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0938000-0000-4000-8000-00000000000a', 'r093-a@test', now(), '{"role":"author","display_name":"R093 Ana"}'),
  ('e0938000-0000-4000-8000-0000000000c1', 'r093-s@test', now(), '{"role":"reader","display_name":"R093 Staff"}');
insert into public.staff_members (user_id, role) values ('e0938000-0000-4000-8000-0000000000c1', 'owner');
insert into public.books (id, author_id, title, description, status, price_all, published_at, file_path, cover_path) values
  ('e0938001-0000-4000-8000-000000000001', 'e0938000-0000-4000-8000-00000000000a', 'R093 first saves', 'D.', 'published', 0, now(),
   'v1.epub', 'e0938009-0000-4000-8000-000000000001/cover.jpg'),
  ('e0938001-0000-4000-8000-000000000002', 'e0938000-0000-4000-8000-00000000000a', 'R093 discard', 'D.', 'published', 0, now(),
   'v1.epub', 'e0938009-0000-4000-8000-000000000002/cover.jpg');
set role service_role;
select public.save_book_pending_changes('e0938000-0000-4000-8000-00000000000a', 'e0938001-0000-4000-8000-000000000002', null,
  'v2.epub', 'e0938009-0000-4000-8000-000000000012/cover.jpg', 'Waiting.', false, null);
RACEFIX

# ============================================================
# Two sessions, two first saves: the second waits for the first's row
# and is refused (LB496); the row keeps the first save.
# ============================================================
SECTIONS=$((SECTIONS + 1))
psql -X -q -d "$DB_A" -v ON_ERROR_STOP=1 > "$WORKDIR/race_s1.out" 2> "$WORKDIR/race_s1.err" <<'S1' &
begin;
set local role service_role;
select public.save_book_pending_changes('e0938000-0000-4000-8000-00000000000a', 'e0938001-0000-4000-8000-000000000001', null,
  'v2.epub', 'e0938009-0000-4000-8000-000000000021/cover.jpg', 'First.', false, null);
select pg_sleep(3);
commit;
S1
S1_PID=$!
sleep 1
RACE_OUT="$(psql -X -q -t -A -d "$DB_A" -c "
  set role service_role;
  do \$\$ begin
    perform public.save_book_pending_changes('e0938000-0000-4000-8000-00000000000a', 'e0938001-0000-4000-8000-000000000001', null,
      'v3.epub', 'e0938009-0000-4000-8000-000000000022/cover.jpg', 'Second.', false, null);
    raise notice 'accepted';
  exception when sqlstate 'LB496' then raise notice 'refused';
  end \$\$;" 2>&1)"
wait "$S1_PID" || true
ROW="$(psql -X -q -t -A -d "$DB_A" -c "select description from public.book_pending_changes where book_id = 'e0938001-0000-4000-8000-000000000001'")"
if [ -s "$WORKDIR/race_fix.err" ] || [ -s "$WORKDIR/race_s1.err" ] \
   || ! printf '%s' "$RACE_OUT" | grep -q 'NOTICE:  refused' || [ "$ROW" != "First." ]; then
  echo "FAIL [first_save_race]: two first saves were not serialised" >&2
  cat "$WORKDIR/race_fix.err" "$WORKDIR/race_s1.err" >&2 || true
  printf '%s\n' "$RACE_OUT" "row after: $ROW" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [first_save_race]: the second first save waited for the first and was refused (LB496); the row is the first's"
fi

# ============================================================
# Audit P5b-1 r2, R2-1: a discard held open, then a staff takedown of
# the same book: the takedown waits (the discard holds the book FOR
# SHARE) and succeeds, never a deadlock; the row is gone.
# ============================================================
SECTIONS=$((SECTIONS + 1))
psql -X -q -d "$DB_A" -v ON_ERROR_STOP=1 > "$WORKDIR/disc_s1.out" 2> "$WORKDIR/disc_s1.err" <<'S1' &
begin;
set local role service_role;
select public.discard_book_pending_changes('e0938000-0000-4000-8000-00000000000a', 'e0938001-0000-4000-8000-000000000002',
  (select c.version from public.book_pending_changes c where c.book_id = 'e0938001-0000-4000-8000-000000000002'));
select pg_sleep(3);
commit;
S1
S1_PID=$!
sleep 1
TAKEDOWN_OUT="$(psql -X -q -t -A -d "$DB_A" -c "
  set role authenticated;
  select set_config('request.jwt.claim.sub', 'e0938000-0000-4000-8000-0000000000c1', false);
  select (public.admin_unpublish_book('e0938001-0000-4000-8000-000000000002', 'copyright', 'A complaint.') is not null)::text;" 2>&1)"
wait "$S1_PID" || true
AFTER="$(psql -X -q -t -A -d "$DB_A" -c "
  select (select status from public.books where id = 'e0938001-0000-4000-8000-000000000002') || ':'
      || (select count(*) from public.book_pending_changes where book_id = 'e0938001-0000-4000-8000-000000000002')")"
if [ -s "$WORKDIR/disc_s1.err" ] || ! printf '%s' "$TAKEDOWN_OUT" | grep -qx 'true' \
   || [ "$AFTER" != "draft:0" ]; then
  echo "FAIL [discard_takedown]: the takedown beside a discard in flight did not succeed cleanly" >&2
  cat "$WORKDIR/disc_s1.err" >&2 || true
  printf '%s\n' "$TAKEDOWN_OUT" "after: $AFTER" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [discard_takedown]: the takedown waited for the discard and succeeded; the book is offline, no row left"
fi

# ============================================================
# Part 2: the migration over POPULATED base data, then the rollback.
#   A live book with waiting changes, a live book without, a draft.
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0939000-0000-4000-8000-00000000000a', 'q093-a@test', now(), '{"role":"author","display_name":"Q093 Ana"}');
insert into public.books (id, author_id, title, description, status, price_all, published_at, file_path, cover_path) values
  ('e0939001-0000-4000-8000-000000000001', 'e0939000-0000-4000-8000-00000000000a', 'Q093 live waiting', 'Live.', 'published', 0, now(),
   'v1.epub', 'e0939009-0000-4000-8000-000000000001/cover.jpg'),
  ('e0939001-0000-4000-8000-000000000002', 'e0939000-0000-4000-8000-00000000000a', 'Q093 live', 'Live two.', 'published', 0, now(),
   'v1.epub', 'e0939009-0000-4000-8000-000000000002/cover.jpg'),
  ('e0939001-0000-4000-8000-000000000003', 'e0939000-0000-4000-8000-00000000000a', 'Q093 draft', 'Draft.', 'draft', 0, null,
   'v1.epub', 'e0939009-0000-4000-8000-000000000003/cover.jpg');
set role service_role;
select public.save_book_pending_changes('e0939000-0000-4000-8000-00000000000a', 'e0939001-0000-4000-8000-000000000001',
  'v2.epub', 'e0939009-0000-4000-8000-000000000011/cover.jpg', 'Waiting text.', true, null);
reset role;
FIXTURES

# Every stored value except the new version column (absent before the
# migration and after the rollback); the version is checked on its own.
cat > "$WORKDIR/fingerprint.sql" <<'FINGERPRINT'
select 'books', coalesce(string_agg(to_jsonb(t)::text, ';' order by t.id), '<none>') from public.books t;
select 'book_pending_changes', coalesce(string_agg((to_jsonb(t) - 'version')::text, ';' order by t.book_id), '<none>') from public.book_pending_changes t;
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
  echo "  ok [populated]: the migration changed no stored value outside the new version column (a live book with waiting changes among the rows)"
fi

# The waiting row already there is version 1, and the change holds on it:
# a stale save is refused, the right one goes to 2. In a transaction that
# is rolled back, so the rollback check below sees the rows as migrated.
SECTIONS=$((SECTIONS + 1))
LIVE="$(psql -X -q -t -A -d "$DB_C" -v ON_ERROR_STOP=1 -c "begin;" -c "
  select version::text from public.book_pending_changes where book_id = 'e0939001-0000-4000-8000-000000000001'" -c "
  set role service_role;" -c "
  do \$\$ begin
    perform public.save_book_pending_changes('e0939000-0000-4000-8000-00000000000a', 'e0939001-0000-4000-8000-000000000001', null,
      'v2.epub', 'e0939009-0000-4000-8000-000000000011/cover.jpg', 'Stale.', true, null);
    raise exception 'not refused';
  exception when sqlstate 'LB496' then null;
  end \$\$;" -c "
  select public.save_book_pending_changes('e0939000-0000-4000-8000-00000000000a', 'e0939001-0000-4000-8000-000000000001', 1,
      'v2.epub', 'e0939009-0000-4000-8000-000000000011/cover.jpg', 'Waiting text.', true, null)::text" -c "rollback;" 2> "$WORKDIR/live.err")"
if [ -s "$WORKDIR/live.err" ] || [ "$(printf '%s' "$LIVE" | tr '\n' ' ')" != "1 2" ]; then
  echo "FAIL [change_live]: the change does not hold on the migrated populated database: $LIVE" >&2
  cat "$WORKDIR/live.err" >&2 || true
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [change_live]: the existing waiting row is version 1; a stale save is refused (LB496), the right one takes the sequence's first number (2)"
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
  diff "$WORKDIR/before.out" "$WORKDIR/rolled_back.out" | head -n 10 >&2 || true
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
  echo "FAIL: 093_bd15_pending_changes_cas_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 093_bd15_pending_changes_cas_catalog_equivalence.sh -- $SECTIONS sections: catalog identical between $PATCHED_LABEL and the base + migration, none empty; both carry the change; two first saves and a discard beside a takedown are serialised; the migration changes no stored value; after the rollback the catalog is identical to the base"
