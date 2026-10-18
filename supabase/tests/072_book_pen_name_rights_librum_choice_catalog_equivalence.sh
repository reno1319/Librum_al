#!/usr/bin/env bash
# BOOK-PEN-NAME-RIGHTS-CHOICE-1 (fix step F3): proves that a database
# built from the PATCHED supabase/schema.sql and one built from the BASE
# schema plus
# supabase/migrations/20261018074425_book_pen_name_rights_librum_choice.sql
# describe the same database -- across every catalog that can differ.
#
# Modelled on 067_catalog_storage_path_authorization_catalog_equivalence.sh;
# its generic machinery (schema resolution, the non-vacuous compare(),
# every catalog section) is carried over unchanged.
#
# Why the risk is concrete in THIS change. Path A declares pen_name and
# librum_choice_at inside `create table public.books`; path B adds them
# with `alter table ... add column`. Column order, the named check, the
# partial unique index, and the new table's ACL (path A inherits the
# platform's ambient grants before the reset, exactly like path B) must
# all come out identical. The columns, constraints, indexes, ACL and
# effective-privilege sections see any drift.
#
# Every section must ALSO be non-vacuous: each requires a non-zero row
# count on BOTH sides, a zero exit status from psql, and empty stderr.
#
# Part 2 applies the migration over a POPULATED base and proves (a) it
# rewrites no existing row (every pre-existing column of every book is
# byte-identical and both new columns are null), (b) nothing outside the
# new objects changes (every relation, column, function and schema ACL,
# every policy, RLS flag and books default), and (c) the intended
# behaviour change, measured with rollback-only probes: before, the new
# column, table and functions do not exist (42703 / 42P01 / 42883);
# after, an author still cannot write the new columns or the table
# (42501) and the service role cannot delete a record (42501) while it
# can record and pick, and the author's
# ordinary draft insert works throughout.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer, because
# schema.sql uses the MAINTAIN privilege):
#
#   ./supabase/tests/072_book_pen_name_rights_librum_choice_catalog_equivalence.sh
#
# Overrides: BASE_REF, BASE_SCHEMA, MIGRATION, STUB, SCHEMA_PATH, MARKER,
# and either SCHEMA (an explicit patched-schema file) or PATCHED_REF (an
# explicit patched-schema commit). On an older server the effective
# table-privilege sections leave MAINTAIN out (it does not exist there).
# Exits non-zero on any difference, any empty section, any non-zero psql
# exit, or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against: origin/staging at the time, the merge of PR #48.
BASE_REF="${BASE_REF:-c5788fea3737c777ec846bd26678dce346669756}"
MIGRATION="${MIGRATION:-supabase/migrations/20261018074425_book_pen_name_rights_librum_choice.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-BOOK-PEN-NAME-RIGHTS-CHOICE-1}"
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
DB_A="librum_f3_a_${SUFFIX}"
DB_B="librum_f3_b_${SUFFIX}"
DB_C="librum_f3_c_${SUFFIX}"
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

# The base must not already have any of the new objects.
if grep -Eq 'pen_name|librum_choice|book_rights_declarations' "$WORKDIR/base_schema.sql"; then
  echo "FAIL: the base schema already mentions pen_name, librum_choice or book_rights_declarations -- wrong base" >&2
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

# Function sections: the migration adds three functions; signatures,
# defaults, bodies, security and ACLs must be the same on both paths.
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

# Function ACLs (the two writers are service_role-only).
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
for tbl in books book_rights_declarations; do
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
# Beyond equivalence: the two databases must AGREE ON A DATABASE THAT
# CARRIES THE CHANGE, not on two copies of the base.
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      -- the new books columns: readable, never client-writable
      has_column_privilege('anon', 'public.books', 'pen_name', 'SELECT')
      and has_column_privilege('anon', 'public.books', 'librum_choice_at', 'SELECT')
      and not has_column_privilege('authenticated', 'public.books', 'pen_name', 'INSERT')
      and not has_column_privilege('authenticated', 'public.books', 'pen_name', 'UPDATE')
      and not has_column_privilege('authenticated', 'public.books', 'librum_choice_at', 'INSERT')
      and not has_column_privilege('authenticated', 'public.books', 'librum_choice_at', 'UPDATE')
      and not has_any_column_privilege('anon', 'public.books', 'INSERT, UPDATE')
      -- the books grants this change must not touch
      and has_column_privilege('authenticated', 'public.books', 'title', 'INSERT')
      and has_column_privilege('authenticated', 'public.books', 'series_id', 'UPDATE')
      and has_table_privilege('authenticated', 'public.books', 'SELECT, DELETE')
      -- declarations: authenticated reads, nobody client-facing writes
      and has_table_privilege('authenticated', 'public.book_rights_declarations', 'SELECT')
      and not has_table_privilege('authenticated', 'public.book_rights_declarations', 'INSERT')
      and not has_table_privilege('authenticated', 'public.book_rights_declarations', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.book_rights_declarations', 'DELETE')
      and not has_table_privilege('anon', 'public.book_rights_declarations', 'SELECT')
      and not has_any_column_privilege('anon', 'public.book_rights_declarations', 'SELECT, INSERT, UPDATE')
      and has_table_privilege('service_role', 'public.book_rights_declarations', 'SELECT, INSERT')
      -- service_role may read and insert only: it cannot destroy a record
      and not has_table_privilege('service_role', 'public.book_rights_declarations', 'UPDATE')
      and not has_table_privilege('service_role', 'public.book_rights_declarations', 'DELETE')
      and not has_table_privilege('service_role', 'public.book_rights_declarations', 'TRUNCATE')
      and (select relrowsecurity from pg_catalog.pg_class where oid = 'public.book_rights_declarations'::regclass)
      -- the pick writers: service_role only, invoker, empty search_path
      and not has_function_privilege('anon', 'public.set_librum_choice(uuid)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.set_librum_choice(uuid)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.clear_librum_choice()', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.clear_librum_choice()', 'EXECUTE')
      and has_function_privilege('service_role', 'public.set_librum_choice(uuid)', 'EXECUTE')
      and has_function_privilege('service_role', 'public.clear_librum_choice()', 'EXECUTE')
      and (select bool_and(not prosecdef and proconfig @> array['search_path=\"\"'])
             from pg_catalog.pg_proc
            where oid in ('public.set_librum_choice(uuid)'::regprocedure,
                          'public.clear_librum_choice()'::regprocedure,
                          'public.enforce_book_rights_declarations_append_only()'::regprocedure))
      -- the one-pick index and the append-only trigger exist
      and exists (select 1 from pg_catalog.pg_indexes where schemaname = 'public' and indexname = 'books_one_librum_choice'
                    and indexdef like 'CREATE UNIQUE INDEX%WHERE (librum_choice_at IS NOT NULL)')
      and exists (select 1 from pg_catalog.pg_trigger where tgrelid = 'public.book_rights_declarations'::regclass
                    and tgname = 'book_rights_declarations_enforce_append_only' and not tgisinternal)
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry BOOK-PEN-NAME-RIGHTS-CHOICE-1" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: new books columns readable and not client-writable, declarations closed to client writes with RLS and read/insert-only for service_role, pick writers service_role-only, index and trigger present"
  fi
done

# The exact resulting ACLs, printed rather than only asserted: a measured
# fact for a reviewer to read.
for db in "$DB_A" "$DB_B"; do
  ACL="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select coalesce(c.relacl::text, '<default>') from pg_catalog.pg_class c
     where c.oid = 'public.book_rights_declarations'::regclass" 2>/dev/null)"
  FNACL="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select string_agg(p.proname || '=' || coalesce(p.proacl::text, '<default>'), ' ' order by p.proname)
      from pg_catalog.pg_proc p
     where p.oid in ('public.set_librum_choice(uuid)'::regprocedure, 'public.clear_librum_choice()'::regprocedure)" 2>/dev/null)"
  echo "  measured [$db book_rights_declarations]: relacl=$ACL"
  echo "  measured [$db functions]: $FNACL"
done

# ============================================================
# Part 2: the migration applied over POPULATED data.
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0724f00-0000-4000-8000-00000000000a', 'p072-harness-a@test', now(), '{"role":"author","display_name":"P072 Harness A"}');

update public.profiles set role = 'author' where id = 'e0724f00-0000-4000-8000-00000000000a';

insert into public.books (id, author_id, title, status, price_all, price_cents, published_at, cover_path, file_path) values
  ('e0724f01-0000-4000-8000-000000000001', 'e0724f00-0000-4000-8000-00000000000a', 'P072H draft',     'draft',     199,  0,   null,
   'e0724f00-0000-4000-8000-00000000000a/e0724f01-0000-4000-8000-000000000001-cover.png', 'e0724f00-0000-4000-8000-00000000000a/e0724f01-0000-4000-8000-000000000001.epub'),
  ('e0724f01-0000-4000-8000-000000000002', 'e0724f00-0000-4000-8000-00000000000a', 'P072H published', 'published', 0,    0,   '2026-10-01T00:00:00Z', null, null),
  ('e0724f01-0000-4000-8000-000000000003', 'e0724f00-0000-4000-8000-00000000000a', 'P072H legacy',    'published', null, 799, '2026-08-01T00:00:00Z', 'covers/legacy.JPG', 'legacy/manuscript.epub');
FIXTURES

# Pre-existing columns only, so the before and after fingerprints are
# comparable; the new columns are checked separately (all null after).
cat > "$WORKDIR/fingerprint.sql" <<'FINGERPRINT'
select 'books:' || coalesce(string_agg(
         (pg_catalog.to_jsonb(b) - 'pen_name' - 'librum_choice_at')::text, ',' order by b.id), '<none>')
  from public.books b;
FINGERPRINT

cat > "$WORKDIR/newcols.sql" <<'NEWCOLS'
select 'newcols:' || count(*) || ':' || count(pen_name) || ':' || count(librum_choice_at) from public.books;
NEWCOLS

# Everything this migration must NOT change: every relation ACL, column
# ACL, function and schema ACL, every policy, RLS flag and books default,
# minus the objects the migration creates.
cat > "$WORKDIR/unrelated.sql" <<'UNRELATED'
select line from (
select 'rel:' || n.nspname || '.' || c.relname || '=' || coalesce(c.relacl::text, '<default>') as line
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_%'
   and c.relkind in ('r', 'v', 'm', 'S', 'p', 'f')
union all
select 'col:' || c.relname || '.' || a.attname || '=' || a.attacl::text
  from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and a.attacl is not null
union all
select 'fn:' || p.oid::regprocedure::text || '=' || coalesce(p.proacl::text, '<default>')
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public', 'auth', 'storage', 'extensions')
union all
select 'nsp:' || n.nspname || '=' || coalesce(n.nspacl::text, '<default>')
  from pg_catalog.pg_namespace n
 where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
union all
select 'pol:' || schemaname || '.' || tablename || '.' || policyname || '|' || permissive || '|'
       || coalesce(array_to_string(roles, ','), '') || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
  from pg_catalog.pg_policies
union all
select 'rls:' || c.relname || '=' || c.relrowsecurity::text || '/' || c.relforcerowsecurity::text
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
union all
select 'default:' || c.relname || '.' || a.attname || '=' || pg_catalog.pg_get_expr(d.adbin, d.adrelid)
  from pg_catalog.pg_attrdef d
  join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
  join pg_catalog.pg_class c on c.oid = d.adrelid
 where c.relname = 'books' and c.relnamespace = 'public'::regnamespace
) s
 where line !~ '(book_rights_declarations|set_librum_choice|clear_librum_choice)'
order by 1;
UNRELATED

# One probe per statement, all rolled back. Each prints '<label>=OK:<rows>'
# or '<label>=<sqlstate>'.
cat > "$WORKDIR/probe.sql" <<'PROBE'
begin;
create function pg_temp.probe(p_label text, p_role text, p_sql text) returns text language plpgsql as $$
declare v_state text; v_rows bigint;
begin
  perform set_config('request.jwt.claim.sub',
    case when p_role = 'authenticated' then 'e0724f00-0000-4000-8000-00000000000a' else '' end, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_state := 'OK:' || v_rows;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  reset role;
  return p_label || '=' || v_state;
end $$;
select pg_temp.probe('anon_read_pen_name', 'anon', $q$select pen_name from public.books where id = 'e0724f01-0000-4000-8000-000000000002'$q$);
select pg_temp.probe('author_insert_pen_name', 'authenticated', $q$insert into public.books (author_id, title, pen_name) values ('e0724f00-0000-4000-8000-00000000000a', 'x', 'Pen')$q$);
select pg_temp.probe('author_update_choice', 'authenticated', $q$update public.books set librum_choice_at = now() where id = 'e0724f01-0000-4000-8000-000000000002'$q$);
select pg_temp.probe('author_draft_insert', 'authenticated', $q$insert into public.books (id, author_id, title, price_all) values (gen_random_uuid(), 'e0724f00-0000-4000-8000-00000000000a', 'draft', 199)$q$);
select pg_temp.probe('author_insert_declaration', 'authenticated', $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text) values ('e0724f01-0000-4000-8000-000000000002', 'x', 'e0724f00-0000-4000-8000-00000000000a', 'x', 'own_rights', 'rights-v1', 'x')$q$);
select pg_temp.probe('service_insert_declaration', 'service_role', $q$insert into public.book_rights_declarations (book_id, book_title, author_id, author_public_name, basis, statement_version, statement_text) values ('e0724f01-0000-4000-8000-000000000002', 'P072H published', 'e0724f00-0000-4000-8000-00000000000a', 'P072 Harness A', 'own_rights', 'rights-v1', 'x')$q$);
select pg_temp.probe('service_delete_declaration', 'service_role', $q$delete from public.book_rights_declarations$q$);
select pg_temp.probe('service_set_pen_name', 'service_role', $q$update public.books set pen_name = 'Pen' where id = 'e0724f01-0000-4000-8000-000000000002'$q$);
select pg_temp.probe('service_set_choice', 'service_role', $q$select public.set_librum_choice('e0724f01-0000-4000-8000-000000000002')$q$);
select pg_temp.probe('service_clear_choice', 'service_role', $q$select public.clear_librum_choice()$q$);
select pg_temp.probe('author_set_choice', 'authenticated', $q$select public.set_librum_choice('e0724f01-0000-4000-8000-000000000002')$q$);
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

echo "  building C: base schema + rows, then the migration"
build "$DB_C" "$STUB" "$WORKDIR/base_schema.sql" "$WORKDIR/rows.sql"

SECTIONS=$((SECTIONS + 1))
STEP_RC=0
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/before.out" "$WORKDIR/before.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/unrelated.sql" "$WORKDIR/unrelated_before.out" "$WORKDIR/unrelated_before.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/probe.sql" "$WORKDIR/probe_before.out" "$WORKDIR/probe_before.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/before_again.out" "$WORKDIR/before_again.err" || STEP_RC=1
run_file "$DB_C" "$MIGRATION" "$WORKDIR/migrate.out" "$WORKDIR/migrate.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after.out" "$WORKDIR/after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/newcols.sql" "$WORKDIR/newcols.out" "$WORKDIR/newcols.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/unrelated.sql" "$WORKDIR/unrelated_after.out" "$WORKDIR/unrelated_after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/probe.sql" "$WORKDIR/probe_after.out" "$WORKDIR/probe_after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after_again.out" "$WORKDIR/after_again.err" || STEP_RC=1

ERRS=0
for e in before after newcols probe_before probe_after migrate before_again after_again unrelated_before unrelated_after; do
  [ -s "$WORKDIR/$e.err" ] && ERRS=1
done
if [ "$STEP_RC" -ne 0 ] || [ "$ERRS" -ne 0 ]; then
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
elif [ "$(cat "$WORKDIR/newcols.out")" != "newcols:3:0:0" ]; then
  echo "FAIL [populated_migration]: the new columns are not null on every existing row: $(cat "$WORKDIR/newcols.out")" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/before_again.out" || ! cmp -s "$WORKDIR/after.out" "$WORKDIR/after_again.out"; then
  echo "FAIL [populated_migration]: a rolled-back probe left a change behind" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated_migration]: the three books (draft, published, legacy) are byte-identical in every pre-existing column after the migration, both new columns are null on all of them, and the probes left nothing behind"
fi

SECTIONS=$((SECTIONS + 1))
UNRELATED_ROWS="$(wc -l < "$WORKDIR/unrelated_before.out" | tr -d ' ')"
if [ "$UNRELATED_ROWS" -lt 50 ] || ! grep -q '^pol:public.books.' "$WORKDIR/unrelated_before.out"; then
  echo "FAIL [no_unrelated_drift]: the unrelated-catalog snapshot is too small ($UNRELATED_ROWS rows) to mean anything" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/unrelated_before.out" "$WORKDIR/unrelated_after.out"; then
  echo "FAIL [no_unrelated_drift]: something outside the new objects changed" >&2
  diff "$WORKDIR/unrelated_before.out" "$WORKDIR/unrelated_after.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [no_unrelated_drift]: $UNRELATED_ROWS entries (every relation/column/function/schema ACL, every policy, RLS flags, books defaults) identical before and after, outside the new objects"
fi

SECTIONS=$((SECTIONS + 1))
PB="$(grep '=' "$WORKDIR/probe_before.out" | tr '\n' ' ' || true)"
PA="$(grep '=' "$WORKDIR/probe_after.out" | tr '\n' ' ' || true)"
EXPECT_BEFORE="anon_read_pen_name=42703 author_insert_pen_name=42703 author_update_choice=42703 author_draft_insert=OK:1 author_insert_declaration=42P01 service_insert_declaration=42P01 service_delete_declaration=42P01 service_set_pen_name=42703 service_set_choice=42883 service_clear_choice=42883 author_set_choice=42883 "
EXPECT_AFTER="anon_read_pen_name=OK:1 author_insert_pen_name=42501 author_update_choice=42501 author_draft_insert=OK:1 author_insert_declaration=42501 service_insert_declaration=OK:1 service_delete_declaration=42501 service_set_pen_name=OK:1 service_set_choice=OK:1 service_clear_choice=OK:1 author_set_choice=42501 "
if [ "$PB" != "$EXPECT_BEFORE" ]; then
  echo "FAIL [rollout_effect]: the BASE did not behave as expected, so there is no change to measure" >&2
  echo "  before='$PB' expected='$EXPECT_BEFORE'" >&2
  FAILURES=$((FAILURES + 1))
elif [ "$PA" != "$EXPECT_AFTER" ]; then
  echo "FAIL [rollout_effect]: after the migration: '$PA' expected '$EXPECT_AFTER'" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [rollout_effect]: before, the new column/table/functions do not exist (42703/42P01/42883, the codes the application treats as feature off); after, authors still cannot write them and the service role cannot delete records (42501) while it records and picks; the ordinary draft insert works throughout"
  echo "    measured: before=[$PB]"
  echo "    measured: after=[$PA]"
fi

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 072_book_pen_name_rights_librum_choice_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 072_book_pen_name_rights_librum_choice_catalog_equivalence.sh -- $SECTIONS catalog sections identical between $PATCHED_LABEL and the base + migration, none empty"
