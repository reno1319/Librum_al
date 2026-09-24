#!/usr/bin/env bash
# AVATAR-STORAGE-PATH-AUTH-1: proves that a database built from the
# PATCHED supabase/schema.sql and one built from the BASE schema plus
# supabase/migrations/20260924160846_avatar_storage_path_authorization.sql
# describe the same database -- across every catalog that can differ, not
# just "does the grant exist".
#
# Modelled on 067_catalog_storage_path_authorization_catalog_equivalence.sh;
# its generic machinery (schema resolution, the non-vacuous compare(),
# every catalog section) is carried over unchanged.
#
# Why the risk is concrete in THIS change. It is an ACL-only migration,
# and ACLs are exactly where the two paths are built differently:
#
#   * path A creates profiles fresh, inherits the platform's ambient
#     table-level grants, then issues the reset and column grants;
#   * path B starts from the migration 033/045/046 ACL (column UPDATE on
#     display_name, bio, avatar_path, public_author_name) and must arrive
#     at the same place. A migration that only granted the three columns
#     without the reset would leave avatar_path updatable on path B only.
#     The column_acls section sees that.
#
# Every section must ALSO be non-vacuous: each requires a non-zero row
# count on BOTH sides, a zero exit status from psql, and empty stderr.
#
# Beyond equivalence, part 2 applies the migration over a POPULATED base
# -- including a profile that ALREADY points at another user's avatar and
# one with a legacy value, plus Storage objects -- and proves (a) it
# rewrites no profile row and no Storage object, (b) no policy and no ACL
# outside public.profiles changes, and (c) the intended behaviour change,
# measured with rollback-only probes: a user's direct UPDATE naming
# avatar_path (another user's key, their own canonical key, or null)
# succeeds before and is refused after, while the name/bio/pen-name
# update, RLS isolation and the service_role write work throughout.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer):
#
#   ./supabase/tests/068_avatar_storage_path_authorization_catalog_equivalence.sh
#
# Overrides: BASE_REF, MIGRATION, STUB, SCHEMA_PATH, MARKER, and either
# SCHEMA (an explicit patched-schema file) or PATCHED_REF (an explicit
# patched-schema commit). Exits non-zero on any difference, any empty
# section, any non-zero psql exit, or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against: origin/staging at the time, the merge of PR #29.
BASE_REF="${BASE_REF:-99e1c8b0402cf99d9d370a97d7c705130480c897}"
MIGRATION="${MIGRATION:-supabase/migrations/20260924160846_avatar_storage_path_authorization.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-AVATAR-STORAGE-PATH-AUTH-1}"
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
DB_A="librum_avatar_path_a_${SUFFIX}"
DB_B="librum_avatar_path_b_${SUFFIX}"
DB_C="librum_avatar_path_c_${SUFFIX}"
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

# The base must actually be the OPEN state -- the profiles UPDATE grant
# that still lists avatar_path -- or "the hole is closed" is being proved
# against a database that never had it.
if ! tr -s ' \n' ' ' < "$WORKDIR/base_schema.sql" | grep -q 'grant update (display_name, bio, avatar_path, public_author_name) on public.profiles to authenticated;'; then
  echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} does not grant authenticated UPDATE on profiles.avatar_path -- wrong base" >&2
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
for tbl in profiles public_author_profiles; do
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
      -- avatar_path is unwritable by every client-facing role
      not has_column_privilege('authenticated', 'public.profiles', 'avatar_path', 'UPDATE')
      and not has_column_privilege('authenticated', 'public.profiles', 'avatar_path', 'INSERT')
      and not has_table_privilege('authenticated', 'public.profiles', 'INSERT')
      and not has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.profiles', 'DELETE')
      and not has_any_column_privilege('anon', 'public.profiles', 'SELECT, INSERT, UPDATE, REFERENCES')
      and not has_any_column_privilege('public', 'public.profiles', 'SELECT, INSERT, UPDATE, REFERENCES')
      -- the legitimate session columns stay writable, SELECT stays
      and has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE')
      and has_column_privilege('authenticated', 'public.profiles', 'bio', 'UPDATE')
      and has_column_privilege('authenticated', 'public.profiles', 'public_author_name', 'UPDATE')
      and not has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')
      and has_table_privilege('authenticated', 'public.profiles', 'SELECT')
      -- the public view keeps its reads
      and has_table_privilege('anon', 'public.public_author_profiles', 'SELECT')
      and has_table_privilege('authenticated', 'public.public_author_profiles', 'SELECT')
      -- service_role not narrowed
      and has_column_privilege('service_role', 'public.profiles', 'avatar_path', 'UPDATE')
      and has_table_privilege('service_role', 'public.profiles', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry the AVATAR-STORAGE-PATH-AUTH-1 profiles ACL" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: avatar_path unwritable by public/anon/authenticated, name/bio/pen-name UPDATE and SELECT kept, public view intact, service_role intact"
  fi
done

# The exact resulting table and column ACLs, printed rather than only
# asserted: a measured fact for a reviewer to read.
for db in "$DB_A" "$DB_B"; do
  ACL="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select coalesce(c.relacl::text, '<default>') from pg_catalog.pg_class c
     where c.oid = 'public.profiles'::regclass" 2>/dev/null)"
  COLACL="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select string_agg(a.attname || '=' || a.attacl::text, ' ' order by a.attnum)
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.profiles'::regclass and a.attacl is not null" 2>/dev/null)"
  echo "  measured [$db profiles]: relacl=$ACL"
  echo "  measured [$db profiles]: attacl=$COLACL"
done

# ============================================================
# Part 2: the migration applied over POPULATED data.
#
#   (a) this migration writes no row: every pre-existing profile and every
#       Storage object is byte-identical after it;
#   (b) nothing outside public.profiles' table and column ACLs drifts;
#   (c) applying it is NOT behaviour-free, and the harness measures the
#       intended change with rollback-only probes, one per statement.
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0680f00-0000-4000-8000-00000000000a', 'p068-harness-a@test', now(), '{"role":"reader","display_name":"P068 Harness A"}'),
  ('e0680f00-0000-4000-8000-00000000000b', 'p068-harness-b@test', now(), '{"role":"author","display_name":"P068 Harness B"}'),
  ('e0680f00-0000-4000-8000-00000000000c', 'p068-harness-c@test', now(), '{"role":"author","display_name":"P068 Harness C"}'),
  ('e0680f00-0000-4000-8000-00000000000d', 'p068-harness-d@test', now(), '{"role":"reader","display_name":"P068 Harness D"}');

-- A canonical avatar, a legacy non-canonical value, a profile that ALREADY
-- points at another user's avatar (a forgery made before the migration),
-- and one with none: the migration must leave every value exactly as is.
update public.profiles set avatar_path = 'e0680f00-0000-4000-8000-00000000000b/avatar.png' where id = 'e0680f00-0000-4000-8000-00000000000b';
update public.profiles set avatar_path = 'legacy/avatars/c.JPEG' where id = 'e0680f00-0000-4000-8000-00000000000c';
update public.profiles set avatar_path = 'e0680f00-0000-4000-8000-00000000000b/avatar.png' where id = 'e0680f00-0000-4000-8000-00000000000d';

insert into storage.objects (id, bucket_id, name) values
  ('e0680f09-0000-4000-8000-000000000001', 'avatars', 'e0680f00-0000-4000-8000-00000000000b/avatar.png'),
  ('e0680f09-0000-4000-8000-000000000002', 'avatars', 'e0680f00-0000-4000-8000-00000000000c/avatar.jpg'),
  ('e0680f09-0000-4000-8000-000000000003', 'manuscripts', 'e0680f00-0000-4000-8000-00000000000a/tmp/avatar/x.png');
FIXTURES

cat > "$WORKDIR/fingerprint.sql" <<'FINGERPRINT'
select 'profiles:' || coalesce(string_agg(row_to_json(p)::text, ',' order by p.id), '<none>')
  from public.profiles p
union all
select 'objects:' || coalesce(string_agg(row_to_json(o)::text, ',' order by o.id), '<none>')
  from storage.objects o;
FINGERPRINT

# Everything this migration must NOT change: every relation ACL except
# profiles, every column ACL except profiles, every function and schema
# ACL, every policy of every table (profiles and storage.objects
# included), RLS flags, and the profiles defaults.
cat > "$WORKDIR/unrelated.sql" <<'UNRELATED'
select 'rel:' || n.nspname || '.' || c.relname || '=' || coalesce(c.relacl::text, '<default>')
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_%'
   and c.relkind in ('r', 'v', 'm', 'S', 'p', 'f')
   and not (n.nspname = 'public' and c.relname = 'profiles')
union all
select 'col:' || n.nspname || '.' || c.relname || '.' || a.attname || '=' || a.attacl::text
  from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname not in ('pg_catalog', 'information_schema') and a.attacl is not null
   and not (n.nspname = 'public' and c.relname = 'profiles')
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
select 'rls:' || n.nspname || '.' || c.relname || '=' || c.relrowsecurity::text || '/' || c.relforcerowsecurity::text
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public', 'storage') and c.relkind = 'r'
union all
select 'trg:' || c.relname || '.' || t.tgname || '=' || pg_catalog.pg_get_triggerdef(t.oid)
  from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
 where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
union all
select 'default:' || c.relname || '.' || a.attname || '=' || pg_catalog.pg_get_expr(d.adbin, d.adrelid)
  from pg_catalog.pg_attrdef d
  join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
  join pg_catalog.pg_class c on c.oid = d.adrelid
 where c.relname = 'profiles' and c.relnamespace = 'public'::regnamespace
union all
select 'bucket:' || id || '=' || public::text from storage.buckets
order by 1;
UNRELATED

# One probe per statement, all rolled back. Each prints '<label>=OK:<rows>'
# or '<label>=<sqlstate>'.
cat > "$WORKDIR/probe.sql" <<'PROBE'
begin;
create function pg_temp.probe(p_label text, p_role text, p_sql text) returns text language plpgsql as $$
declare v_state text; v_rows bigint;
begin
  -- anon carries no subject, exactly as the anon key's JWT carries none.
  perform set_config('request.jwt.claim.sub',
    case when p_role = 'authenticated' then 'e0680f00-0000-4000-8000-00000000000a' else '' end, true);
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
select pg_temp.probe('update_forged_avatar', 'authenticated', $q$update public.profiles set avatar_path = 'e0680f00-0000-4000-8000-00000000000b/avatar.png' where id = 'e0680f00-0000-4000-8000-00000000000a'$q$);
select pg_temp.probe('update_own_canonical', 'authenticated', $q$update public.profiles set avatar_path = 'e0680f00-0000-4000-8000-00000000000a/avatar.png' where id = 'e0680f00-0000-4000-8000-00000000000a'$q$);
select pg_temp.probe('update_null_avatar', 'authenticated', $q$update public.profiles set avatar_path = null where id = 'e0680f00-0000-4000-8000-00000000000a'$q$);
select pg_temp.probe('update_old_app_payload', 'authenticated', $q$update public.profiles set display_name = 'A2', bio = 'b', avatar_path = 'e0680f00-0000-4000-8000-00000000000a/avatar.png' where id = 'e0680f00-0000-4000-8000-00000000000a'$q$);
select pg_temp.probe('update_new_app_payload', 'authenticated', $q$update public.profiles set display_name = 'A2', bio = 'b' where id = 'e0680f00-0000-4000-8000-00000000000a'$q$);
select pg_temp.probe('update_other_user_name', 'authenticated', $q$update public.profiles set display_name = 'Hijacked' where id = 'e0680f00-0000-4000-8000-00000000000b'$q$);
select pg_temp.probe('update_role', 'authenticated', $q$update public.profiles set role = 'admin' where id = 'e0680f00-0000-4000-8000-00000000000a'$q$);
select pg_temp.probe('insert_profile', 'authenticated', $q$insert into public.profiles (id, role, display_name, avatar_path) values ('e0680f00-0000-4000-8000-0000000000ff', 'reader', 'x', 'e0680f00-0000-4000-8000-00000000000b/avatar.png')$q$);
select pg_temp.probe('anon_update', 'anon', $q$update public.profiles set avatar_path = 'e0680f00-0000-4000-8000-00000000000b/avatar.png'$q$);
select pg_temp.probe('service_trusted_update', 'service_role', $q$update public.profiles set avatar_path = 'e0680f00-0000-4000-8000-00000000000a/avatar.png' where id = 'e0680f00-0000-4000-8000-00000000000a'$q$);
select pg_temp.probe('storage_foreign_upload', 'authenticated', $q$insert into storage.objects (bucket_id, name) values ('avatars', 'e0680f00-0000-4000-8000-00000000000b/avatar.png')$q$);
select pg_temp.probe('storage_foreign_overwrite', 'authenticated', $q$update storage.objects set name = name where bucket_id = 'avatars' and name = 'e0680f00-0000-4000-8000-00000000000b/avatar.png'$q$);
select pg_temp.probe('storage_avatar_delete', 'authenticated', $q$delete from storage.objects where bucket_id = 'avatars'$q$);
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
run_file "$DB_C" "$WORKDIR/unrelated.sql" "$WORKDIR/unrelated_before.out" "$WORKDIR/unrelated_before.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/probe.sql" "$WORKDIR/probe_before.out" "$WORKDIR/probe_before.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/before_again.out" "$WORKDIR/before_again.err" || STEP_RC=1
run_file "$DB_C" "$MIGRATION" "$WORKDIR/migrate.out" "$WORKDIR/migrate.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after.out" "$WORKDIR/after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/unrelated.sql" "$WORKDIR/unrelated_after.out" "$WORKDIR/unrelated_after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/probe.sql" "$WORKDIR/probe_after.out" "$WORKDIR/probe_after.err" || STEP_RC=1
run_file "$DB_C" "$WORKDIR/fingerprint.sql" "$WORKDIR/after_again.out" "$WORKDIR/after_again.err" || STEP_RC=1

if [ "$STEP_RC" -ne 0 ] || [ -s "$WORKDIR/before.err" ] || [ -s "$WORKDIR/after.err" ] \
   || [ -s "$WORKDIR/probe_before.err" ] || [ -s "$WORKDIR/probe_after.err" ] || [ -s "$WORKDIR/migrate.err" ] \
   || [ -s "$WORKDIR/before_again.err" ] || [ -s "$WORKDIR/after_again.err" ] \
   || [ -s "$WORKDIR/unrelated_before.err" ] || [ -s "$WORKDIR/unrelated_after.err" ]; then
  echo "FAIL [populated_migration]: a step errored or wrote to stderr" >&2
  tail -n 5 "$WORKDIR"/*.err >&2 || true
  FAILURES=$((FAILURES + 1))
elif [ ! -s "$WORKDIR/before.out" ] || grep -q '<none>' "$WORKDIR/before.out" \
     || ! grep -q 'legacy/avatars/c.JPEG' "$WORKDIR/before.out" || ! grep -q '"bucket_id":"avatars"' "$WORKDIR/before.out"; then
  echo "FAIL [populated_migration]: the fixture inserted nothing -- this comparison would pass vacuously" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/after.out"; then
  echo "FAIL [populated_migration]: the migration changed existing rows or Storage objects" >&2
  diff "$WORKDIR/before.out" "$WORKDIR/after.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/before_again.out" || ! cmp -s "$WORKDIR/after.out" "$WORKDIR/after_again.out"; then
  echo "FAIL [populated_migration]: a rolled-back probe left a change behind" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated_migration]: every profile (canonical, legacy non-canonical, already-forged, none) and every Storage object is byte-identical after the migration; the probes left nothing behind"
  echo "    measured: fingerprint md5=$(md5sum < "$WORKDIR/before.out" | cut -c1-32)"
fi

SECTIONS=$((SECTIONS + 1))
UNRELATED_ROWS="$(wc -l < "$WORKDIR/unrelated_before.out" | tr -d ' ')"
if [ "$UNRELATED_ROWS" -lt 50 ] || ! grep -q '^pol:public.profiles.' "$WORKDIR/unrelated_before.out" \
   || ! grep -q '^pol:storage.objects.Users can replace their own avatar' "$WORKDIR/unrelated_before.out"; then
  echo "FAIL [no_unrelated_drift]: the unrelated-catalog snapshot is too small ($UNRELATED_ROWS rows) to mean anything" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/unrelated_before.out" "$WORKDIR/unrelated_after.out"; then
  echo "FAIL [no_unrelated_drift]: something outside the profiles table and column ACLs changed" >&2
  diff "$WORKDIR/unrelated_before.out" "$WORKDIR/unrelated_after.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [no_unrelated_drift]: $UNRELATED_ROWS entries (every other relation/column/function/schema ACL, every policy incl. profiles and storage.objects, RLS flags, triggers, profiles defaults, buckets) identical before and after"
fi

SECTIONS=$((SECTIONS + 1))
PB="$(grep '=' "$WORKDIR/probe_before.out" | tr '\n' ' ' || true)"
PA="$(grep '=' "$WORKDIR/probe_after.out" | tr '\n' ' ' || true)"
EXPECT_BEFORE="update_forged_avatar=OK:1 update_own_canonical=OK:1 update_null_avatar=OK:1 update_old_app_payload=OK:1 update_new_app_payload=OK:1 update_other_user_name=OK:0 update_role=42501 insert_profile=42501 anon_update=42501 service_trusted_update=OK:1 storage_foreign_upload=42501 storage_foreign_overwrite=OK:0 storage_avatar_delete=OK:0 "
EXPECT_AFTER="update_forged_avatar=42501 update_own_canonical=42501 update_null_avatar=42501 update_old_app_payload=42501 update_new_app_payload=OK:1 update_other_user_name=OK:0 update_role=42501 insert_profile=42501 anon_update=42501 service_trusted_update=OK:1 storage_foreign_upload=42501 storage_foreign_overwrite=OK:0 storage_avatar_delete=OK:0 "
if [ "$PB" != "$EXPECT_BEFORE" ]; then
  echo "FAIL [rollout_effect]: the BASE did not behave as expected, so there is no change to measure" >&2
  echo "  before='$PB' expected='$EXPECT_BEFORE'" >&2
  FAILURES=$((FAILURES + 1))
elif [ "$PA" != "$EXPECT_AFTER" ]; then
  echo "FAIL [rollout_effect]: after the migration: '$PA' expected '$EXPECT_AFTER'" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [rollout_effect]: a direct avatar_path UPDATE (another user's key, own canonical, null) and the OLD app's combined payload succeed BEFORE and are refused AFTER; the NEW app's name/bio payload, RLS isolation and the service_role write work throughout; role UPDATE, profile INSERT, anon writes and cross-prefix Storage writes are refused throughout"
  echo "    measured: before=[$PB]"
  echo "    measured: after=[$PA]"
fi

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 068_avatar_storage_path_authorization_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 068_avatar_storage_path_authorization_catalog_equivalence.sh -- $SECTIONS catalog sections identical between $PATCHED_LABEL and ${BASE_REF:0:9} + migration, none empty"
