#!/usr/bin/env bash
# ADMIN-2-TAKEDOWN: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema (1c126ff) plus
# supabase/migrations/20261020080000_book_takedowns.sql describe the
# same database -- across every catalog that can differ -- and that the
# migration over POPULATED data changes no existing row.
#
# Modelled on 074_pen_names_catalog_equivalence.sh; its generic
# machinery (schema resolution, the non-vacuous compare(), every catalog
# section) is carried over unchanged, with the effective-privilege
# sections pointed at the tables this migration adds or touches.
#
# Why the risk is concrete here: book_takedowns carries COLUMN-level
# SELECT grants, a partial unique index and two named CHECKs; the lock
# trigger, both RPCs and the restated list_admin_audit_events() must be
# byte-identical on both build paths, with the same ACLs.
#
# Part 2 builds the BASE, inserts rows (books, bundles, a report, an
# audit row), applies the migration and asserts no existing row
# changed, then exercises the old-code paths the rollout order relies
# on (the author's trusted writer publishing and unpublishing, a bundle
# publish, review_book_report) and the new lock, all rolled back.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer, because
# schema.sql uses the MAINTAIN privilege; on 16 pass stripped copies via
# BASE_SCHEMA, SCHEMA, MIGRATION and STUB):
#
#   ./supabase/tests/076_book_takedowns_catalog_equivalence.sh
#
# Overrides: BASE_REF, BASE_SCHEMA, MIGRATION, STUB, SCHEMA_PATH, MARKER,
# and either SCHEMA (an explicit patched-schema file) or PATCHED_REF (an
# explicit patched-schema commit). Exits non-zero on any difference, any
# empty section, any non-zero psql exit, or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against: origin/staging at the time, the merge of PR #62
# (PEN-2, on top of PR #61).
BASE_REF="${BASE_REF:-1c126ff4d60a98158552fc5e411e53e78feb8d9c}"
MIGRATION="${MIGRATION:-supabase/migrations/20261020080000_book_takedowns.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-ADMIN-2-TAKEDOWN}"
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
DB_A="librum_takedown_a_${SUFFIX}"
DB_B="librum_takedown_b_${SUFFIX}"
DB_C="librum_takedown_c_${SUFFIX}"
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

# The base must carry PEN-NAMES-1 (pen_names), PEN-NAMES-2 (public_books)
# and no book_takedowns table.
if ! grep -q "create table public.pen_names" "$WORKDIR/base_schema.sql" \
   || ! grep -q "create view public.public_books" "$WORKDIR/base_schema.sql" \
   || grep -q "create table public.book_takedowns" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: the base schema is not the 1c126ff base (pen_names / public_books / book_takedowns) -- wrong base" >&2
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

# Function sections: the new trigger function, the two RPCs and the
# replaced list_admin_audit_events() -- definition, security and ACL
# must be identical.
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
for tbl in book_takedowns books bundles bundle_books book_reports admin_audit_log profiles; do
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
      (select relrowsecurity from pg_catalog.pg_class where oid = 'public.book_takedowns'::regclass)
      and not has_table_privilege('anon', 'public.book_takedowns', 'SELECT')
      and not has_table_privilege('authenticated', 'public.book_takedowns', 'SELECT')
      and has_column_privilege('authenticated', 'public.book_takedowns', 'message_to_author', 'SELECT')
      and not has_column_privilege('authenticated', 'public.book_takedowns', 'id', 'SELECT')
      and not has_column_privilege('authenticated', 'public.book_takedowns', 'taken_down_by', 'SELECT')
      and not has_table_privilege('service_role', 'public.book_takedowns', 'INSERT, UPDATE, DELETE, TRUNCATE')
      and has_table_privilege('service_role', 'public.book_takedowns', 'SELECT')
      and has_function_privilege('authenticated', 'public.admin_unpublish_book(uuid,text,text,uuid)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.admin_unpublish_book(uuid,text,text,uuid)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.admin_allow_book_again(uuid)', 'EXECUTE')
      and exists (select 1 from pg_catalog.pg_trigger where tgname = 'books_refuse_publish_while_taken_down'
                   and tgrelid = 'public.books'::regclass)
      and exists (select 1 from pg_catalog.pg_trigger where tgname = 'books_refuse_delete_while_taken_down'
                   and tgrelid = 'public.books'::regclass)
      and not has_function_privilege('authenticated', 'public.books_refuse_delete_while_taken_down()', 'EXECUTE')
      and pg_catalog.pg_get_functiondef('public.list_admin_audit_events(text,uuid,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,uuid,integer)'::regprocedure) ~ 'book.allowed_again'
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry ADMIN-2-TAKEDOWN" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: book_takedowns (RLS, column SELECT only, no writes), both RPCs for authenticated, the publish and delete lock triggers, the audit allow-list"
  fi
done

# ============================================================
# Part 2: the migration over POPULATED base data, then the old-code
# paths of the rollout window and the new lock, all rolled back.
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
-- A: author with P1 (published, Librum's choice, in published bundle
-- U1), P2 (published, in U1), D (draft). R: reader with an open report
-- on P1. M: moderator. One existing audit row.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0764f00-0000-4000-8000-00000000000a', 'p076e-a@test', now(), '{"role":"author","display_name":"P076E Ana"}'),
  ('e0764f00-0000-4000-8000-0000000000aa', 'p076e-r@test', now(), '{"role":"reader","display_name":"P076E Reader"}'),
  ('e0764f00-0000-4000-8000-0000000000dd', 'p076e-m@test', now(), '{"role":"reader","display_name":"P076E Moderator"}');
insert into public.staff_members (user_id, role) values ('e0764f00-0000-4000-8000-0000000000dd', 'moderator');
insert into public.books (id, author_id, title, status, price_all, published_at, created_at) values
  ('e0764f01-0000-4000-8000-000000000001', 'e0764f00-0000-4000-8000-00000000000a', 'P1', 'published', 499, now(), '2026-01-01'),
  ('e0764f01-0000-4000-8000-000000000002', 'e0764f00-0000-4000-8000-00000000000a', 'P2', 'published', 199, now(), '2026-01-02'),
  ('e0764f01-0000-4000-8000-000000000003', 'e0764f00-0000-4000-8000-00000000000a', 'D',  'draft',     199, null,  '2026-01-03');
update public.books set librum_choice_at = '2026-10-01' where id = 'e0764f01-0000-4000-8000-000000000001';
insert into public.bundles (id, author_id, title, status, price_all) values
  ('e0764f03-0000-4000-8000-000000000001', 'e0764f00-0000-4000-8000-00000000000a', 'U1', 'published', 599);
insert into public.bundle_books (bundle_id, book_id) values
  ('e0764f03-0000-4000-8000-000000000001', 'e0764f01-0000-4000-8000-000000000001'),
  ('e0764f03-0000-4000-8000-000000000001', 'e0764f01-0000-4000-8000-000000000002');
insert into public.book_reports (id, book_id, reporter_id, reason) values
  ('e0764f05-0000-4000-8000-000000000001', 'e0764f01-0000-4000-8000-000000000001', 'e0764f00-0000-4000-8000-0000000000aa', 'Copyright infringement'),
  ('e0764f05-0000-4000-8000-000000000002', 'e0764f01-0000-4000-8000-000000000002', 'e0764f00-0000-4000-8000-0000000000aa', 'Other');
insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata, created_at) values
  ('e0764f00-0000-4000-8000-0000000000dd', 'report.dismissed', 'book_reports', 'e0764f05-0000-4000-8000-000000000002', '{}', '2026-10-02');
FIXTURES

cat > "$WORKDIR/fingerprint.sql" <<'FP'
select 'books:' || coalesce(string_agg(pg_catalog.to_jsonb(b)::text, ',' order by b.id), '<none>') from public.books b;
select 'bundles:' || coalesce(string_agg(pg_catalog.to_jsonb(u)::text, ',' order by u.id), '<none>') from public.bundles u;
select 'bundle_books:' || coalesce(string_agg(pg_catalog.to_jsonb(x)::text, ',' order by x.id), '<none>') from public.bundle_books x;
select 'book_reports:' || coalesce(string_agg(pg_catalog.to_jsonb(r)::text, ',' order by r.id), '<none>') from public.book_reports r;
select 'admin_audit_log:' || coalesce(string_agg(pg_catalog.to_jsonb(a)::text, ',' order by a.id), '<none>') from public.admin_audit_log a;
select 'profiles:' || coalesce(string_agg(pg_catalog.to_jsonb(p)::text, ',' order by p.id), '<none>') from public.profiles p;
FP

# Old code after the migration, then the new lock -- all rolled back.
cat > "$WORKDIR/oldcode.sql" <<'OLDCODE'
begin;
create function pg_temp.check(ok boolean, msg text) returns text language sql as $$
  select case when ok then 'ok ' || msg else 'BAD ' || msg end $$;
select pg_temp.check((select count(*) from public.book_takedowns) = 0, 'no_takedown_rows_backfilled');
-- old unpublishBook / performPublish through the trusted writer
set local role service_role;
update public.books set status = 'draft' where id = 'e0764f01-0000-4000-8000-000000000003';
update public.books set status = 'published' where id = 'e0764f01-0000-4000-8000-000000000003';
reset role;
select pg_temp.check((select status from public.books where id = 'e0764f01-0000-4000-8000-000000000003') = 'published', 'old_publish_without_takedown');
-- old bundle publish
set local role service_role;
update public.bundles set status = 'draft' where id = 'e0764f03-0000-4000-8000-000000000001';
update public.bundles set status = 'published' where id = 'e0764f03-0000-4000-8000-000000000001';
reset role;
select pg_temp.check((select status from public.bundles where id = 'e0764f03-0000-4000-8000-000000000001') = 'published', 'old_bundle_publish');
-- old review_book_report as the moderator
select set_config('request.jwt.claim.sub', 'e0764f00-0000-4000-8000-0000000000dd', true);
set local role authenticated;
select public.review_book_report('e0764f05-0000-4000-8000-000000000002', 'dismissed', null);
-- the new takedown, as the moderator
select public.admin_unpublish_book('e0764f01-0000-4000-8000-000000000001', 'copyright', 'Probe', 'e0764f05-0000-4000-8000-000000000001') is not null;
reset role;
select set_config('request.jwt.claim.sub', '', true);
select pg_temp.check((select status from public.book_reports where id = 'e0764f05-0000-4000-8000-000000000002') = 'dismissed', 'old_review_book_report');
select pg_temp.check((select status = 'draft' and librum_choice_at is null from public.books where id = 'e0764f01-0000-4000-8000-000000000001')
  and (select status from public.bundles where id = 'e0764f03-0000-4000-8000-000000000001') = 'draft'
  and (select status from public.book_reports where id = 'e0764f05-0000-4000-8000-000000000001') = 'resolved', 'takedown_over_populated_data');
-- the lock, for the trusted writer
create function pg_temp.try_publish() returns text language plpgsql as $$
begin
  update public.books set status = 'published' where id = 'e0764f01-0000-4000-8000-000000000001';
  return 'published';
exception when sqlstate 'LB460' then
  return 'LB460';
end $$;
grant execute on function pg_temp.try_publish() to service_role;
set local role service_role;
select pg_temp.check(pg_temp.try_publish() = 'LB460', 'lock_refuses_trusted_writer');
reset role;
-- the delete lock (audit A1 = a): the trusted writer's direct delete of
-- the taken-down P1 is refused; an old delete of an untouched draft
-- still works; deleting the account cascades through the takedown and
-- keeps its row.
create function pg_temp.try_delete(p uuid) returns text language plpgsql as $$
begin
  delete from public.books where id = p;
  return 'deleted';
exception when sqlstate 'LB461' then
  return 'LB461';
end $$;
grant execute on function pg_temp.try_delete(uuid) to service_role;
set local role service_role;
select pg_temp.check(pg_temp.try_delete('e0764f01-0000-4000-8000-000000000001') = 'LB461', 'delete_lock_refuses_trusted_writer');
select pg_temp.check(pg_temp.try_delete('e0764f01-0000-4000-8000-000000000003') = 'deleted', 'old_delete_without_takedown');
reset role;
delete from public.book_reports where reporter_id = 'e0764f00-0000-4000-8000-0000000000aa';
delete from auth.users where id = 'e0764f00-0000-4000-8000-00000000000a';
select pg_temp.check((select count(*) from public.books) = 0
  and (select count(*) from public.book_takedowns where book_id is null and author_id is null and book_title = 'P1' and lifted_at is null) = 1,
  'account_deletion_cascades_through_takedown');
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
  echo "FAIL [populated_migration]: the fixture inserted nothing" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/after.out" || ! cmp -s "$WORKDIR/after.out" "$WORKDIR/after_again.out"; then
  echo "FAIL [populated_migration]: an existing row changed (or a probe left a change)" >&2
  diff "$WORKDIR/before.out" "$WORKDIR/after.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated_migration]: books, bundles, bundle_books, book_reports, admin_audit_log and profiles are byte-identical; rolled-back probes left nothing"
fi

SECTIONS=$((SECTIONS + 1))
if [ ! -s "$WORKDIR/oldcode.out" ] || grep -q '^BAD ' "$WORKDIR/oldcode.out" || [ "$(grep -c '^ok ' "$WORKDIR/oldcode.out")" -ne 9 ]; then
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
  echo "FAIL: 076_book_takedowns_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 076_book_takedowns_catalog_equivalence.sh -- $SECTIONS sections: catalog identical between $PATCHED_LABEL and the base + migration, none empty; populated-data and rollout-window checks pass"
