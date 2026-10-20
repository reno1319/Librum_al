#!/usr/bin/env bash
# ADMIN-3-REVIEW: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema (4697513) plus
# supabase/migrations/20261020120000_book_reviews.sql describe the same
# database -- across every catalog that can differ, the storage
# policies included -- and that the migration over POPULATED data
# changes no existing row and backfills exactly one grandfathered
# approval per published book, and (A1 = a) exactly one grandfathered
# buyer_file_only approval per draft with any purchase, a past
# publication or a takedown -- none for any other draft.
#
# Modelled on 076_book_takedowns_catalog_equivalence.sh; its generic
# machinery (schema resolution, the non-vacuous compare(), every catalog
# section) is carried over unchanged, with the effective-privilege
# sections pointed at the tables this migration adds or touches and a
# storage-policy section added.
#
# Why the risk is concrete here: book_reviews carries COLUMN-level
# SELECT grants, a partial unique index and named CHECKs; three
# triggers on books, five RPCs and three restated functions must be
# byte-identical on both build paths, with the same ACLs; and the three
# manuscripts write policies are replaced under the same names.
#
# Part 2 builds the BASE, inserts rows (books, a takedown, storage
# objects, an audit row), runs the pre-migration probes (rolled back),
# applies the migration, asserts no existing row changed and the
# backfill is exact, then exercises the old-code paths of the rollout
# window (M7) and the new guards, all rolled back.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer, because
# schema.sql uses the MAINTAIN privilege; on 16 pass stripped copies via
# BASE_SCHEMA, SCHEMA, MIGRATION and STUB):
#
#   ./supabase/tests/077_book_reviews_catalog_equivalence.sh
#
# Overrides: BASE_REF, BASE_SCHEMA, MIGRATION, STUB, SCHEMA_PATH, MARKER,
# and either SCHEMA (an explicit patched-schema file) or PATCHED_REF (an
# explicit patched-schema commit). Exits non-zero on any difference, any
# empty section, any non-zero psql exit, or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against (it carries ADMIN-2's book_takedowns).
BASE_REF="${BASE_REF:-4697513d91891303d1aadfc11dc31968132a0b67}"
MIGRATION="${MIGRATION:-supabase/migrations/20261020120000_book_reviews.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-ADMIN-3-REVIEW}"
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
DB_A="librum_review_a_${SUFFIX}"
DB_B="librum_review_b_${SUFFIX}"
DB_C="librum_review_c_${SUFFIX}"
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

# The base must carry ADMIN-2 (book_takedowns) and no book_reviews table.
if ! grep -q "create table public.book_takedowns" "$WORKDIR/base_schema.sql" \
   || grep -q "create table public.book_reviews" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: the base schema is not the 4697513 base (book_takedowns, no book_reviews) -- wrong base" >&2
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

# Function sections: the three trigger functions, the approval check,
# the five RPCs and the restated staff_has_permission(),
# admin_unpublish_book() and list_admin_audit_events() -- definition,
# security and ACL must be identical.
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

# The manuscripts write policies are replaced (same names, new
# predicates), so the storage schema's policies are compared too.
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
for tbl in book_reviews books book_takedowns admin_audit_log profiles staff_members; do
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
# Beyond equivalence: both databases CARRY THE CHANGE.
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      (select relrowsecurity from pg_catalog.pg_class where oid = 'public.book_reviews'::regclass)
      and not has_table_privilege('anon', 'public.book_reviews', 'SELECT')
      and not has_table_privilege('authenticated', 'public.book_reviews', 'SELECT')
      and has_column_privilege('authenticated', 'public.book_reviews', 'message_to_author', 'SELECT')
      and not has_column_privilege('authenticated', 'public.book_reviews', 'file_path', 'SELECT')
      and not has_column_privilege('authenticated', 'public.book_reviews', 'checklist', 'SELECT')
      and not has_column_privilege('authenticated', 'public.book_reviews', 'decided_by', 'SELECT')
      and not has_table_privilege('service_role', 'public.book_reviews', 'INSERT, UPDATE, DELETE, TRUNCATE')
      and has_table_privilege('service_role', 'public.book_reviews', 'SELECT')
      and has_function_privilege('authenticated', 'public.request_book_review(uuid)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.withdraw_book_review(uuid)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.book_review_state(uuid)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.admin_approve_book_review(uuid,text,text,integer,jsonb)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.admin_send_back_book_review(uuid,text,text)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.request_book_review(uuid)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.book_review_approval_valid(uuid,text,text)', 'EXECUTE')
      and not has_function_privilege('service_role', 'public.book_review_approval_valid(uuid,text,text)', 'EXECUTE')
      and exists (select 1 from pg_catalog.pg_trigger where tgname = 'books_require_review_approval'
                   and tgrelid = 'public.books'::regclass)
      and exists (select 1 from pg_catalog.pg_trigger where tgname = 'books_refuse_live_file_change'
                   and tgrelid = 'public.books'::regclass)
      and exists (select 1 from pg_catalog.pg_trigger where tgname = 'books_cancel_pending_review_on_delete'
                   and tgrelid = 'public.books'::regclass)
      -- LB460 (taken down) sorts before the approval gate
      and 'books_refuse_publish_while_taken_down' < 'books_require_review_approval'
      and pg_catalog.pg_get_functiondef('public.staff_has_permission(text)'::regprocedure) ~ 'books\.review'
      and pg_catalog.pg_get_functiondef('public.list_admin_audit_events(text,uuid,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,uuid,integer)'::regprocedure) ~ 'book\.review_sent_back'
      and (select count(*) from pg_catalog.pg_policies where schemaname = 'storage' and tablename = 'objects'
             and policyname in ('Authors can upload their own manuscripts', 'Authors can replace their own manuscripts',
                                'Authors can delete their own manuscripts')
             and coalesce(qual, '') || coalesce(with_check, '') ~ 'tmp') = 3
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry ADMIN-3-REVIEW" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: book_reviews (RLS, column SELECT only, no writes), five RPCs for authenticated, the approval check closed, three triggers, books.review, the audit allow-list, tmp-only manuscripts writes"
  fi
done

# ============================================================
# Part 2: the migration over POPULATED base data, then the old-code
# paths of the rollout window and the new guards, all rolled back.
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
-- A: author with P1 (published, file and cover), P2 (published, file
-- only, Librum's choice), D (draft with a file: never sold, published
-- or taken down), T (published, then taken down: a draft with an active
-- takedown and no file on record), U (a draft published before: the
-- author unpublished it). B: author with H (draft, published_at null,
-- one purchase: pre-044) and RF (draft, published_at null, its only
-- purchase refunded). R: a reader. M: moderator. Two manuscripts
-- objects. One existing audit row.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0774f00-0000-4000-8000-00000000000a', 'p077e-a@test', now(), '{"role":"author","display_name":"P077E Ana"}'),
  ('e0774f00-0000-4000-8000-00000000000b', 'p077e-b@test', now(), '{"role":"author","display_name":"P077E Ben"}'),
  ('e0774f00-0000-4000-8000-0000000000aa', 'p077e-r@test', now(), '{"role":"reader","display_name":"P077E Reader"}'),
  ('e0774f00-0000-4000-8000-0000000000dd', 'p077e-m@test', now(), '{"role":"reader","display_name":"P077E Moderator"}');
insert into public.staff_members (user_id, role) values ('e0774f00-0000-4000-8000-0000000000dd', 'moderator');
insert into public.books (id, author_id, title, status, price_all, published_at, created_at, file_path, cover_path) values
  ('e0774f01-0000-4000-8000-000000000001', 'e0774f00-0000-4000-8000-00000000000a', 'P1', 'published', 499, now(), '2026-01-01',
   'e0774f00-0000-4000-8000-00000000000a/e0774f01-0000-4000-8000-000000000001.epub', 'e077c0de-0000-4000-8000-000000000001/cover.jpg'),
  ('e0774f01-0000-4000-8000-000000000002', 'e0774f00-0000-4000-8000-00000000000a', 'P2', 'published', 199, now(), '2026-01-02',
   'e0774f00-0000-4000-8000-00000000000a/e0774f01-0000-4000-8000-000000000002.epub', null),
  ('e0774f01-0000-4000-8000-000000000003', 'e0774f00-0000-4000-8000-00000000000a', 'D',  'draft',     199, null,  '2026-01-03',
   'e0774f00-0000-4000-8000-00000000000a/e0774f01-0000-4000-8000-000000000003.epub', null),
  ('e0774f01-0000-4000-8000-000000000004', 'e0774f00-0000-4000-8000-00000000000a', 'T',  'published', 199, now(), '2026-01-04', null, null),
  ('e0774f01-0000-4000-8000-000000000005', 'e0774f00-0000-4000-8000-00000000000a', 'U',  'draft',     299, '2026-05-01', '2026-01-05',
   'e0774f00-0000-4000-8000-00000000000a/e0774f01-0000-4000-8000-000000000005.epub', 'e077c0de-0000-4000-8000-000000000005/cover.jpg'),
  ('e0774f01-0000-4000-8000-000000000006', 'e0774f00-0000-4000-8000-00000000000b', 'H',  'draft',     399, null,  '2026-01-06',
   'e0774f00-0000-4000-8000-00000000000b/e0774f01-0000-4000-8000-000000000006.epub', null),
  ('e0774f01-0000-4000-8000-000000000007', 'e0774f00-0000-4000-8000-00000000000b', 'RF', 'draft',     399, null,  '2026-01-07',
   'e0774f00-0000-4000-8000-00000000000b/e0774f01-0000-4000-8000-000000000007.epub', null);
insert into public.purchases (book_id, reader_id, amount_cents, refunded_at) values
  ('e0774f01-0000-4000-8000-000000000006', 'e0774f00-0000-4000-8000-0000000000aa', 399, null),
  ('e0774f01-0000-4000-8000-000000000007', 'e0774f00-0000-4000-8000-0000000000aa', 399, '2026-03-01');
update public.books set librum_choice_at = '2026-10-01' where id = 'e0774f01-0000-4000-8000-000000000002';
insert into storage.objects (bucket_id, name) values
  ('manuscripts', 'e0774f00-0000-4000-8000-00000000000a/e0774f01-0000-4000-8000-000000000001.epub'),
  ('manuscripts', 'e0774f00-0000-4000-8000-00000000000a/e0774f01-0000-4000-8000-000000000003.epub');
insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata, created_at) values
  ('e0774f00-0000-4000-8000-0000000000dd', 'report.dismissed', 'books', 'e0774f01-0000-4000-8000-000000000001', '{}', '2026-10-02');
select set_config('request.jwt.claim.sub', 'e0774f00-0000-4000-8000-0000000000dd', false);
set role authenticated;
select public.admin_unpublish_book('e0774f01-0000-4000-8000-000000000004', 'copyright', 'Probe', null) is not null;
reset role;
select set_config('request.jwt.claim.sub', '', false);
FIXTURES

cat > "$WORKDIR/fingerprint.sql" <<'FP'
select 'books:' || coalesce(string_agg(pg_catalog.to_jsonb(b)::text, ',' order by b.id), '<none>') from public.books b;
select 'book_takedowns:' || coalesce(string_agg(pg_catalog.to_jsonb(t)::text, ',' order by t.id), '<none>') from public.book_takedowns t;
select 'admin_audit_log:' || coalesce(string_agg(pg_catalog.to_jsonb(a)::text, ',' order by a.id), '<none>') from public.admin_audit_log a;
select 'profiles:' || coalesce(string_agg(pg_catalog.to_jsonb(p)::text, ',' order by p.id), '<none>') from public.profiles p;
select 'staff_members:' || coalesce(string_agg(pg_catalog.to_jsonb(s)::text, ',' order by s.user_id), '<none>') from public.staff_members s;
select 'storage_objects:' || coalesce(string_agg(pg_catalog.to_jsonb(o)::text, ',' order by o.name), '<none>') from storage.objects o;
select 'purchases:' || coalesce(string_agg(pg_catalog.to_jsonb(pu)::text, ',' order by pu.id), '<none>') from public.purchases pu;
FP

# Before the migration (rolled back): the old guards are absent.
cat > "$WORKDIR/premigration.sql" <<'PRE'
begin;
create function pg_temp.check(ok boolean, msg text) returns text language sql as $$
  select case when ok then 'ok ' || msg else 'BAD ' || msg end $$;
-- M7: a live book's cover can be changed by the trusted writer today.
set local role service_role;
update public.books set cover_path = 'e077c0de-0000-4000-8000-0000000000f1/cover.png' where id = 'e0774f01-0000-4000-8000-000000000001';
reset role;
select pg_temp.check((select cover_path from public.books where id = 'e0774f01-0000-4000-8000-000000000001')
  = 'e077c0de-0000-4000-8000-0000000000f1/cover.png', 'pre_live_cover_change_allowed');
-- An author may write a final manuscripts key today.
select set_config('request.jwt.claim.sub', 'e0774f00-0000-4000-8000-00000000000a', true);
set local role authenticated;
insert into storage.objects (bucket_id, name) values ('manuscripts', 'e0774f00-0000-4000-8000-00000000000a/e0774f01-0000-4000-8000-000000000002.epub');
reset role;
select pg_temp.check((select count(*) from storage.objects where name = 'e0774f00-0000-4000-8000-00000000000a/e0774f01-0000-4000-8000-000000000002.epub') = 1,
  'pre_author_final_key_upload_allowed');
-- A first publish needs nothing today.
set local role service_role;
update public.books set status = 'published' where id = 'e0774f01-0000-4000-8000-000000000003';
reset role;
select pg_temp.check((select status from public.books where id = 'e0774f01-0000-4000-8000-000000000003') = 'published', 'pre_first_publish_allowed');
rollback;
PRE

# Old code after the migration, then the new guards -- all rolled back.
cat > "$WORKDIR/oldcode.sql" <<'OLDCODE'
begin;
create function pg_temp.check(ok boolean, msg text) returns text language sql as $$
  select case when ok then 'ok ' || msg else 'BAD ' || msg end $$;
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlstate;
end $$;
grant execute on function pg_temp.try(text) to service_role, authenticated;
-- Backfill (1a): exactly one grandfathered approval per PUBLISHED book
-- (P1, P2), buyer_file_only false, with its current title and paths.
-- A1 = a (Q1/R2/U2): exactly one per qualifying DRAFT (T, U, H, RF),
-- buyer_file_only true, grandfathered, no checklist, no decider, current
-- title and paths; none for D (never sold, published or taken down).
select pg_temp.check(
  (select count(*) from public.book_reviews) = 6
  and (select count(*) from public.book_reviews r join public.books b on b.id = r.book_id
        where b.status = 'published' and r.status = 'approved' and r.grandfathered and not r.buyer_file_only
          and r.checklist is null
          and r.book_title = b.title and r.author_id = b.author_id
          and r.file_path is not distinct from b.file_path and r.cover_path is not distinct from b.cover_path
          and r.decided_at is not null and r.decided_by is null) = 2
  and (select count(*) from public.book_reviews r join public.books b on b.id = r.book_id
        where b.status = 'draft' and r.status = 'approved' and r.grandfathered and r.buyer_file_only
          and r.checklist is null and r.decided_by is null and r.decided_at is not null
          and r.book_title = b.title and r.author_id = b.author_id
          and r.file_path is not distinct from b.file_path and r.cover_path is not distinct from b.cover_path) = 4
  and (select array_agg(b.title order by b.title) from public.book_reviews r join public.books b on b.id = r.book_id
        where r.buyer_file_only) = array['H', 'RF', 'T', 'U']
  and (select count(*) from public.book_reviews r group by r.book_id order by 1 desc limit 1) = 1
  and not exists (select 1 from public.book_reviews where book_id = 'e0774f01-0000-4000-8000-000000000003'),
  'backfill_exact');
-- R4: the Q1 counts on these fixtures, per condition and distinct (the
-- staging plan runs the same SELECT before apply).
select pg_temp.check(
  (select row(
     count(*) filter (where exists (select 1 from public.purchases pu where pu.book_id = bo.id)),
     count(*) filter (where bo.published_at is not null),
     count(*) filter (where exists (select 1 from public.book_takedowns t where t.book_id = bo.id)),
     count(*) filter (where (exists (select 1 from public.purchases pu where pu.book_id = bo.id)
                             or bo.published_at is not null
                             or exists (select 1 from public.book_takedowns t where t.book_id = bo.id))),
     count(*) filter (where bo.file_path is null
                        and (exists (select 1 from public.purchases pu where pu.book_id = bo.id)
                             or bo.published_at is not null
                             or exists (select 1 from public.book_takedowns t where t.book_id = bo.id))))::text
     from public.books bo where bo.status = 'draft') = '(2,2,1,4,1)',
  'q1_counts_purchases2_published2_takedown1_distinct4_nofile1');
-- The approval check ignores a buyer_file_only row whose paths match.
select pg_temp.check(not public.book_review_approval_valid('e0774f01-0000-4000-8000-000000000005',
    'e0774f00-0000-4000-8000-00000000000a/e0774f01-0000-4000-8000-000000000005.epub', 'e077c0de-0000-4000-8000-000000000005/cover.jpg'),
  'validity_ignores_buyer_file_only');
-- Old unpublishBook then performPublish (republish of unchanged files)
-- through the trusted writer: the grandfathered approval covers it.
set local role service_role;
select pg_temp.check(pg_temp.try($q$update public.books set status = 'draft' where id = 'e0774f01-0000-4000-8000-000000000002'$q$) = 'OK'
  and pg_temp.try($q$update public.books set status = 'published' where id = 'e0774f01-0000-4000-8000-000000000002'$q$) = 'OK',
  'old_unpublish_and_republish');
-- M7 (rollout window): the old updateBook's cover change on a live book
-- is refused after the migration ...
select pg_temp.check(pg_temp.try($q$update public.books set cover_path = 'e077c0de-0000-4000-8000-0000000000f1/cover.png'
                                    where id = 'e0774f01-0000-4000-8000-000000000001'$q$) = 'LB463', 'm7_live_cover_change_refused');
-- ... and so is its manuscript overwrite-in-place's file_path change.
select pg_temp.check(pg_temp.try($q$update public.books set file_path = 'e0774f00-0000-4000-8000-00000000000a/e0774f01-0000-4000-8000-000000000001/f0000000-0000-4000-8000-000000000001.epub'
                                    where id = 'e0774f01-0000-4000-8000-000000000001'$q$) = 'LB463', 'm7_live_file_change_refused');
-- Other columns of a live book still write.
select pg_temp.check(pg_temp.try($q$update public.books set title = 'P1 renamed' where id = 'e0774f01-0000-4000-8000-000000000001'$q$) = 'OK',
  'old_metadata_write_on_live_book');
-- The old first publish of a never-approved draft is refused (LB462).
select pg_temp.check(pg_temp.try($q$update public.books set status = 'published' where id = 'e0774f01-0000-4000-8000-000000000003'$q$) = 'LB462',
  'old_first_publish_refused');
-- The taken-down book: LB460 still fires first.
select pg_temp.check(pg_temp.try($q$update public.books set status = 'published' where id = 'e0774f01-0000-4000-8000-000000000004'$q$) = 'LB460',
  'takedown_lock_first');
-- A1: a once-published draft whose only approval is buyer_file_only
-- goes through review (LB462 if forced).
select pg_temp.check(pg_temp.try($q$update public.books set status = 'published' where id = 'e0774f01-0000-4000-8000-000000000005'$q$) = 'LB462',
  'buyer_file_only_draft_publish_refused');
reset role;
-- 9a without decided_at tricks: after Allow again, T is still refused.
select set_config('request.jwt.claim.sub', 'e0774f00-0000-4000-8000-0000000000dd', true);
set local role authenticated;
select count(*) from (select public.admin_allow_book_again('e0774f01-0000-4000-8000-000000000004')) allowed;
reset role;
set local role service_role;
select pg_temp.check((select lifted_at is not null from public.book_takedowns where book_id = 'e0774f01-0000-4000-8000-000000000004')
  and pg_temp.try($q$update public.books set status = 'published' where id = 'e0774f01-0000-4000-8000-000000000004'$q$) = 'LB462',
  'taken_down_after_allow_again_needs_review');
reset role;
-- Old author uploads: a final key is refused, a tmp key works.
select set_config('request.jwt.claim.sub', 'e0774f00-0000-4000-8000-00000000000a', true);
set local role authenticated;
select pg_temp.check(pg_temp.try($q$insert into storage.objects (bucket_id, name) values ('manuscripts', 'e0774f00-0000-4000-8000-00000000000a/e0774f01-0000-4000-8000-000000000002.epub')$q$) = '42501'
  and pg_temp.try($q$insert into storage.objects (bucket_id, name) values ('manuscripts', 'e0774f00-0000-4000-8000-00000000000a/tmp/epub/11111111-1111-4111-8111-111111111111.epub')$q$) = 'OK',
  'author_uploads_tmp_only');
-- The new flow: the author sends D for review; the moderator takes it
-- down, which cancels the pending review.
select public.request_book_review('e0774f01-0000-4000-8000-000000000003') is not null;
reset role;
select set_config('request.jwt.claim.sub', 'e0774f00-0000-4000-8000-0000000000dd', true);
set local role authenticated;
select public.admin_unpublish_book('e0774f01-0000-4000-8000-000000000003', 'copyright', 'Probe', null) is not null;
reset role;
select pg_temp.check((select status from public.book_reviews where book_id = 'e0774f01-0000-4000-8000-000000000003') = 'cancelled',
  'takedown_cancels_pending_review');
-- Account deletion keeps the review history with book_id/author_id null.
delete from auth.users where id = 'e0774f00-0000-4000-8000-00000000000a';
select pg_temp.check((select count(*) from public.books where title in ('P1', 'P1 renamed', 'P2', 'D', 'T', 'U')) = 0
  and (select count(*) from public.books) = 2
  and (select count(*) from public.book_reviews where book_id is null and author_id is null) = 5
  and not exists (select 1 from public.book_reviews where status = 'pending'),
  'account_deletion_keeps_review_history');
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
run_file "$DB_C" "$WORKDIR/premigration.sql" "$WORKDIR/premigration.out" "$WORKDIR/premigration.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/before_again.out" "$WORKDIR/before_again.err" || STEP_RC=1
run_file "$DB_C" "$MIGRATION" "$WORKDIR/migrate.out" "$WORKDIR/migrate.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after.out" "$WORKDIR/after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/oldcode.sql" "$WORKDIR/oldcode.out" "$WORKDIR/oldcode.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after_again.out" "$WORKDIR/after_again.err" || STEP_RC=1

ERRS=0
for e in before premigration before_again migrate after oldcode after_again; do
  [ -s "$WORKDIR/$e.err" ] && ERRS=1
done
if [ "$STEP_RC" -ne 0 ] || [ "$ERRS" -ne 0 ]; then
  echo "FAIL [populated_migration]: a step errored or wrote to stderr" >&2
  tail -n 5 "$WORKDIR"/*.err >&2 || true
  FAILURES=$((FAILURES + 1))
elif [ ! -s "$WORKDIR/before.out" ] || grep -q '<none>' "$WORKDIR/before.out"; then
  echo "FAIL [populated_migration]: the fixture inserted nothing" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/before_again.out" \
     || ! cmp -s "$WORKDIR/before.out" "$WORKDIR/after.out" \
     || ! cmp -s "$WORKDIR/after.out" "$WORKDIR/after_again.out"; then
  echo "FAIL [populated_migration]: an existing row changed (or a probe left a change)" >&2
  diff "$WORKDIR/before.out" "$WORKDIR/after.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated_migration]: books, book_takedowns, admin_audit_log, profiles, staff_members, storage.objects and purchases are byte-identical; rolled-back probes left nothing"
fi

SECTIONS=$((SECTIONS + 1))
if [ ! -s "$WORKDIR/premigration.out" ] || grep -q '^BAD ' "$WORKDIR/premigration.out" || [ "$(grep -c '^ok ' "$WORKDIR/premigration.out")" -ne 3 ]; then
  echo "FAIL [premigration]:" >&2
  cat "$WORKDIR/premigration.out" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [premigration]: $(grep -c '^ok ' "$WORKDIR/premigration.out") checks -- $(grep '^ok ' "$WORKDIR/premigration.out" | sed 's/^ok //' | tr '\n' ' ')"
fi

SECTIONS=$((SECTIONS + 1))
if [ ! -s "$WORKDIR/oldcode.out" ] || grep -q '^BAD ' "$WORKDIR/oldcode.out" || [ "$(grep -c '^ok ' "$WORKDIR/oldcode.out")" -ne 14 ]; then
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
  echo "FAIL: 077_book_reviews_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 077_book_reviews_catalog_equivalence.sh -- $SECTIONS sections: catalog identical between $PATCHED_LABEL and the base + migration, none empty; populated-data, backfill and rollout-window checks pass"
