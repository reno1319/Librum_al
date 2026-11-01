#!/usr/bin/env bash
# BD3-P4: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema (93232509) plus
# supabase/migrations/20261101170000_bd3_original_author.sql describe
# the same database -- across every catalog that can differ -- that the
# migration over POPULATED data changes no existing value and keeps an
# existing approval valid, that the new column's CHECK and the search
# behave as intended, and that the rollback
# (087_bd3_original_author.rollback.sql) puts search_books() and the
# review functions, trigger and 3-argument approval function back byte
# for byte while keeping the columns and their values.
#
# Modelled on 086_bd3_rights_public_domain_original_catalog_equivalence.sh;
# its generic machinery (schema resolution, the non-vacuous compare(),
# every catalog section) is carried over unchanged, with the
# effective-privilege sections pointed at books and public_books.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer, because
# schema.sql uses the MAINTAIN privilege; on 16 pass stripped copies via
# BASE_SCHEMA, SCHEMA, MIGRATION and STUB):
#
#   ./supabase/tests/087_bd3_original_author_catalog_equivalence.sh
#
# Overrides: BASE_REF, BASE_SCHEMA, MIGRATION, ROLLBACK, STUB,
# SCHEMA_PATH, MARKER, and either SCHEMA (an explicit patched-schema
# file) or PATCHED_REF (an explicit patched-schema commit). Exits
# non-zero on any difference, any empty section, any non-zero psql exit,
# or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against (staging after PR #140).
BASE_REF="${BASE_REF:-93232509fe907579fa781d47dc09560c40da8ade}"
MIGRATION="${MIGRATION:-supabase/migrations/20261101170000_bd3_original_author.sql}"
ROLLBACK="${ROLLBACK:-supabase/tests/087_bd3_original_author.rollback.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-BD3-P4}"
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
DB_A="librum_sqorigauth_a_${SUFFIX}"
DB_B="librum_sqorigauth_b_${SUFFIX}"
DB_C="librum_sqorigauth_c_${SUFFIX}"
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

# The base must carry BD3-P3 (the previous migration) and no
# original_author anywhere.
if ! grep -q "BD3-P3" "$WORKDIR/base_schema.sql" \
   || grep -q "original_author" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: the base schema is not the 93232509 base (BD3-P3, no original_author) -- wrong base" >&2
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

# Function sections: every public function, the two new ones included
# -- definition, security and ACL must be identical.
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
# share one cluster, so that value is identical between them. The new
# column must carry exactly what books' other columns carry: anon
# nothing, authenticated SELECT only (UPDATE stays on series_id and
# series_position), service_role everything; on public_books, SELECT.
# book_reviews (r2): its new snapshot column carries what the unlisted
# columns carry -- authenticated reads only the eight listed ones.
for tbl in books public_books book_reviews; do
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
# Beyond equivalence: both databases CARRY THE CHANGE, and the new
# column's privileges are the intended ones (not merely equal).
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      (select a.attnum = (select max(a2.attnum) from pg_catalog.pg_attribute a2
                           where a2.attrelid = 'public.books'::regclass and a2.attnum > 0 and not a2.attisdropped)
         from pg_catalog.pg_attribute a
        where a.attrelid = 'public.books'::regclass and a.attname = 'original_author' and not a.attisdropped)
      and exists (select 1 from pg_catalog.pg_constraint
                   where conrelid = 'public.books'::regclass and conname = 'books_original_author_check')
      and (select a.attnum = (select max(a2.attnum) from pg_catalog.pg_attribute a2
                               where a2.attrelid = 'public.public_books'::regclass and a2.attnum > 0)
             from pg_catalog.pg_attribute a
            where a.attrelid = 'public.public_books'::regclass and a.attname = 'original_author')
      and (select p.prosrc like '%books.original_author%' from pg_catalog.pg_proc p
            where p.oid = 'public.search_books(text,text,integer,integer,integer)'::regprocedure)
      and not has_column_privilege('anon', 'public.books', 'original_author', 'SELECT')
      and has_column_privilege('authenticated', 'public.books', 'original_author', 'SELECT')
      and not has_column_privilege('authenticated', 'public.books', 'original_author', 'UPDATE')
      and not has_column_privilege('authenticated', 'public.books', 'original_author', 'INSERT')
      and has_column_privilege('anon', 'public.public_books', 'original_author', 'SELECT')
      and not has_table_privilege('anon', 'public.public_books', 'UPDATE')
      and (select c.reloptions::text like '%security_barrier%' from pg_catalog.pg_class c
            where c.oid = 'public.public_books'::regclass)
      -- r2: the review approval binds to the original author.
      and (select a.attnum = (select max(a2.attnum) from pg_catalog.pg_attribute a2
                               where a2.attrelid = 'public.book_reviews'::regclass and a2.attnum > 0 and not a2.attisdropped)
             from pg_catalog.pg_attribute a
            where a.attrelid = 'public.book_reviews'::regclass and a.attname = 'original_author' and not a.attisdropped)
      and not has_column_privilege('authenticated', 'public.book_reviews', 'original_author', 'SELECT')
      and has_column_privilege('service_role', 'public.book_reviews', 'original_author', 'SELECT')
      and to_regprocedure('public.book_review_approval_valid(uuid,text,text)') is null
      and not has_function_privilege('anon', 'public.book_review_approval_valid(uuid,text,text,text)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.book_review_approval_valid(uuid,text,text,text)', 'EXECUTE')
      and not has_function_privilege('service_role', 'public.book_review_approval_valid(uuid,text,text,text)', 'EXECUTE')
      and (select bool_and(p.prosrc like '%original_author%') from pg_catalog.pg_proc p
            where p.oid in ('public.book_review_approval_valid(uuid,text,text,text)'::regprocedure,
                            'public.books_require_review_approval()'::regprocedure,
                            'public.books_refuse_live_file_change()'::regprocedure,
                            'public.request_book_review(uuid)'::regprocedure,
                            'public.book_review_state(uuid)'::regprocedure,
                            'public.admin_approve_book_review(uuid,text,text,integer,jsonb)'::regprocedure))
      and (select pg_catalog.pg_get_triggerdef(t.oid) like '%BEFORE UPDATE OF file_path, cover_path, original_author ON public.books%'
             from pg_catalog.pg_trigger t where t.tgname = 'books_refuse_live_file_change')
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry BD3-P4 as intended" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: books.original_author last + named CHECK, public_books last column (security_barrier), search_books reads it, privileges as intended; book_reviews.original_author last (not readable by authors), 4-argument approval only (internal), the five review functions read it, live-files trigger fires on it"
  fi
done

# ============================================================
# Part 2: the migration over POPULATED base data, the new rules (rolled
# back), then the rollback.
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0878000-0000-4000-8000-00000000000a', 'q087-a@test', now(), '{"role":"author","display_name":"Q087 Author"}');
insert into public.books (id, author_id, title, description, keywords, genre, status, price_all, published_at) values
  ('e0878001-0000-4000-8000-000000000001', 'e0878000-0000-4000-8000-00000000000a', 'Q087 Ana Karenina', 'roman', '', 'Romancë', 'published', 0, now()),
  ('e0878001-0000-4000-8000-000000000002', 'e0878000-0000-4000-8000-00000000000a', 'Q087 Draft', 'x', '', 'Poezi', 'draft', 0, null);
-- r2: the live book's files and the approval it went live on, and a
-- pending review of the draft.
-- (A live book's files change only with a move to draft, LB463.)
update public.books
   set file_path = 'e0878000-0000-4000-8000-00000000000a/e0878001-0000-4000-8000-000000000001.epub',
       cover_path = 'e087c0de-0000-4000-8000-000000000001/cover.jpg',
       status = 'draft'
 where id = 'e0878001-0000-4000-8000-000000000001';
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, status, grandfathered, decided_at)
select id, title, author_id, file_path, cover_path, 'approved', true, now()
  from public.books where id = 'e0878001-0000-4000-8000-000000000001';
update public.books set status = 'published' where id = 'e0878001-0000-4000-8000-000000000001';
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, status)
select id, title, author_id, file_path, cover_path, 'pending'
  from public.books where id = 'e0878001-0000-4000-8000-000000000002';
FIXTURES

# Every books column that existed before, as an ordered text dump: the
# migration changes no existing value. original_author is reported
# separately (all null).
cat > "$WORKDIR/fingerprint.sql" <<'FINGERPRINT'
select 'books', coalesce(string_agg((to_jsonb(t) - 'original_author')::text, ';' order by t.id), '<none>') from public.books t;
select 'book_reviews', coalesce(string_agg((to_jsonb(r) - 'original_author')::text, ';' order by r.id), '<none>') from public.book_reviews r;
FINGERPRINT

cat > "$WORKDIR/all_null.sql" <<'ALLNULL'
select count(*) filter (where original_author is not null)::text || '/' || count(*)::text from public.books;
select count(*) filter (where original_author is not null)::text || '/' || count(*)::text from public.book_reviews;
ALLNULL

# r2: the live book's approval, valid before the migration (3 arguments)
# and after it (4 arguments, null original author).
cat > "$WORKDIR/approval_before.sql" <<'APPRB'
select public.book_review_approval_valid(b.id, b.file_path, b.cover_path)::text
  from public.books b where b.id = 'e0878001-0000-4000-8000-000000000001';
APPRB
cat > "$WORKDIR/approval_after.sql" <<'APPRA'
select public.book_review_approval_valid(b.id, b.file_path, b.cover_path, b.original_author)::text
  from public.books b where b.id = 'e0878001-0000-4000-8000-000000000001';
APPRA

# r2: the review functions, the 3-/4-argument approval functions and the
# live-files trigger, as one fingerprint (body md5, ACL, definer) -- the
# rollback must give back exactly the base's.
cat > "$WORKDIR/review_src.sql" <<'REVIEWSRC'
select p.oid::regprocedure::text || ' ' || pg_catalog.md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '<default>')
       || ' ' || p.prosecdef::text || ' ' || coalesce(p.proconfig::text, '<none>')
  from pg_catalog.pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('book_review_approval_valid', 'books_require_review_approval', 'books_refuse_live_file_change',
                     'request_book_review', 'book_review_state', 'admin_approve_book_review')
 order by 1;
select pg_catalog.pg_get_triggerdef(t.oid) from pg_catalog.pg_trigger t
 where t.tgrelid = 'public.books'::regclass and t.tgname in ('books_refuse_live_file_change', 'books_require_review_approval')
 order by t.tgname;
REVIEWSRC

cat > "$WORKDIR/search_src.sql" <<'SEARCHSRC'
select pg_catalog.md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '<default>') || ' ' || p.prosecdef::text
  from pg_catalog.pg_proc p
 where p.oid = 'public.search_books(text,text,integer,integer,integer)'::regprocedure;
SEARCHSRC

# The new rules after the migration. Rolled back.
cat > "$WORKDIR/newrules.sql" <<'NEWRULES'
begin;
-- The CHECK and search probes write the LIVE book directly; the
-- live-files guard (r2) is off for them only, inside this rolled-back
-- transaction, and back on for the r2 rules below.
alter table public.books disable trigger books_refuse_live_file_change;
create function pg_temp.check(p_ok boolean, p_label text) returns text language sql as $$
  select case when p_ok then 'ok ' else 'BAD ' end || p_label
$$;
create function pg_temp.try_value(p_value text) returns text
language plpgsql as $$
begin
  update public.books set original_author = p_value where id = 'e0878001-0000-4000-8000-000000000001';
  return 'ok';
exception when check_violation then
  return 'refused';
end;
$$;
select pg_temp.check(pg_temp.try_value('Lev Tolstoi') = 'ok', 'plain_name_accepted');
select pg_temp.check(pg_temp.try_value(repeat('a', 200)) = 'ok', 'two_hundred_chars_accepted');
select pg_temp.check(pg_temp.try_value(repeat('a', 201)) = 'refused', 'over_two_hundred_refused');
select pg_temp.check(pg_temp.try_value('') = 'refused', 'empty_refused');
select pg_temp.check(pg_temp.try_value(' Tolstoi') = 'refused', 'untrimmed_refused');
select pg_temp.check(pg_temp.try_value('Tol' || chr(10) || 'stoi') = 'refused', 'control_char_refused');
select pg_temp.check(pg_temp.try_value(null) = 'ok', 'null_accepted');
select pg_temp.check(pg_temp.try_value('Lev Tolstoi Ëç') = 'ok', 'name_set_for_search');
select pg_temp.check(
  (select count(*) from public.search_books('tolstoi ec', null, null, null, 500)) = 1,
  'search_finds_original_author_unaccented');
select pg_temp.check(
  (select count(*) from public.search_books('Ana Karenina', null, null, null, 500)) = 1,
  'search_still_finds_title');
select pg_temp.check(
  (select count(*) from public.search_books('nothing-like-this', null, null, null, 500)) = 0,
  'search_no_false_match');
update public.books set original_author = 'Lev Tolstoi' where id = 'e0878001-0000-4000-8000-000000000002';
select pg_temp.check(
  (select count(*) from public.search_books('Tolstoi', null, null, null, 500)) = 1,
  'search_skips_unpublished');
-- r2: the approval binds to the original author.
update public.books set original_author = null where id = 'e0878001-0000-4000-8000-000000000001';
alter table public.books enable trigger books_refuse_live_file_change;
create function pg_temp.try_live(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when sqlstate 'LB463' then
  return 'LB463';
end;
$$;
select pg_temp.check(
  pg_temp.try_live($q$update public.books set original_author = 'Homeri' where id = 'e0878001-0000-4000-8000-000000000001'$q$) = 'LB463',
  'live_original_author_change_refused');
select pg_temp.check(
  pg_temp.try_live($q$update public.books set original_author = 'Homeri', status = 'draft' where id = 'e0878001-0000-4000-8000-000000000001'$q$) = 'ok',
  'live_original_author_change_with_draft_saves');
-- A separate statement: in one, the subquery would run first.
select pg_temp.check(
  not (select public.book_review_approval_valid(b.id, b.file_path, b.cover_path, b.original_author)
         from public.books b where b.id = 'e0878001-0000-4000-8000-000000000001'),
  'old_approval_does_not_cover_new_original_author');
rollback;
NEWRULES

# A real value, kept through the rollback.
cat > "$WORKDIR/set_value.sql" <<'SETVALUE'
-- r2: a live book's original author changes only through review: to
-- draft in the same write, an approval for the new name, live again.
update public.books set original_author = 'Lev Tolstoi', status = 'draft'
 where id = 'e0878001-0000-4000-8000-000000000001';
insert into public.book_reviews (book_id, book_title, author_id, file_path, cover_path, original_author, status, grandfathered, decided_at)
select id, title, author_id, file_path, cover_path, original_author, 'approved', true, now()
  from public.books where id = 'e0878001-0000-4000-8000-000000000001';
update public.books set status = 'published' where id = 'e0878001-0000-4000-8000-000000000001';
SETVALUE

cat > "$WORKDIR/value.sql" <<'VALUE'
select coalesce(original_author, '<null>') from public.books where id = 'e0878001-0000-4000-8000-000000000001';
VALUE

cat > "$WORKDIR/search_after_rollback.sql" <<'SEARCHRB'
select count(*)::text from public.search_books('Tolstoi', null, null, null, 500);
SEARCHRB

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
run_file "$DB_C" "$WORKDIR/search_src.sql" "$WORKDIR/src_base.out" "$WORKDIR/src_base.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/review_src.sql" "$WORKDIR/rsrc_base.out" "$WORKDIR/rsrc_base.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/approval_before.sql" "$WORKDIR/appr_base.out" "$WORKDIR/appr_base.err" || STEP_RC=1
run_file "$DB_C" "$MIGRATION" "$WORKDIR/migrate.out" "$WORKDIR/migrate.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/approval_after.sql" "$WORKDIR/appr_new.out" "$WORKDIR/appr_new.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/review_src.sql" "$WORKDIR/rsrc_new.out" "$WORKDIR/rsrc_new.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after.out" "$WORKDIR/after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/all_null.sql" "$WORKDIR/null.out" "$WORKDIR/null.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/search_src.sql" "$WORKDIR/src_new.out" "$WORKDIR/src_new.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/newrules.sql" "$WORKDIR/newrules.out" "$WORKDIR/newrules.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after_probes.out" "$WORKDIR/after_probes.err" || STEP_RC=1

ERRS=0
for e in before src_base rsrc_base appr_base migrate appr_new rsrc_new after null src_new newrules after_probes; do
  [ -s "$WORKDIR/$e.err" ] && ERRS=1
done
if [ "$STEP_RC" -ne 0 ] || [ "$ERRS" -ne 0 ]; then
  echo "FAIL [populated_migration]: a step errored or wrote to stderr" >&2
  tail -n 5 "$WORKDIR"/*.err >&2 || true
  FAILURES=$((FAILURES + 1))
elif [ ! -s "$WORKDIR/before.out" ] || grep -q '<none>' "$WORKDIR/before.out"; then
  echo "FAIL [populated_migration]: the fixture left books empty" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/after.out" || ! cmp -s "$WORKDIR/after.out" "$WORKDIR/after_probes.out"; then
  echo "FAIL [populated_migration]: an existing value changed (or a probe left one behind)" >&2
  diff "$WORKDIR/before.out" "$WORKDIR/after_probes.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
elif [ "$(tr '\n' ' ' < "$WORKDIR/null.out")" != "0/2 0/2 " ]; then
  echo "FAIL [populated_migration]: original_author is not null on every existing row: $(cat "$WORKDIR/null.out")" >&2
  FAILURES=$((FAILURES + 1))
elif cmp -s "$WORKDIR/src_base.out" "$WORKDIR/src_new.out"; then
  echo "FAIL [populated_migration]: search_books() did not change" >&2
  FAILURES=$((FAILURES + 1))
elif cmp -s "$WORKDIR/rsrc_base.out" "$WORKDIR/rsrc_new.out"; then
  echo "FAIL [populated_migration]: the review functions did not change" >&2
  FAILURES=$((FAILURES + 1))
elif [ "$(cat "$WORKDIR/appr_base.out")" != "true" ] || [ "$(cat "$WORKDIR/appr_new.out")" != "true" ]; then
  echo "FAIL [populated_migration]: the live book's approval is not valid before and after: $(cat "$WORKDIR/appr_base.out") / $(cat "$WORKDIR/appr_new.out")" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated_migration]: 2 books and 2 reviews byte-identical (every old column), original_author null on all, search_books and the review functions replaced, the live book's approval valid before and after"
fi

SECTIONS=$((SECTIONS + 1))
if [ ! -s "$WORKDIR/newrules.out" ] || grep -q '^BAD ' "$WORKDIR/newrules.out" || [ "$(grep -c '^ok ' "$WORKDIR/newrules.out")" -ne 15 ]; then
  echo "FAIL [new_rules]:" >&2
  cat "$WORKDIR/newrules.out" "$WORKDIR/newrules.err" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [new_rules]: $(grep -c '^ok ' "$WORKDIR/newrules.out") checks -- $(grep '^ok ' "$WORKDIR/newrules.out" | sed 's/^ok //' | tr '\n' ' ')"
fi

# The rollback: search_books() back byte for byte (same ACL, same
# invoker rights), the column and a typed value kept, the original
# author no longer searched. Then a second run changes nothing.
SECTIONS=$((SECTIONS + 1))
STEP_RC=0
run_file "$DB_C" "$WORKDIR/set_value.sql" "$WORKDIR/set.out" "$WORKDIR/set.err" || STEP_RC=1
run_file "$DB_C" "$ROLLBACK" "$WORKDIR/rb1.out" "$WORKDIR/rb1.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/search_src.sql" "$WORKDIR/src_rb.out" "$WORKDIR/src_rb.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/review_src.sql" "$WORKDIR/rsrc_rb.out" "$WORKDIR/rsrc_rb.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/value.sql" "$WORKDIR/value.out" "$WORKDIR/value.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/search_after_rollback.sql" "$WORKDIR/srb.out" "$WORKDIR/srb.err" || STEP_RC=1
run_file "$DB_C" "$ROLLBACK" "$WORKDIR/rb2.out" "$WORKDIR/rb2.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/search_src.sql" "$WORKDIR/src_rb2.out" "$WORKDIR/src_rb2.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/review_src.sql" "$WORKDIR/rsrc_rb2.out" "$WORKDIR/rsrc_rb2.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/approval_before.sql" "$WORKDIR/appr_rb.out" "$WORKDIR/appr_rb.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/rolled_back.out" "$WORKDIR/rolled_back.err" || STEP_RC=1
ERRS=0
for e in set rb1 src_rb rsrc_rb value srb rb2 src_rb2 rsrc_rb2 appr_rb rolled_back; do
  [ -s "$WORKDIR/$e.err" ] && ERRS=1
done
if [ "$STEP_RC" -ne 0 ] || [ "$ERRS" -ne 0 ] \
   || ! cmp -s "$WORKDIR/src_base.out" "$WORKDIR/src_rb.out" \
   || ! cmp -s "$WORKDIR/src_base.out" "$WORKDIR/src_rb2.out" \
   || ! cmp -s "$WORKDIR/rsrc_base.out" "$WORKDIR/rsrc_rb.out" \
   || ! cmp -s "$WORKDIR/rsrc_base.out" "$WORKDIR/rsrc_rb2.out" \
   || [ "$(cat "$WORKDIR/appr_rb.out")" != "true" ] \
   || [ "$(cat "$WORKDIR/value.out")" != "Lev Tolstoi" ] \
   || [ "$(cat "$WORKDIR/srb.out")" != "0" ] \
   || ! cmp -s <(grep '^books|' "$WORKDIR/before.out") <(grep '^books|' "$WORKDIR/rolled_back.out"); then
  echo "FAIL [rollback]:" >&2
  cat "$WORKDIR"/rb1.err "$WORKDIR"/rb2.err "$WORKDIR/src_base.out" "$WORKDIR/src_rb.out" "$WORKDIR/value.out" "$WORKDIR/srb.out" >&2 || true
  diff "$WORKDIR/rsrc_base.out" "$WORKDIR/rsrc_rb.out" >&2 || true
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [rollback]: search_books(), the review functions, the 3-argument approval function and the live-files trigger identical to the base (body, ACL, definer/invoker), twice; the 4-argument function gone; the live book's approval valid; typed value kept; not searched; other columns unchanged"
fi

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 087_bd3_original_author_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 087_bd3_original_author_catalog_equivalence.sh -- $SECTIONS sections: catalog identical between $PATCHED_LABEL and the base + migration, none empty; populated-data, new-rule and rollback checks pass"
