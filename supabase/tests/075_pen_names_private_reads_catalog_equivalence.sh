#!/usr/bin/env bash
# PEN-NAMES-2: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema (2a3c7bda, PEN-1
# merged) plus BOTH PEN-2 migrations -- the expand
# (20261019222500_pen_names_private_reads.sql) and the contract
# (20261019222600_pen_names_private_reads_contract.sql), applied
# separately -- describe the same database across every catalog that can
# differ, and that the PEN-1 code keeps working after the EXPAND alone
# (rollout step 1 runs before the PR B code).
#
# Modelled on 074_pen_names_catalog_equivalence.sh; its generic machinery
# is carried over, with two changes:
#   * columns are compared by ORDINAL among live columns, not by attnum:
#     the contract drops books.pen_name, which leaves a dropped-column
#     slot in the migrated database that a declarative schema.sql never
#     has. Every other column property is compared as before.
#   * the effective-privilege sections cover every relation PEN-2 touches.
#
# Part 2 builds the BASE with rows, applies the EXPAND only and runs the
# PEN-1 code's own queries as anon / authenticated / support staff
# (old-code section, all rolled back), then applies the contract: its
# guard must REFUSE while an old storage key remains, and pass once the
# rows carry new keys with service-role objects.
#
# Usage, from the repo root, against a cluster where the connecting user
# may create and drop databases (PostgreSQL 17+; on 16 pass stripped
# copies via BASE_SCHEMA, SCHEMA, MIGRATION, CONTRACT and STUB):
#
#   ./supabase/tests/075_pen_names_private_reads_catalog_equivalence.sh
#
# Exits non-zero on any difference, any empty section, any non-zero psql
# exit, or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE these migrations were
# written against: origin/staging, the merge of PR #61 (PEN-1).
BASE_REF="${BASE_REF:-2a3c7bda0e63d4019a391dea27d0adcd32c1f1e0}"
MIGRATION="${MIGRATION:-supabase/migrations/20261019222500_pen_names_private_reads.sql}"
CONTRACT="${CONTRACT:-supabase/migrations/20261019222600_pen_names_private_reads_contract.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# ABSENT from the base schema and PRESENT in the patched one.
MARKER="${MARKER:-PEN-NAMES-2}"
# This migration may still be uncommitted, so the working-tree
# comparison is permitted here. Harnesses for merged migrations set 0.
ALLOW_WORKTREE=1

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

for f in "$MIGRATION" "$CONTRACT" "$STUB"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: $f not found -- run this from a checkout that carries the patch" >&2
    exit 1
  fi
done

SUFFIX="$$"
DB_A="librum_pen2_a_${SUFFIX}"
DB_B="librum_pen2_b_${SUFFIX}"
DB_C="librum_pen2_c_${SUFFIX}"
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

# The base must carry PEN-1 (pen_names) and not yet public_books.
if ! grep -q "create table public.pen_names" "$WORKDIR/base_schema.sql" \
   || grep -q "create view public.public_books" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: the base schema is not the 2a3c7bda base (pen_names / public_books) -- wrong base" >&2
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
echo "  building B: base schema + $MIGRATION, then $CONTRACT"
build "$DB_B" "$STUB" "$WORKDIR/base_schema.sql" "$MIGRATION" "$CONTRACT"

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
select c.relname,
       row_number() over (partition by c.oid order by a.attnum), a.attname,
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

# Function sections: new trigger functions, the replaced search_books()
# and bundle RPCs -- definition, security and ACL must be identical.
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
for tbl in profiles books series bundles bundle_books reviews book_contributors book_views purchases bundle_checkout_snapshots refund_requests refund_request_items blog_posts pen_names pen_name_follows public_pen_names public_books public_series public_bundles public_reviews reader_bundle_purchases reader_refund_requests author_book_purchases author_bundle_sales; do
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



# Storage policies live outside public: compare them too.
compare storage_policies "
select tablename, policyname, permissive, coalesce(array_to_string(roles, ','), ''), cmd,
       coalesce(qual, ''), coalesce(with_check, '')
  from pg_catalog.pg_policies
 where schemaname = 'storage'
 order by tablename, policyname"

# ============================================================
# Beyond equivalence: both databases CARRY THE CHANGE.
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      not has_table_privilege('anon', 'public.books', 'SELECT')
      and not has_table_privilege('anon', 'public.series', 'SELECT')
      and not has_table_privilege('anon', 'public.bundles', 'SELECT')
      and not has_table_privilege('anon', 'public.reviews', 'SELECT')
      and not has_table_privilege('authenticated', 'public.books', 'INSERT')
      and not has_any_column_privilege('authenticated', 'public.bundles', 'INSERT')
      and pg_catalog.pg_get_functiondef('public.bundles_enforce_pen_name()'::regprocedure) like '%current_setting(''role'') in (''anon'', ''authenticated'')%and new.author_id is distinct from auth.uid()%return new;%resolve_author_pen_name%'
      and not has_column_privilege('anon', 'public.blog_posts', 'created_by', 'SELECT')
      and to_regclass('public.author_follows') is null
      and to_regclass('public.public_author_profiles') is null
      and not exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.books'::regclass and attname = 'pen_name' and not attisdropped)
      and (select pg_catalog.pg_get_triggerdef(t.oid) from pg_catalog.pg_trigger t
            where t.tgrelid = 'public.books'::regclass and t.tgname = 'books_enforce_pen_name')
          like '%BEFORE INSERT OR UPDATE OF pen_name_id, author_id, series_id ON public.books%'
      and pg_catalog.pg_get_functiondef('public.search_books(text,text,integer,integer,integer)'::regprocedure) ~ 'public.public_books'
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry PEN-NAMES-2" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: no anon SELECT on books/series/bundles/reviews, no authenticated INSERT on books or bundles, bundles trigger guard, blog created_by hidden, author_follows and public_author_profiles gone, books.pen_name gone, trigger column list, search_books on public_books"
  fi
done

# ============================================================
# Part 2: populated base -> EXPAND -> old code -> contract guard.
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
-- A: author with a default pen name and 'P075 Owl'; a published book with
--    an OLD canonical cover key, a draft, a series, a bundle, a review.
-- R: reader who bought A's book, follows A; S: support staff.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0754f00-0000-4000-8000-00000000000a', 'p075-a@test', now(), '{"role":"author","display_name":"P075 Ana"}'),
  ('e0754f00-0000-4000-8000-0000000000aa', 'p075-r@test', now(), '{"role":"reader","display_name":"P075 Reader"}'),
  ('e0754f00-0000-4000-8000-0000000000cc', 'p075-s@test', now(), '{"role":"reader","display_name":"P075 Support"}'),
  ('e0754f00-0000-4000-8000-00000000000b', 'p075-b@test', now(), '{"role":"author","display_name":"P075 Bo"}');
insert into public.staff_members (user_id, role) values ('e0754f00-0000-4000-8000-0000000000cc', 'support');
insert into public.books (id, author_id, title, status, price_all, published_at, cover_path) values
  ('e0754f01-0000-4000-8000-000000000001', 'e0754f00-0000-4000-8000-00000000000a', 'P075 Pub', 'published', 199, now(),
   'e0754f00-0000-4000-8000-00000000000a/e0754f01-0000-4000-8000-000000000001-cover.jpg'),
  ('e0754f01-0000-4000-8000-000000000002', 'e0754f00-0000-4000-8000-00000000000a', 'P075 Draft', 'draft', 199, null, null);
insert into public.series (id, author_id, title) values
  ('e0754f02-0000-4000-8000-000000000001', 'e0754f00-0000-4000-8000-00000000000a', 'P075 Series');
insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0754f01-0000-4000-8000-000000000001', 'e0754f00-0000-4000-8000-0000000000aa', 'cs_p075', 0);
insert into public.reviews (book_id, reader_id, rating, body) values
  ('e0754f01-0000-4000-8000-000000000001', 'e0754f00-0000-4000-8000-0000000000aa', 5, 'good');
insert into public.refund_requests (reader_id, stripe_payment_intent_id, amount_cents) values
  ('e0754f00-0000-4000-8000-0000000000aa', 'pi_p075', 100);
insert into storage.objects (bucket_id, name, owner) values
  ('covers', 'e0754f00-0000-4000-8000-00000000000a/e0754f01-0000-4000-8000-000000000001-cover.jpg', 'e0754f00-0000-4000-8000-00000000000a');
FIXTURES

# Old code (PEN-1) after the EXPAND only, all rolled back.
cat > "$WORKDIR/oldcode.sql" <<'OLDCODE'
begin;
create function pg_temp.check(ok boolean, msg text) returns text language sql as $$
  select case when ok then 'ok ' || msg else 'BAD ' || msg end $$;
create function pg_temp.q(p_role text, p_sub text, p_sql text) returns text language plpgsql as $$
declare v bigint; s text; m text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute 'select count(*) from (' || p_sql || ') x' into v;
    reset role; return 'OK:' || v;
  exception when others then
    get stacked diagnostics s = returned_sqlstate, m = message_text;
    reset role; return s || ':' || m;
  end;
end $$;
create function pg_temp.x(p_role text, p_sub text, p_sql text) returns text language plpgsql as $$
declare v bigint; s text; m text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql; get diagnostics v = row_count;
    reset role; return 'OK:' || v;
  exception when others then
    get stacked diagnostics s = returned_sqlstate, m = message_text;
    reset role; return s || ':' || m;
  end;
end $$;
grant execute on function pg_temp.q(text, text, text), pg_temp.x(text, text, text) to anon, authenticated;
select pg_temp.check(pg_temp.q('anon', null, 'select * from public.books') = 'OK:1', 'old_anon_books_select_star');
select pg_temp.check(pg_temp.q('anon', null,
  'select r.*, (select p.public_author_name from public.public_author_profiles p where p.id = r.reader_id) from public.reviews r') = 'OK:1',
  'old_reviews_with_public_author_profiles');
select pg_temp.check(pg_temp.q('anon', null, 'select * from public.series') = 'OK:1', 'old_anon_series_select_star');
select pg_temp.check(pg_temp.x('authenticated', 'e0754f00-0000-4000-8000-0000000000aa',
  $q$insert into public.author_follows (follower_id, author_id) values ('e0754f00-0000-4000-8000-0000000000aa', 'e0754f00-0000-4000-8000-00000000000a')$q$) = 'OK:1',
  'old_author_follows_insert');
select pg_temp.check((select count(*) from public.pen_name_follows where follower_id = 'e0754f00-0000-4000-8000-0000000000aa') = 1,
  'old_author_follows_mirrored');
select pg_temp.check(pg_temp.x('authenticated', 'e0754f00-0000-4000-8000-00000000000a',
  $q$insert into storage.objects (bucket_id, name) values ('covers', 'e0754f00-0000-4000-8000-00000000000a/new-cover.png')$q$) = 'OK:1',
  'old_cover_upload_policy');
select pg_temp.check(pg_temp.q('authenticated', 'e0754f00-0000-4000-8000-0000000000cc',
  $q$select id, display_name from public.profiles where id = 'e0754f00-0000-4000-8000-0000000000aa'$q$) = 'OK:1',
  'old_support_reads_refund_reader_profile');
select pg_temp.check(pg_temp.q('anon', null, $q$select * from public.search_books('P075')$q$) = 'OK:1', 'old_anon_search');
select pg_temp.check(pg_temp.q('anon', null, 'select * from public.public_books') = 'OK:1', 'new_public_books_anon');
select pg_temp.check(pg_temp.q('authenticated', 'e0754f00-0000-4000-8000-0000000000cc',
  $q$select * from public.staff_profile_display_names(array['e0754f00-0000-4000-8000-0000000000aa']::uuid[])$q$) = 'OK:1',
  'new_support_display_names');
-- MF1 after the expand: authenticated R inserting a book for X with A's
-- series (A's default pen name) gets one answer for every X.
select pg_temp.check(
  (select count(distinct pg_temp.x('authenticated', 'e0754f00-0000-4000-8000-0000000000aa',
     format($q$insert into public.books (author_id, title, series_id) values (%L, 't', 'e0754f02-0000-4000-8000-000000000001')$q$, x)))
     from unnest(array[gen_random_uuid()::text, 'e0754f00-0000-4000-8000-0000000000cc',
                       'e0754f00-0000-4000-8000-00000000000a', 'e0754f00-0000-4000-8000-00000000000b']) x) = 1
  and pg_temp.x('authenticated', 'e0754f00-0000-4000-8000-0000000000aa',
     $q$insert into public.books (author_id, title, series_id) values ('e0754f00-0000-4000-8000-00000000000a', 't', 'e0754f02-0000-4000-8000-000000000001')$q$) like '42501:%',
  'mf1_books_insert_one_answer_after_expand');
-- Audit PEN-2 r1 F1 after the expand: authenticated R inserting a bundle
-- for X gets one answer for every X (it used to tell an author from a
-- reader or no account).
select pg_temp.check(
  (select count(distinct pg_temp.x('authenticated', 'e0754f00-0000-4000-8000-0000000000aa',
     format($q$insert into public.bundles (author_id, title) values (%L, 't')$q$, x)))
     from unnest(array[gen_random_uuid()::text, 'e0754f00-0000-4000-8000-0000000000cc',
                       'e0754f00-0000-4000-8000-00000000000a', 'e0754f00-0000-4000-8000-00000000000b']) x) = 1
  and pg_temp.x('authenticated', 'e0754f00-0000-4000-8000-0000000000aa',
     $q$insert into public.bundles (author_id, title) values ('e0754f00-0000-4000-8000-00000000000a', 't')$q$) like '42501:%',
  'f1_bundles_insert_one_answer_after_expand');
rollback;
OLDCODE

# Repoint the fixture to a new-shape key with a service-role object.
cat > "$WORKDIR/repoint.sql" <<'REPOINT'
insert into storage.objects (bucket_id, name, owner, owner_id) values
  ('covers', 'e0754f0c-0000-4000-8000-000000000001/cover.jpg', null, null);
update public.books set cover_path = 'e0754f0c-0000-4000-8000-000000000001/cover.jpg'
 where id = 'e0754f01-0000-4000-8000-000000000001';
REPOINT

run_file() {
  local db="$1" file="$2" out="$3" err="$4" rc
  set +e
  psql -X -q -t -A -F '|' -d "$db" -v ON_ERROR_STOP=1 -f "$file" > "$out" 2> "$err"
  rc=$?
  set -e
  return $rc
}

echo "  building C: base schema + rows, then the expand only"
build "$DB_C" "$STUB" "$WORKDIR/base_schema.sql" "$WORKDIR/rows.sql" "$MIGRATION"

SECTIONS=$((SECTIONS + 1))
if run_file "$DB_C" "$WORKDIR/oldcode.sql" "$WORKDIR/oldcode.out" "$WORKDIR/oldcode.err" \
   && [ ! -s "$WORKDIR/oldcode.err" ] && [ -s "$WORKDIR/oldcode.out" ] && ! grep -q '^BAD ' "$WORKDIR/oldcode.out"; then
  echo "  ok [oldcode_after_expand]: $(grep -c '^ok ' "$WORKDIR/oldcode.out") checks -- $(sed 's/^ok //' "$WORKDIR/oldcode.out" | tr '\n' ' ')"
else
  echo "FAIL [oldcode_after_expand]:" >&2
  cat "$WORKDIR/oldcode.out" "$WORKDIR/oldcode.err" >&2
  FAILURES=$((FAILURES + 1))
fi

SECTIONS=$((SECTIONS + 1))
set +e
psql -X -q -d "$DB_C" -v ON_ERROR_STOP=1 -f "$CONTRACT" > "$WORKDIR/guard.out" 2> "$WORKDIR/guard.err"
GUARD_RC=$?
set -e
if [ "$GUARD_RC" -ne 0 ] && grep -q 'still use an old storage key' "$WORKDIR/guard.err" \
   && [ "$(psql -X -q -t -A -d "$DB_C" -c "select count(*) from pg_catalog.pg_attribute where attrelid = 'public.books'::regclass and attname = 'pen_name' and not attisdropped")" = "1" ]; then
  echo "  ok [contract_guard_refuses_old_key]: the contract refused and changed nothing"
else
  echo "FAIL [contract_guard_refuses_old_key]: rc=$GUARD_RC" >&2
  cat "$WORKDIR/guard.err" >&2
  FAILURES=$((FAILURES + 1))
fi

# C0 also refuses a referenced object that is missing, or that carries an
# owner or owner_id (MF-B). Each case: new-shape key, rolled back.
guard_case() {
  local label="$1" setup="$2" expect="$3"
  SECTIONS=$((SECTIONS + 1))
  { echo "begin;"; echo "$setup"; echo "\\i $CONTRACT"; echo "rollback;"; } > "$WORKDIR/case_$label.sql"
  set +e
  psql -X -q -d "$DB_C" -v ON_ERROR_STOP=1 -f "$WORKDIR/case_$label.sql" > /dev/null 2> "$WORKDIR/case_$label.err"
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ] && grep -q "$expect" "$WORKDIR/case_$label.err"; then
    echo "  ok [contract_guard_$label]: refused"
  else
    echo "FAIL [contract_guard_$label]: rc=$rc" >&2
    cat "$WORKDIR/case_$label.err" >&2
    FAILURES=$((FAILURES + 1))
  fi
}
guard_case missing_object \
  "update public.books set cover_path = 'e0754f0c-0000-4000-8000-0000000000ff/cover.jpg' where id = 'e0754f01-0000-4000-8000-000000000001';" \
  'missing from storage'
guard_case owner \
  "insert into storage.objects (bucket_id, name, owner) values ('covers', 'e0754f0c-0000-4000-8000-0000000000fe/cover.jpg', 'e0754f00-0000-4000-8000-00000000000a'); update public.books set cover_path = 'e0754f0c-0000-4000-8000-0000000000fe/cover.jpg' where id = 'e0754f01-0000-4000-8000-000000000001';" \
  'carry an owner account'
guard_case owner_id \
  "insert into storage.objects (bucket_id, name, owner_id) values ('avatars', 'e0754f0c-0000-4000-8000-0000000000fd/pen-name.png', 'e0754f00-0000-4000-8000-00000000000a'); update public.books set cover_path = null; update public.pen_names set avatar_path = 'e0754f0c-0000-4000-8000-0000000000fd/pen-name.png' where author_id = 'e0754f00-0000-4000-8000-00000000000a' and is_default;" \
  'carry an owner account'
guard_case old_photo_key \
  "update public.books set cover_path = null; update public.pen_names set avatar_path = 'e0754f00-0000-4000-8000-00000000000a/avatar.png' where author_id = 'e0754f00-0000-4000-8000-00000000000a' and is_default;" \
  'pen name photo(s) still use an old storage key'

SECTIONS=$((SECTIONS + 1))
STEP_RC=0
run_file "$DB_C" "$WORKDIR/repoint.sql" "$WORKDIR/repoint.out" "$WORKDIR/repoint.err" || STEP_RC=1
run_file "$DB_C" "$CONTRACT" "$WORKDIR/contract.out" "$WORKDIR/contract.err" || STEP_RC=1
# The contract names policies longer than 63 bytes (as they were created);
# PostgreSQL's identifier-truncation NOTICEs are expected, nothing else.
if [ "$STEP_RC" -eq 0 ] && [ ! -s "$WORKDIR/repoint.err" ] \
   && ! grep -v 'NOTICE:' "$WORKDIR/contract.err" | grep -q . \
   && [ "$(psql -X -q -t -A -d "$DB_C" -c "select count(*) from public.books where id::text like 'e0754f01-%'")" = "2" ]; then
  echo "  ok [contract_after_repoint]: the contract runs over populated data once keys are new and objects are service-role; rows kept"
else
  echo "FAIL [contract_after_repoint]:" >&2
  cat "$WORKDIR/repoint.err" "$WORKDIR/contract.err" >&2
  FAILURES=$((FAILURES + 1))
fi

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 075_pen_names_private_reads_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 075_pen_names_private_reads_catalog_equivalence.sh -- $SECTIONS sections: catalog identical between $PATCHED_LABEL and the base + expand + contract, none empty; old code works after the expand; the contract guard refuses an old key"
