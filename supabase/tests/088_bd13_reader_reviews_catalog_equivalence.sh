#!/usr/bin/env bash
# BD13: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema (e892da1a) plus
# supabase/migrations/20261102120000_bd13_reader_reviews.sql describe the
# same database -- across every catalog that can differ -- that the
# migration over POPULATED data changes no existing value and keeps
# every existing review approved and public, that the new rules behave
# as intended, and that the rollback (088_bd13_reader_reviews.rollback.sql)
# gives the reader their direct writes back and drops the five
# functions while keeping the columns and their values.
#
# Modelled on 087_bd3_original_author_catalog_equivalence.sh; its
# generic machinery (schema resolution, the non-vacuous compare(), every
# catalog section) is carried over unchanged, with the effective-
# privilege sections pointed at reviews, public_reviews and profiles.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer, because
# schema.sql uses the MAINTAIN privilege; on 16 pass stripped copies via
# BASE_SCHEMA, SCHEMA, MIGRATION and STUB):
#
#   ./supabase/tests/088_bd13_reader_reviews_catalog_equivalence.sh
#
# Overrides: BASE_REF, BASE_SCHEMA, MIGRATION, ROLLBACK, STUB,
# SCHEMA_PATH, MARKER, and either SCHEMA (an explicit patched-schema
# file) or PATCHED_REF (an explicit patched-schema commit). Exits
# non-zero on any difference, any empty section, any non-zero psql exit,
# or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against (staging after PR #145).
BASE_REF="${BASE_REF:-e892da1a321a6f50ac964719257c6c09523eff00}"
MIGRATION="${MIGRATION:-supabase/migrations/20261102120000_bd13_reader_reviews.sql}"
ROLLBACK="${ROLLBACK:-supabase/tests/088_bd13_reader_reviews.rollback.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-BD13}"
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
DB_A="librum_sqbd13_a_${SUFFIX}"
DB_B="librum_sqbd13_b_${SUFFIX}"
DB_C="librum_sqbd13_c_${SUFFIX}"
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

# The base must carry BD3-P4 (an earlier migration) and no review_name
# anywhere.
if ! grep -q "BD3-P4" "$WORKDIR/base_schema.sql" \
   || grep -q "review_name" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: the base schema is not the e892da1a base (BD3-P4, no review_name) -- wrong base" >&2
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
# share one cluster, so that value is identical between them. reviews
# (INSERT and UPDATE revoked from authenticated), public_reviews (the
# new verified column) and profiles (review_name).
for tbl in reviews public_reviews profiles; do
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
# privileges are the intended ones (not merely equal).
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      (select a.attnum = (select max(a2.attnum) from pg_catalog.pg_attribute a2
                           where a2.attrelid = 'public.profiles'::regclass and a2.attnum > 0 and not a2.attisdropped)
         from pg_catalog.pg_attribute a
        where a.attrelid = 'public.profiles'::regclass and a.attname = 'review_name' and not a.attisdropped)
      and exists (select 1 from pg_catalog.pg_constraint
                   where conrelid = 'public.profiles'::regclass and conname = 'profiles_review_name_check')
      and (select string_agg(a.attname, ',' order by a.attnum) from pg_catalog.pg_attribute a
            where a.attrelid = 'public.reviews'::regclass and a.attnum > 0 and not a.attisdropped)
          = 'id,book_id,reader_id,rating,body,created_at,status,rejection_reason,rejection_note,updated_at,reviewer_is_author'
      and (select count(*) from pg_catalog.pg_constraint
            where conrelid = 'public.reviews'::regclass
              and conname in ('reviews_status_check', 'reviews_rejection_reason_check',
                              'reviews_rejection_note_check', 'reviews_rejection_consistent_check')) = 4
      and (select pg_catalog.pg_get_expr(d.adbin, d.adrelid) from pg_catalog.pg_attrdef d
             join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
            where d.adrelid = 'public.reviews'::regclass and a.attname = 'status') = '''pending''::text'
      and to_regclass('public.reviews_pending_idx') is not null
      and has_table_privilege('authenticated', 'public.reviews', 'SELECT')
      and not has_table_privilege('authenticated', 'public.reviews', 'INSERT')
      and not has_column_privilege('authenticated', 'public.reviews', 'body', 'UPDATE')
      and not has_column_privilege('authenticated', 'public.profiles', 'review_name', 'UPDATE')
      and (select string_agg(a.attname, ',' order by a.attnum) from pg_catalog.pg_attribute a
            where a.attrelid = 'public.public_reviews'::regclass and a.attnum > 0)
          = 'id,book_id,rating,body,created_at,reviewer_name,verified,reviewer_is_author'
      and pg_catalog.pg_get_viewdef('public.public_reviews'::regclass) like '%status = ''approved''::text%'
      and (select c.reloptions::text like '%security_barrier%' from pg_catalog.pg_class c
            where c.oid = 'public.public_reviews'::regclass)
      and has_column_privilege('anon', 'public.public_reviews', 'verified', 'SELECT')
      and (select bool_and(p.prosecdef and p.proconfig = array['search_path=\"\"']
                           and has_function_privilege('authenticated', p.oid, 'EXECUTE')
                           and not has_function_privilege('anon', p.oid, 'EXECUTE')
                           and not has_function_privilege('service_role', p.oid, 'EXECUTE'))
                and count(*) = 5
             from pg_catalog.pg_proc p
            where p.oid in ('public.submit_reader_review(uuid,integer,text,text)'::regprocedure,
                            'public.staff_list_pending_reader_reviews()'::regprocedure,
                            'public.staff_approve_reader_review(uuid,timestamptz)'::regprocedure,
                            'public.staff_reject_reader_review(uuid,timestamptz,text,text)'::regprocedure,
                            'public.staff_set_review_name(uuid,text)'::regprocedure))
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry BD13 as intended" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: profiles.review_name last + named CHECK; reviews' five new columns last, four named CHECKs, default pending, the queue index; reviews SELECT-only for authenticated; public_reviews approved-only with verified and reviewer_is_author last (security_barrier, anon reads it); five definer functions, authenticated only"
  fi
done

# ============================================================
# Part 2: the migration over POPULATED base data, the new rules (rolled
# back), then the rollback.
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0888000-0000-4000-8000-00000000000a', 'q088-a@test', now(), '{"role":"author","display_name":"Q088 Author"}'),
  ('e0888000-0000-4000-8000-0000000000aa', 'q088-r@test', now(), '{"role":"reader","display_name":"Q088 Reader"}'),
  ('e0888000-0000-4000-8000-0000000000bb', 'q088-s@test', now(), '{"role":"reader","display_name":"Q088 Free"}');
insert into public.books (id, author_id, title, status, price_all, published_at) values
  ('e0888001-0000-4000-8000-000000000001', 'e0888000-0000-4000-8000-00000000000a', 'Q088 Libri', 'published', 199, now());
insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0888001-0000-4000-8000-000000000001', 'e0888000-0000-4000-8000-0000000000aa', 'cs_q088_r', 19900),
  ('e0888001-0000-4000-8000-000000000001', 'e0888000-0000-4000-8000-0000000000bb', 'free_q088_s', 0);
insert into public.reviews (book_id, reader_id, rating, body, created_at) values
  ('e0888001-0000-4000-8000-000000000001', 'e0888000-0000-4000-8000-0000000000aa', 5, 'Q088 e bukur', '2026-10-30 10:00:00+00'),
  ('e0888001-0000-4000-8000-000000000001', 'e0888000-0000-4000-8000-0000000000bb', 3, 'Q088 mesatare', '2026-10-31 11:00:00+00');
FIXTURES

# Every reviews and profiles column that existed before, as an ordered
# text dump: the migration changes no existing value. The new columns
# are reported separately.
cat > "$WORKDIR/fingerprint.sql" <<'FINGERPRINT'
select 'reviews', coalesce(string_agg((to_jsonb(t) - array['status','rejection_reason','rejection_note','updated_at','reviewer_is_author'])::text, ';' order by t.id), '<none>') from public.reviews t;
select 'profiles', coalesce(string_agg((to_jsonb(p) - 'review_name')::text, ';' order by p.id), '<none>') from public.profiles p;
FINGERPRINT

# The existing reviews after the migration: approved, updated_at =
# created_at, no reason; no name on any account; still public.
cat > "$WORKDIR/kept.sql" <<'KEPT'
select string_agg(status || '/' || (updated_at = created_at)::text || '/' || coalesce(rejection_reason, '-') || '/' || coalesce(rejection_note, '-'), ',' order by body) from public.reviews;
select count(*) filter (where review_name is not null)::text from public.profiles;
select string_agg(coalesce(reviewer_name, '<null>') || '/' || body || '/' || verified::text, ',' order by body) from public.public_reviews;
KEPT

# The new rules after the migration, as the reader and as staff. Rolled
# back.
cat > "$WORKDIR/newrules.sql" <<'NEWRULES'
begin;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0888000-0000-4000-8000-0000000000f3', 'q088-m@test', now(), '{"role":"reader","display_name":"Q088 Moderator"}');
insert into public.staff_members (user_id, role) values ('e0888000-0000-4000-8000-0000000000f3', 'moderator');
create function pg_temp.check(p_ok boolean, p_label text) returns text language sql as $$
  select case when p_ok then 'ok ' else 'BAD ' end || p_label
$$;
create function pg_temp.as_user(p_sub text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claim.sub', p_sub, true);
  set local role authenticated;
  execute p_sql into v;
  reset role;
  return v;
exception when others then
  reset role;
  return 'ERR:' || sqlerrm;
end $$;
select pg_temp.check(pg_temp.as_user('e0888000-0000-4000-8000-0000000000aa',
  $q$select public.submit_reader_review('e0888001-0000-4000-8000-000000000001', 5, 'Q088 e bukur', null)$q$) = 'unchanged',
  'an identical resubmission of a kept review changes nothing');
select pg_temp.check(pg_temp.as_user('e0888000-0000-4000-8000-0000000000aa',
  $q$select public.submit_reader_review('e0888001-0000-4000-8000-000000000001', 4, 'Q088 ndryshuar', null)$q$) = 'name_required',
  'an edit of a kept review needs a name first');
select pg_temp.check(pg_temp.as_user('e0888000-0000-4000-8000-0000000000aa',
  $q$select public.submit_reader_review('e0888001-0000-4000-8000-000000000001', 4, 'Q088 ndryshuar', 'Lexuesi Q')$q$) = 'pending',
  'with a name the edit is pending');
select pg_temp.check((select string_agg(body, ',' order by body) from public.public_reviews) = 'Q088 mesatare',
  'the edited review left public_reviews');
select pg_temp.check(pg_temp.as_user('e0888000-0000-4000-8000-0000000000f3',
  $q$select count(*)::text from public.staff_list_pending_reader_reviews()$q$) = '1',
  'the moderator sees one review waiting');
select pg_temp.check(pg_temp.as_user('e0888000-0000-4000-8000-0000000000f3',
  format('select public.staff_approve_reader_review(%L::uuid, %L::timestamptz)',
         (select id from public.reviews where body = 'Q088 ndryshuar'),
         (select updated_at from public.reviews where body = 'Q088 ndryshuar'))) = 'approved',
  'the moderator approves it');
select pg_temp.check((select string_agg(coalesce(reviewer_name, '<null>') || '/' || verified::text, ',' order by body) from public.public_reviews)
  = '<null>/false,Lexuesi Q/true', 'it shows with its name and the paid badge; the free claim shows no badge');
select pg_temp.check(pg_temp.as_user('e0888000-0000-4000-8000-0000000000aa',
  $q$select count(*)::text from public.reviews where status = 'approved'$q$) = '1',
  'the reader reads their own review only');
select pg_temp.check(pg_temp.as_user('e0888000-0000-4000-8000-0000000000aa',
  $q$insert into public.reviews (book_id, reader_id, rating, body) values ('e0888001-0000-4000-8000-000000000001', 'e0888000-0000-4000-8000-0000000000aa', 1, 'x') returning 'inserted'$q$) like 'ERR:permission denied%',
  'a direct insert is refused');
rollback;
NEWRULES

# The rollback leaves these as they were after it ran once.
cat > "$WORKDIR/rollback_state.sql" <<'RBSTATE'
select has_column_privilege('authenticated', 'public.reviews', 'body', 'INSERT')::text
       || '/' || has_column_privilege('authenticated', 'public.reviews', 'body', 'UPDATE')::text
       || '/' || has_column_privilege('authenticated', 'public.reviews', 'status', 'UPDATE')::text
       || '/' || has_column_privilege('authenticated', 'public.reviews', 'status', 'INSERT')::text
       || '/' || has_column_privilege('authenticated', 'public.reviews', 'reviewer_is_author', 'INSERT')::text
       || '/' || has_column_privilege('authenticated', 'public.reviews', 'reviewer_is_author', 'UPDATE')::text
       || '/' || has_table_privilege('authenticated', 'public.reviews', 'INSERT')::text;
select count(*)::text from pg_catalog.pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('submit_reader_review', 'staff_list_pending_reader_reviews', 'staff_approve_reader_review',
                   'staff_reject_reader_review', 'staff_set_review_name');
select (select pg_catalog.pg_get_expr(d.adbin, d.adrelid) from pg_catalog.pg_attrdef d
          join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
         where d.adrelid = 'public.reviews'::regclass and a.attname = 'status');
select (pg_catalog.pg_get_viewdef('public.public_reviews'::regclass) like '%status = ''approved''::text%')::text;
select string_agg(attname, ',' order by attnum) from pg_catalog.pg_attribute
 where attrelid = 'public.reviews'::regclass and attnum > 0 and not attisdropped;
select count(*)::text from public.public_reviews;
begin;
update public.reviews set status = 'rejected', rejection_reason = 'personal_data' where body = 'Q088 mesatare';
select count(*)::text from public.public_reviews;
rollback;
RBSTATE

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
run_file "$DB_C" "$WORKDIR/kept.sql" "$WORKDIR/kept.out" "$WORKDIR/kept.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/newrules.sql" "$WORKDIR/newrules.out" "$WORKDIR/newrules.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after_probes.out" "$WORKDIR/after_probes.err" || STEP_RC=1
ERRS=0
for e in before migrate after kept newrules after_probes; do
  [ -s "$WORKDIR/$e.err" ] && ERRS=1
done
KEPT_EXPECTED="approved/true/-/-,approved/true/-/-
0
<null>/Q088 e bukur/true,<null>/Q088 mesatare/false"
if [ "$STEP_RC" -ne 0 ] || [ "$ERRS" -ne 0 ]; then
  echo "FAIL [populated]: a step errored" >&2
  cat "$WORKDIR"/*.err >&2 || true
  FAILURES=$((FAILURES + 1))
elif [ ! -s "$WORKDIR/before.out" ] || grep -q '<none>' "$WORKDIR/before.out"; then
  echo "FAIL [populated]: the fixture rows are missing -- the check would be vacuous" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/after.out" || ! cmp -s "$WORKDIR/after.out" "$WORKDIR/after_probes.out"; then
  echo "FAIL [populated]: the migration (or the rolled-back probes) changed an existing value" >&2
  diff "$WORKDIR/before.out" "$WORKDIR/after_probes.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
elif [ "$(cat "$WORKDIR/kept.out")" != "$KEPT_EXPECTED" ]; then
  echo "FAIL [populated]: the existing reviews were not kept approved and public" >&2
  cat "$WORKDIR/kept.out" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated]: existing reviews and profiles unchanged; both reviews kept approved (updated_at = created_at, no reason), no name set, both still public, the paid one with the badge"
fi

SECTIONS=$((SECTIONS + 1))
if [ ! -s "$WORKDIR/newrules.out" ] || grep -q '^BAD ' "$WORKDIR/newrules.out" || [ "$(grep -c '^ok ' "$WORKDIR/newrules.out")" -ne 9 ]; then
  echo "FAIL [new_rules]:" >&2
  cat "$WORKDIR/newrules.out" "$WORKDIR/newrules.err" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [new_rules]: $(grep -c '^ok ' "$WORKDIR/newrules.out") checks -- $(grep '^ok ' "$WORKDIR/newrules.out" | sed 's/^ok //' | tr '\n' ' ')"
fi

# The rollback: the reader's direct writes back, the five functions
# gone, status default 'approved', the view keeping the approved-only
# filter (a rejected review stays hidden: audit r1 R2), the columns and
# values kept. Then a second run changes nothing.
SECTIONS=$((SECTIONS + 1))
STEP_RC=0
run_file "$DB_C" "$ROLLBACK" "$WORKDIR/rb1.out" "$WORKDIR/rb1.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/rollback_state.sql" "$WORKDIR/rbs1.out" "$WORKDIR/rbs1.err" || STEP_RC=1
run_file "$DB_C" "$ROLLBACK" "$WORKDIR/rb2.out" "$WORKDIR/rb2.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/rollback_state.sql" "$WORKDIR/rbs2.out" "$WORKDIR/rbs2.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/rolled_back.out" "$WORKDIR/rolled_back.err" || STEP_RC=1
ERRS=0
for e in rb1 rbs1 rb2 rbs2 rolled_back; do
  [ -s "$WORKDIR/$e.err" ] && ERRS=1
done
RB_EXPECTED="true/true/false/false/false/false/false
0
'approved'::text
true
id,book_id,reader_id,rating,body,created_at,status,rejection_reason,rejection_note,updated_at,reviewer_is_author
2
1"
if [ "$STEP_RC" -ne 0 ] || [ "$ERRS" -ne 0 ] \
   || [ "$(cat "$WORKDIR/rbs1.out")" != "$RB_EXPECTED" ] \
   || ! cmp -s "$WORKDIR/rbs1.out" "$WORKDIR/rbs2.out" \
   || ! cmp -s "$WORKDIR/before.out" "$WORKDIR/rolled_back.out"; then
  echo "FAIL [rollback]:" >&2
  cat "$WORKDIR"/rb1.err "$WORKDIR"/rb2.err "$WORKDIR/rbs1.out" >&2 || true
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [rollback]: INSERT and UPDATE(book_id, reader_id, rating, body) back for authenticated, column-level only (not status, not reviewer_is_author), the five functions gone, status default approved, public_reviews still approved-only (a rejected review stays hidden), columns kept, existing values unchanged; twice"
fi

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 088_bd13_reader_reviews_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 088_bd13_reader_reviews_catalog_equivalence.sh -- $SECTIONS sections: catalog identical between $PATCHED_LABEL and the base + migration, none empty; populated-data, new-rule and rollback checks pass"
