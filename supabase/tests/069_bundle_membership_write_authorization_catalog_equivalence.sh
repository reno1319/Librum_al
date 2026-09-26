#!/usr/bin/env bash
# BUNDLE-MEMBERSHIP-AUTH-1: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema plus BOTH
# Patch 13 migrations --
#   supabase/migrations/20260926061034_bundle_membership_trusted_writer.sql
#   supabase/migrations/20260926061037_bundle_membership_write_authorization.sql
# -- describe the same database across every catalog that can differ
# (columns, constraints, indexes, views, triggers, function definitions,
# signatures, defaults, bodies, security, ACLs, table and column ACLs, RLS,
# policies, types, schema ACLs, extensions, comments, and effective
# privileges resolved per role), each section non-vacuous.
#
# Modelled on 068_avatar_storage_path_authorization_catalog_equivalence.sh;
# its generic machinery is carried over unchanged.
#
# Part 2 is the ROLLOUT proof. Over a POPULATED base it applies the two
# migrations one at a time and, at every state, measures with
# rollback-only probes (each probe is rolled back on its own, so no probe
# can influence the next) what the OLD application's writes (the author's
# session deleting and inserting bundle_books) and the NEW application's
# writes (service_role calling the three functions, including the
# complete edit update_bundle_with_membership) actually do. The binding
# rollout has FOUR states; states 2 and 3 are the same database (only the
# application calling it differs), so the harness measures both
# applications there -- during the deploy, old and new instances serve
# side by side:
#
#   1 base                        old app works; new app cannot (no function)
#   2 migration 1 only            old app works (nothing it uses changed)
#   3 migration 1 + new app       new app works, AND the old app still
#                                 works (old/new instances overlap)
#   4 migration 1 + new app       old app's membership writes refused
#     + migration 2               (42501); new app works
#   X migration 2 ONLY            (the FORBIDDEN order) old app refused and
#                                 the new app has no function: both broken
#
# Database states probed: S0 = state 1, S1 = states 2 and 3, S2 = state 4.
# So the only order with no broken window is migration 1, then the new
# application deployed and READY, then migration 2. It also proves that
# neither migration rewrites a row, and that nothing outside bundle_books'
# ACL and the three new functions drifts.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer):
#
#   ./supabase/tests/069_bundle_membership_write_authorization_catalog_equivalence.sh
#
# Overrides: BASE_REF, MIGRATION_1, MIGRATION, STUB, SCHEMA_PATH, MARKER,
# and either SCHEMA (an explicit patched-schema file) or PATCHED_REF (an
# explicit patched-schema commit). Exits non-zero on any difference, any
# empty section, any non-zero psql exit, or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE these migrations were
# written against: origin/staging at the time, the merge of PR #33.
BASE_REF="${BASE_REF:-6d0c3cefbccb242f0d82b62dcbdd6650de93cda2}"
# Migration 1 (additive writer) and migration 2 (restrictive ACL). The
# introduction boundary is resolved from MIGRATION, the final one.
MIGRATION_1="${MIGRATION_1:-supabase/migrations/20260926061034_bundle_membership_trusted_writer.sql}"
MIGRATION="${MIGRATION:-supabase/migrations/20260926061037_bundle_membership_write_authorization.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-BUNDLE-MEMBERSHIP-AUTH-1}"
# These migrations may still be uncommitted, so the working-tree
# comparison is permitted here. Harnesses for merged migrations set 0.
ALLOW_WORKTREE=1

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

for f in "$MIGRATION_1" "$MIGRATION" "$STUB"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: $f not found -- run this from a checkout that carries the patch" >&2
    exit 1
  fi
done

SUFFIX="$$"
DB_A="librum_bundle_membership_a_${SUFFIX}"
DB_B="librum_bundle_membership_b_${SUFFIX}"
DB_C="librum_bundle_membership_c_${SUFFIX}"
DB_X="librum_bundle_membership_x_${SUFFIX}"
WORKDIR="$(mktemp -d)"

cleanup() {
  dropdb --if-exists "$DB_A" >/dev/null 2>&1 || true
  dropdb --if-exists "$DB_B" >/dev/null 2>&1 || true
  dropdb --if-exists "$DB_C" >/dev/null 2>&1 || true
  dropdb --if-exists "$DB_X" >/dev/null 2>&1 || true
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
      if ! git diff --quiet -- "$SCHEMA_PATH" "$MIGRATION_1" "$MIGRATION" 2>/dev/null; then
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

# The base must actually be the OPEN state -- bundle_books with no ACL
# reset of its own (so anon and authenticated hold the platform's
# table-level grants) and no writer function -- or "the hole is closed"
# is being proved against a database that never had it.
if grep -q 'on public\.bundle_books from' "$WORKDIR/base_schema.sql" \
   || grep -q 'replace_bundle_membership' "$WORKDIR/base_schema.sql" \
   || ! grep -q 'create policy "Authors can add books to their own bundles"' "$WORKDIR/base_schema.sql"; then
  echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} is not the open bundle_books base -- wrong base" >&2
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
echo "  building B: ${BASE_REF:0:9}:$SCHEMA_PATH + $MIGRATION_1 + $MIGRATION"
build "$DB_B" "$STUB" "$WORKDIR/base_schema.sql" "$MIGRATION_1" "$MIGRATION"

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

# Function sections: the pair ADDS three functions (replace_bundle_membership,
# create_bundle_with_membership, update_bundle_with_membership) and changes
# no existing one; these prove
# signatures, defaults, bodies, security and ACLs agree on both paths.
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

# Function ACLs. The three new functions are service_role-only; every
# existing function ACL is unchanged. Both claims are compared here.
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

# Object comments. These migrations ship none, and "ships none" is a
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
for tbl in bundle_books bundles books; do
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
 cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']::text[]) as priv
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
      not has_table_privilege('authenticated', 'public.bundle_books', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
      and not has_table_privilege('anon', 'public.bundle_books', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
      and not has_any_column_privilege('authenticated', 'public.bundle_books', 'INSERT, UPDATE, REFERENCES')
      and not has_any_column_privilege('anon', 'public.bundle_books', 'INSERT, UPDATE, REFERENCES')
      and not has_any_column_privilege('public', 'public.bundle_books', 'SELECT, INSERT, UPDATE, REFERENCES')
      and has_table_privilege('anon', 'public.bundle_books', 'SELECT')
      and has_table_privilege('authenticated', 'public.bundle_books', 'SELECT')
      and has_table_privilege('service_role', 'public.bundle_books', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
      and (select relrowsecurity and not relforcerowsecurity from pg_class where oid = 'public.bundle_books'::regclass)
      and has_function_privilege('service_role', 'public.replace_bundle_membership(uuid, uuid, uuid[])', 'EXECUTE')
      and has_function_privilege('service_role', 'public.create_bundle_with_membership(uuid, uuid, text, text, integer, uuid[])', 'EXECUTE')
      and has_function_privilege('service_role', 'public.update_bundle_with_membership(uuid, uuid, text, boolean, integer, text, text, integer, uuid[])', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.update_bundle_with_membership(uuid, uuid, text, boolean, integer, text, text, integer, uuid[])', 'EXECUTE')
      and not has_function_privilege('anon', 'public.update_bundle_with_membership(uuid, uuid, text, boolean, integer, text, text, integer, uuid[])', 'EXECUTE')
      and not has_function_privilege('public', 'public.update_bundle_with_membership(uuid, uuid, text, boolean, integer, text, text, integer, uuid[])', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.replace_bundle_membership(uuid, uuid, uuid[])', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.create_bundle_with_membership(uuid, uuid, text, text, integer, uuid[])', 'EXECUTE')
      and not has_function_privilege('anon', 'public.replace_bundle_membership(uuid, uuid, uuid[])', 'EXECUTE')
      and not has_function_privilege('anon', 'public.create_bundle_with_membership(uuid, uuid, text, text, integer, uuid[])', 'EXECUTE')
      and not has_function_privilege('public', 'public.replace_bundle_membership(uuid, uuid, uuid[])', 'EXECUTE')
      and not has_function_privilege('public', 'public.create_bundle_with_membership(uuid, uuid, text, text, integer, uuid[])', 'EXECUTE')
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry the BUNDLE-MEMBERSHIP-AUTH-1 ACL and writer functions" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: bundle_books SELECT-only for anon/authenticated, nothing for PUBLIC, service_role intact, RLS on; all three writers EXECUTE for service_role only"
  fi
done

for db in "$DB_A" "$DB_B"; do
  ACL="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select coalesce(c.relacl::text, '<default>') from pg_catalog.pg_class c
     where c.oid = 'public.bundle_books'::regclass" 2>/dev/null)"
  FACL="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select string_agg(p.proname || '=' || coalesce(p.proacl::text, '<default>'), ' ' order by p.proname)
      from pg_catalog.pg_proc p
     where p.proname in ('replace_bundle_membership', 'create_bundle_with_membership', 'update_bundle_with_membership')" 2>/dev/null)"
  echo "  measured [$db bundle_books]: relacl=$ACL"
  echo "  measured [$db writers]: $FACL"
done

# ============================================================
# Part 2: the rollout, state by state, over POPULATED data.
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0690e00-0000-4000-8000-00000000000a', 'p069e-a@test', now(), '{"role":"author","display_name":"P069E A"}'),
  ('e0690e00-0000-4000-8000-00000000000b', 'p069e-b@test', now(), '{"role":"author","display_name":"P069E B"}');
update public.profiles set role = 'author'
  where id in ('e0690e00-0000-4000-8000-00000000000a', 'e0690e00-0000-4000-8000-00000000000b');
insert into public.books (id, author_id, title, status, price_all, published_at) values
  ('e0690e10-0000-4000-8000-0000000000a1', 'e0690e00-0000-4000-8000-00000000000a', 'A1', 'published', 199, now()),
  ('e0690e10-0000-4000-8000-0000000000a2', 'e0690e00-0000-4000-8000-00000000000a', 'A2', 'published', 0, now()),
  ('e0690e10-0000-4000-8000-0000000000a3', 'e0690e00-0000-4000-8000-00000000000a', 'A3', 'published', 0, now()),
  ('e0690e10-0000-4000-8000-0000000000a4', 'e0690e00-0000-4000-8000-00000000000a', 'A4 draft', 'draft', 0, null),
  ('e0690e10-0000-4000-8000-0000000000a5', 'e0690e00-0000-4000-8000-00000000000a', 'A5 draft', 'draft', 0, null),
  ('e0690e10-0000-4000-8000-0000000000b1', 'e0690e00-0000-4000-8000-00000000000b', 'B1', 'published', 0, now());
insert into public.bundles (id, author_id, title, status, price_all) values
  ('e0690e20-0000-4000-8000-0000000000a1', 'e0690e00-0000-4000-8000-00000000000a', 'A published', 'published', 299),
  ('e0690e20-0000-4000-8000-0000000000b1', 'e0690e00-0000-4000-8000-00000000000b', 'B draft', 'draft', 0);
-- An existing membership, including a row that ALREADY points at a draft
-- book (possible through the old direct-write hole): the migrations must
-- leave every row exactly as it is.
insert into public.bundle_books (id, bundle_id, book_id) values
  ('e0690e30-0000-4000-8000-000000000001', 'e0690e20-0000-4000-8000-0000000000a1', 'e0690e10-0000-4000-8000-0000000000a1'),
  ('e0690e30-0000-4000-8000-000000000002', 'e0690e20-0000-4000-8000-0000000000a1', 'e0690e10-0000-4000-8000-0000000000a2'),
  ('e0690e30-0000-4000-8000-000000000003', 'e0690e20-0000-4000-8000-0000000000a1', 'e0690e10-0000-4000-8000-0000000000a4');
FIXTURES

cat > "$WORKDIR/fingerprint.sql" <<'FINGERPRINT'
select 'bundle_books:' || coalesce(string_agg(row_to_json(x)::text, ',' order by x.id), '<none>') from public.bundle_books x
union all
select 'bundles:' || coalesce(string_agg(row_to_json(x)::text, ',' order by x.id), '<none>') from public.bundles x
union all
select 'books:' || coalesce(string_agg(row_to_json(x)::text, ',' order by x.id), '<none>') from public.books x;
FINGERPRINT

# Everything these migrations must NOT change: every relation ACL except
# bundle_books, every column ACL, every function ACL and body except the
# three new functions, every schema ACL, every policy (bundle_books'
# included), RLS flags, triggers, and every column default.
cat > "$WORKDIR/unrelated.sql" <<'UNRELATED'
select 'rel:' || n.nspname || '.' || c.relname || '=' || coalesce(c.relacl::text, '<default>')
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_%'
   and c.relkind in ('r', 'v', 'm', 'S', 'p', 'f')
   and not (n.nspname = 'public' and c.relname = 'bundle_books')
union all
select 'col:' || n.nspname || '.' || c.relname || '.' || a.attname || '=' || a.attacl::text
  from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname not in ('pg_catalog', 'information_schema') and a.attacl is not null
union all
select 'fn:' || p.oid::regprocedure::text || '=' || coalesce(p.proacl::text, '<default>') || '|' || md5(p.prosrc)
       || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public', 'auth', 'storage', 'extensions')
   and p.proname not in ('replace_bundle_membership', 'create_bundle_with_membership', 'update_bundle_with_membership')
union all
select 'nsp:' || n.nspname || '=' || coalesce(n.nspacl::text, '<default>')
  from pg_catalog.pg_namespace n
 where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
union all
select 'pol:' || schemaname || '.' || tablename || '.' || policyname || '|' || permissive || '|'
       || coalesce(array_to_string(roles, ','), '') || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
  from pg_catalog.pg_policies
union all
select 'rls:' || n.nspname || '.' || c.relname || '=' || c.relrowsecurity::text || '/' || c.relforcerowsecurity::text
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public', 'storage') and c.relkind = 'r'
union all
select 'trg:' || c.relname || '.' || t.tgname || '=' || pg_catalog.pg_get_triggerdef(t.oid)
  from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
 where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
union all
select 'con:' || c.relname || '.' || con.conname || '=' || pg_catalog.pg_get_constraintdef(con.oid)
  from pg_catalog.pg_constraint con join pg_catalog.pg_class c on c.oid = con.conrelid
 where c.relnamespace = 'public'::regnamespace
union all
select 'idx:' || indexname || '=' || indexdef from pg_catalog.pg_indexes where schemaname = 'public'
union all
select 'default:' || c.relname || '.' || a.attname || '=' || pg_catalog.pg_get_expr(d.adbin, d.adrelid)
  from pg_catalog.pg_attrdef d
  join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
  join pg_catalog.pg_class c on c.oid = d.adrelid
 where c.relnamespace = 'public'::regnamespace
order by 1;
UNRELATED

# One probe per statement. Every probe is rolled back ON ITS OWN (the
# probe raises a private SQLSTATE after measuring, which unwinds its
# subtransaction), and the file as a whole is rolled back too. Each prints
# '<label>=OK:<rows>' or '<label>=<sqlstate>'.
cat > "$WORKDIR/probe.sql" <<'PROBE'
begin;
create function pg_temp.probe(p_label text, p_role text, p_sub text, p_sql text) returns text language plpgsql as $$
declare v_state text; v_rows bigint; v_msg text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    raise exception using errcode = 'P0999', message = v_rows::text;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state = 'P0999' then v_state := 'OK:' || v_msg; end if;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return p_label || '=' || v_state;
end $$;
-- The OLD application (pre-Patch 13) on the author's session.
select pg_temp.probe('old_create_membership', 'authenticated', 'e0690e00-0000-4000-8000-00000000000a',
  $q$insert into public.bundle_books (bundle_id, book_id) values ('e0690e20-0000-4000-8000-0000000000a1', 'e0690e10-0000-4000-8000-0000000000a3')$q$);
select pg_temp.probe('old_edit_delete', 'authenticated', 'e0690e00-0000-4000-8000-00000000000a',
  $q$delete from public.bundle_books where bundle_id = 'e0690e20-0000-4000-8000-0000000000a1'$q$);
select pg_temp.probe('old_add_draft_book', 'authenticated', 'e0690e00-0000-4000-8000-00000000000a',
  $q$insert into public.bundle_books (bundle_id, book_id) values ('e0690e20-0000-4000-8000-0000000000a1', 'e0690e10-0000-4000-8000-0000000000a5')$q$);
-- The old updateBundle's separate details write (service_role since
-- Patch 7): untouched by either migration.
select pg_temp.probe('old_update_details', 'service_role', null,
  $q$update public.bundles set title = 'Old edit', description = 'd', price_all = 299 where id = 'e0690e20-0000-4000-8000-0000000000a1' and author_id = 'e0690e00-0000-4000-8000-00000000000a' and status = 'published' and price_all = 299$q$);
select pg_temp.probe('cross_author_insert', 'authenticated', 'e0690e00-0000-4000-8000-00000000000a',
  $q$insert into public.bundle_books (bundle_id, book_id) values ('e0690e20-0000-4000-8000-0000000000b1', 'e0690e10-0000-4000-8000-0000000000a1')$q$);
select pg_temp.probe('cross_author_delete', 'authenticated', 'e0690e00-0000-4000-8000-00000000000b',
  $q$delete from public.bundle_books where bundle_id = 'e0690e20-0000-4000-8000-0000000000a1'$q$);
select pg_temp.probe('author_update', 'authenticated', 'e0690e00-0000-4000-8000-00000000000a',
  $q$update public.bundle_books set book_id = book_id$q$);
select pg_temp.probe('author_truncate', 'authenticated', 'e0690e00-0000-4000-8000-00000000000a',
  $q$truncate public.bundle_books$q$);
select pg_temp.probe('anon_insert', 'anon', null,
  $q$insert into public.bundle_books (bundle_id, book_id) values ('e0690e20-0000-4000-8000-0000000000a1', 'e0690e10-0000-4000-8000-0000000000a3')$q$);
select pg_temp.probe('anon_truncate', 'anon', null, $q$truncate public.bundle_books$q$);
-- Reads. Bundle A1 is published, so its three rows are public: anon
-- and another author both see them (policy "Bundle contents are viewable
-- wherever the bundle is"); B's own draft bundle has no rows.
select pg_temp.probe('anon_read', 'anon', null, $q$select 1 from public.bundle_books$q$);
select pg_temp.probe('author_b_read', 'authenticated', 'e0690e00-0000-4000-8000-00000000000b', $q$select 1 from public.bundle_books$q$);
-- The NEW application, as service_role.
select pg_temp.probe('new_replace', 'service_role', null,
  $q$select * from public.replace_bundle_membership('e0690e20-0000-4000-8000-0000000000a1', 'e0690e00-0000-4000-8000-00000000000a', array['e0690e10-0000-4000-8000-0000000000a2', 'e0690e10-0000-4000-8000-0000000000a3']::uuid[])$q$);
select pg_temp.probe('new_create', 'service_role', null,
  $q$select * from public.create_bundle_with_membership('e0690e20-0000-4000-8000-0000000000a9', 'e0690e00-0000-4000-8000-00000000000a', 'New', '', 0, array['e0690e10-0000-4000-8000-0000000000a1', 'e0690e10-0000-4000-8000-0000000000a2']::uuid[])$q$);
select pg_temp.probe('new_update', 'service_role', null,
  $q$select * from public.update_bundle_with_membership('e0690e20-0000-4000-8000-0000000000a1', 'e0690e00-0000-4000-8000-00000000000a', 'published', true, 299, 'Edited', 'd', 299, array['e0690e10-0000-4000-8000-0000000000a2', 'e0690e10-0000-4000-8000-0000000000a3']::uuid[])$q$);
select pg_temp.probe('author_calls_writer', 'authenticated', 'e0690e00-0000-4000-8000-00000000000a',
  $q$select * from public.replace_bundle_membership('e0690e20-0000-4000-8000-0000000000a1', 'e0690e00-0000-4000-8000-00000000000a', array['e0690e10-0000-4000-8000-0000000000a2', 'e0690e10-0000-4000-8000-0000000000a3']::uuid[])$q$);
select pg_temp.probe('author_calls_update', 'authenticated', 'e0690e00-0000-4000-8000-00000000000a',
  $q$select * from public.update_bundle_with_membership('e0690e20-0000-4000-8000-0000000000a1', 'e0690e00-0000-4000-8000-00000000000a', null, false, null, 'Edited', 'd', 299, array['e0690e10-0000-4000-8000-0000000000a2', 'e0690e10-0000-4000-8000-0000000000a3']::uuid[])$q$);
-- Cascades and fixture tooling.
select pg_temp.probe('author_delete_bundle', 'authenticated', 'e0690e00-0000-4000-8000-00000000000a',
  $q$delete from public.bundles where id = 'e0690e20-0000-4000-8000-0000000000a1'$q$);
select pg_temp.probe('author_delete_book', 'authenticated', 'e0690e00-0000-4000-8000-00000000000a',
  $q$delete from public.books where id = 'e0690e10-0000-4000-8000-0000000000a2'$q$);
select pg_temp.probe('service_fixture_upsert', 'service_role', null,
  $q$insert into public.bundle_books (id, bundle_id, book_id) values ('e0690e30-0000-4000-8000-000000000009', 'e0690e20-0000-4000-8000-0000000000a1', 'e0690e10-0000-4000-8000-0000000000a1') on conflict (bundle_id, book_id) do update set id = excluded.id$q$);
select pg_temp.probe('service_teardown', 'service_role', null,
  $q$delete from public.bundles where author_id = 'e0690e00-0000-4000-8000-00000000000a'$q$);
rollback;
PROBE

# A cascade probe that MEASURES the cascade: runs the author's own bundle
# delete and book delete, then counts the membership left, all rolled back.
cat > "$WORKDIR/cascade.sql" <<'CASCADE'
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = 'e0690e00-0000-4000-8000-00000000000a';
delete from public.books where id = 'e0690e10-0000-4000-8000-0000000000a2';
reset role;
select 'after_book_delete=' || count(*) from public.bundle_books where bundle_id = 'e0690e20-0000-4000-8000-0000000000a1';
set local role authenticated;
delete from public.bundles where id = 'e0690e20-0000-4000-8000-0000000000a1';
reset role;
select 'after_bundle_delete=' || count(*) from public.bundle_books where bundle_id = 'e0690e20-0000-4000-8000-0000000000a1';
rollback;
CASCADE

run_file() {
  local db="$1" file="$2" out="$3" err="$4" rc
  set +e
  psql -X -q -t -A -F '|' -d "$db" -v ON_ERROR_STOP=1 -f "$file" > "$out" 2> "$err"
  rc=$?
  set -e
  return $rc
}

probe_state() {
  local db="$1" tag="$2"
  run_file "$db" "$WORKDIR/probe.sql" "$WORKDIR/probe_${tag}.out" "$WORKDIR/probe_${tag}.err" || STEP_RC=1
  run_file "$db" "$WORKDIR/cascade.sql" "$WORKDIR/cascade_${tag}.out" "$WORKDIR/cascade_${tag}.err" || STEP_RC=1
  run_file "$db" "$WORKDIR/fingerprint.sql" "$WORKDIR/fp_${tag}.out" "$WORKDIR/fp_${tag}.err" || STEP_RC=1
  run_file "$db" "$WORKDIR/unrelated.sql" "$WORKDIR/unrelated_${tag}.out" "$WORKDIR/unrelated_${tag}.err" || STEP_RC=1
}

echo "  building C: ${BASE_REF:0:9}:$SCHEMA_PATH + rows, then migration 1, then migration 2"
build "$DB_C" "$STUB" "$WORKDIR/base_schema.sql" "$WORKDIR/rows.sql"
echo "  building X: ${BASE_REF:0:9}:$SCHEMA_PATH + rows, then migration 2 ONLY (the forbidden order)"
build "$DB_X" "$STUB" "$WORKDIR/base_schema.sql" "$WORKDIR/rows.sql"

SECTIONS=$((SECTIONS + 1))
STEP_RC=0
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/fp_initial.out" "$WORKDIR/fp_initial.err" || STEP_RC=1
probe_state "$DB_C" s0
run_file "$DB_C" "$MIGRATION_1" "$WORKDIR/m1.out" "$WORKDIR/m1.err" || STEP_RC=1
probe_state "$DB_C" s1
run_file "$DB_C" "$MIGRATION" "$WORKDIR/m2.out" "$WORKDIR/m2.err" || STEP_RC=1
probe_state "$DB_C" s2
run_file "$DB_X" "$WORKDIR/fingerprint.sql" "$WORKDIR/fp_x_initial.out" "$WORKDIR/fp_x_initial.err" || STEP_RC=1
run_file "$DB_X" "$MIGRATION" "$WORKDIR/mx.out" "$WORKDIR/mx.err" || STEP_RC=1
probe_state "$DB_X" x

ERRS="$(find "$WORKDIR" -maxdepth 1 -name '*.err' -size +0 -newer "$WORKDIR/rows.sql" | grep -v -e '/build.err$' -e '/present.err$' || true)"
if [ "$STEP_RC" -ne 0 ] || [ -n "$ERRS" ]; then
  echo "FAIL [rollout_states]: a step errored or wrote to stderr" >&2
  for f in $ERRS; do echo "  $f:" >&2; tail -n 5 "$f" >&2; done
  FAILURES=$((FAILURES + 1))
elif ! grep -q 'e0690e10-0000-4000-8000-0000000000a4' "$WORKDIR/fp_initial.out"; then
  echo "FAIL [rollout_states]: the fixture inserted nothing -- this comparison would pass vacuously" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [rollout_states]: every state built and probed without error"
fi

SECTIONS=$((SECTIONS + 1))
if cmp -s "$WORKDIR/fp_initial.out" "$WORKDIR/fp_s0.out" && cmp -s "$WORKDIR/fp_initial.out" "$WORKDIR/fp_s1.out" \
   && cmp -s "$WORKDIR/fp_initial.out" "$WORKDIR/fp_s2.out" && cmp -s "$WORKDIR/fp_x_initial.out" "$WORKDIR/fp_x.out"; then
  echo "  ok [no_row_rewritten]: bundle_books, bundles and books (incl. a pre-existing draft-book member) are byte-identical in every state; no probe left anything behind"
  echo "    measured: fingerprint md5=$(md5sum < "$WORKDIR/fp_initial.out" | cut -c1-32)"
else
  echo "FAIL [no_row_rewritten]: a migration or a probe changed existing rows" >&2
  for t in s0 s1 s2; do diff "$WORKDIR/fp_initial.out" "$WORKDIR/fp_$t.out" | head -n 10 >&2 || true; done
  diff "$WORKDIR/fp_x_initial.out" "$WORKDIR/fp_x.out" | head -n 10 >&2 || true
  FAILURES=$((FAILURES + 1))
fi

SECTIONS=$((SECTIONS + 1))
UNRELATED_ROWS="$(wc -l < "$WORKDIR/unrelated_s0.out" | tr -d ' ')"
if [ "$UNRELATED_ROWS" -lt 100 ] || ! grep -q '^pol:public.bundle_books.' "$WORKDIR/unrelated_s0.out" \
   || ! grep -q '^fn:create_bundle_checkout_snapshot' "$WORKDIR/unrelated_s0.out"; then
  echo "FAIL [no_unrelated_drift]: the unrelated-catalog snapshot is too small ($UNRELATED_ROWS rows) to mean anything" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/unrelated_s0.out" "$WORKDIR/unrelated_s1.out" || ! cmp -s "$WORKDIR/unrelated_s0.out" "$WORKDIR/unrelated_s2.out"; then
  echo "FAIL [no_unrelated_drift]: something outside bundle_books' ACL and the three writer functions changed" >&2
  diff "$WORKDIR/unrelated_s0.out" "$WORKDIR/unrelated_s2.out" | head -n 20 >&2 || true
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [no_unrelated_drift]: $UNRELATED_ROWS entries (every other relation/column/function ACL and body incl. create_bundle_checkout_snapshot, schema ACLs, every policy incl. bundle_books', RLS, triggers, constraints, indexes, defaults) identical across S0, S1, S2"
fi

SECTIONS=$((SECTIONS + 1))
P0="$(grep '=' "$WORKDIR/probe_s0.out" | tr '\n' ' ' || true)"
P1="$(grep '=' "$WORKDIR/probe_s1.out" | tr '\n' ' ' || true)"
P2="$(grep '=' "$WORKDIR/probe_s2.out" | tr '\n' ' ' || true)"
PX="$(grep '=' "$WORKDIR/probe_x.out" | tr '\n' ' ' || true)"
COMMON_READS="anon_read=OK:3 author_b_read=OK:3 "
TAIL_OK="author_delete_bundle=OK:1 author_delete_book=OK:1 service_fixture_upsert=OK:1 service_teardown=OK:1 "
EXPECT_S0="old_create_membership=OK:1 old_edit_delete=OK:3 old_add_draft_book=OK:1 old_update_details=OK:1 cross_author_insert=42501 cross_author_delete=OK:0 author_update=OK:0 author_truncate=OK:0 anon_insert=42501 anon_truncate=OK:0 ${COMMON_READS}new_replace=42883 new_create=42883 new_update=42883 author_calls_writer=42883 author_calls_update=42883 ${TAIL_OK}"
EXPECT_S1="old_create_membership=OK:1 old_edit_delete=OK:3 old_add_draft_book=OK:1 old_update_details=OK:1 cross_author_insert=42501 cross_author_delete=OK:0 author_update=OK:0 author_truncate=OK:0 anon_insert=42501 anon_truncate=OK:0 ${COMMON_READS}new_replace=OK:2 new_create=OK:2 new_update=OK:2 author_calls_writer=42501 author_calls_update=42501 ${TAIL_OK}"
EXPECT_S2="old_create_membership=42501 old_edit_delete=42501 old_add_draft_book=42501 old_update_details=OK:1 cross_author_insert=42501 cross_author_delete=42501 author_update=42501 author_truncate=42501 anon_insert=42501 anon_truncate=42501 ${COMMON_READS}new_replace=OK:2 new_create=OK:2 new_update=OK:2 author_calls_writer=42501 author_calls_update=42501 ${TAIL_OK}"
EXPECT_X="old_create_membership=42501 old_edit_delete=42501 old_add_draft_book=42501 old_update_details=OK:1 cross_author_insert=42501 cross_author_delete=42501 author_update=42501 author_truncate=42501 anon_insert=42501 anon_truncate=42501 ${COMMON_READS}new_replace=42883 new_create=42883 new_update=42883 author_calls_writer=42883 author_calls_update=42883 ${TAIL_OK}"
RC=0
for pair in "S0|$P0|$EXPECT_S0" "S1|$P1|$EXPECT_S1" "S2|$P2|$EXPECT_S2" "X|$PX|$EXPECT_X"; do
  IFS='|' read -r tag got want <<< "$pair"
  if [ "$got" != "$want" ]; then
    echo "FAIL [rollout_effect $tag]: got '$got'" >&2
    echo "                   expected '$want'" >&2
    RC=1
  fi
done
if [ "$RC" -ne 0 ]; then
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [rollout_effect]: S0 old app writes, new app has no function; S1 BOTH work; S2 old app refused (42501), new app works; X (migration 2 first) BOTH broken"
  echo "    measured: S0=[$P0]"
  echo "    measured: S1=[$P1]"
  echo "    measured: S2=[$P2]"
  echo "    measured: X=[$PX]"
fi

# The four binding rollout states, stated per application. The old
# application's writes are its membership delete/insert on the author's
# session plus its separate service_role details update; the new
# application's are the three service_role functions.
SECTIONS=$((SECTIONS + 1))
pick() { local line="$1"; shift; for k in "$@"; do printf '%s ' "$(tr ' ' '\n' <<< "$line" | grep "^$k=" || echo "$k=<missing>")"; done; }
OLD_APP="old_create_membership old_edit_delete old_add_draft_book old_update_details"
NEW_APP="new_replace new_create new_update"
OLD_WORKS="old_create_membership=OK:1 old_edit_delete=OK:3 old_add_draft_book=OK:1 old_update_details=OK:1 "
OLD_REFUSED="old_create_membership=42501 old_edit_delete=42501 old_add_draft_book=42501 old_update_details=OK:1 "
NEW_WORKS="new_replace=OK:2 new_create=OK:2 new_update=OK:2 "
NEW_ABSENT="new_replace=42883 new_create=42883 new_update=42883 "
RC=0
for row in \
  "1 base (old app)|$(pick "$P0" $OLD_APP)|$OLD_WORKS" \
  "2 migration 1 only (old app)|$(pick "$P1" $OLD_APP)|$OLD_WORKS" \
  "3 migration 1 + new app (new app)|$(pick "$P1" $NEW_APP)|$NEW_WORKS" \
  "3 migration 1 + new app (old instances still serving)|$(pick "$P1" $OLD_APP)|$OLD_WORKS" \
  "4 migration 1 + new app + migration 2 (new app)|$(pick "$P2" $NEW_APP)|$NEW_WORKS" \
  "4 migration 1 + new app + migration 2 (old app, if still serving)|$(pick "$P2" $OLD_APP)|$OLD_REFUSED" \
  "(1) base (new app deployed too early)|$(pick "$P0" $NEW_APP)|$NEW_ABSENT" \
  "X migration 2 only (new app)|$(pick "$PX" $NEW_APP)|$NEW_ABSENT" \
  "X migration 2 only (old app)|$(pick "$PX" $OLD_APP)|$OLD_REFUSED"; do
  IFS='|' read -r tag got want <<< "$row"
  if [ "$got" != "$want" ]; then
    echo "FAIL [rollout_four_states $tag]: got '$got', expected '$want'" >&2
    RC=1
  else
    echo "    state $tag: $got"
  fi
done
if [ "$RC" -ne 0 ]; then
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [rollout_four_states]: 1 old app works; 2 old app works; 3 new app works and old instances still work; 4 new app works, old membership writes refused; new app before migration 1, or migration 2 first, is broken"
fi

SECTIONS=$((SECTIONS + 1))
C0="$(tr '\n' ' ' < "$WORKDIR/cascade_s0.out")"
C2="$(tr '\n' ' ' < "$WORKDIR/cascade_s2.out")"
if [ "$C0" = "after_book_delete=2 after_bundle_delete=0 " ] && [ "$C2" = "$C0" ]; then
  echo "  ok [cascades]: deleting an author's own member book removes exactly its membership row, deleting the bundle removes the rest -- identical before (S0) and after (S2): [$C2]"
else
  echo "FAIL [cascades]: S0='$C0' S2='$C2'" >&2
  FAILURES=$((FAILURES + 1))
fi

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 069_bundle_membership_write_authorization_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 069_bundle_membership_write_authorization_catalog_equivalence.sh -- $SECTIONS sections identical/as expected between $PATCHED_LABEL and ${BASE_REF:0:9} + both migrations, none empty"
