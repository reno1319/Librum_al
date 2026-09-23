#!/usr/bin/env bash
# ALL-SEARCH-1: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema plus
# supabase/migrations/20260922162155_all_search_books_price_all.sql
# describe the same database -- across every catalog that can differ,
# not just "does search_books exist".
#
# Modelled on 062_all_checkout_intent_catalog_equivalence.sh and
# 061_all_catalog_schema_expansion_catalog_equivalence.sh, which exist
# for the same reason: this repository has two build paths -- a fresh
# environment is created from schema.sql, staging is migrated -- and
# nothing else compares them.
#
# Why the risk is concrete in THIS change rather than theoretical.
# Unlike 062, this migration does NOT drop and create; it uses
# `create or replace`, and that verb has its own specific failure
# modes, each of which produces two databases that look correct in
# isolation and disagree with each other:
#
#   * `create or replace` PRESERVES the existing owner and ACL. The
#     migration relies on that and restates no grant. So on path B the
#     privileges come from the BASE schema's grants, while on path A
#     they come from the patched schema's grants. If those two ever
#     drift -- or if someone later "improves" this migration into a
#     drop-and-create -- path B silently hands EXECUTE to PUBLIC (the
#     default for a newly created function) while path A does not.
#     Nothing but a proacl comparison sees that, and this function is
#     callable by anon.
#   * `create or replace` REFUSES to change a parameter NAME. The
#     migration deliberately keeps the `min_price_cents` /
#     `max_price_cents` misnomers; an edit that "fixed" them would make
#     path B fail to build outright while path A succeeded, which is
#     exactly the asymmetry this harness turns into a named failure
#     rather than a confusing production incident.
#   * the whole function body is duplicated between schema.sql and the
#     migration. Nothing but a prosrc comparison would notice a body
#     that drifted between them -- and the body is where the null-price
#     exclusion and the two price predicates live, so a drift there is
#     a difference in WHICH BOOKS EXIST between a fresh environment and
#     staging.
#
# Every section must ALSO be non-vacuous, and that is enforced rather
# than hoped for: two identical EMPTY results are the failure mode a
# "byte-identical outputs" check silently passes. So each section
# requires a non-zero row count on BOTH sides, a zero exit status from
# psql, and empty stderr -- and stderr is captured to its own file,
# never merged into the stdout that is later compared, so a matching
# error message can never be mistaken for matching catalog output.
#
# `"char"` columns (contype, typtype, relkind, prokind, provolatile)
# are cast to text explicitly: without the cast the query errors, and
# an errored section would otherwise compare two empty outputs and
# report a pass.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases (PostgreSQL 17 or newer --
# schema.sql uses the MAINTAIN privilege):
#
#   ./supabase/tests/063_all_search_books_price_all_catalog_equivalence.sh
#
# Overrides: BASE_REF, MIGRATION, STUB, SCHEMA_PATH, MARKER, and either
# SCHEMA (an explicit patched-schema file) or PATCHED_REF (an explicit
# patched-schema commit). Exits non-zero on any difference, any empty
# section, any non-zero psql exit, or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against: origin/staging at the time, the merge of PR #22.
BASE_REF="${BASE_REF:-560c934cbc94da13ebb1cb9f9f3dcd4c75ce0b7a}"
MIGRATION="${MIGRATION:-supabase/migrations/20260922162155_all_search_books_price_all.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# The identifier that must be ABSENT from the base schema and PRESENT in
# the patched one. This is what makes "we resolved the wrong schema" a
# named failure instead of a confusing diff.
MARKER="${MARKER:-ALL-SEARCH-1}"
# This migration may still be uncommitted, so the working-tree
# comparison is permitted here. Harnesses for merged migrations set 0.
ALLOW_WORKTREE=1

# The function under change, and the ONE signature that must exist
# before and after. Unlike 062 this migration removes no overload:
# `create or replace` keeps the identity, and that invariance is
# itself what has to be proved.
FN_NAME="search_books"
FN_SIG="public.search_books(text,text,integer,integer,integer)"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

for f in "$MIGRATION" "$STUB"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: $f not found -- run this from a checkout that carries the patch" >&2
    exit 1
  fi
done

SUFFIX="$$"
DB_A="librum_all_search_a_${SUFFIX}"
DB_B="librum_all_search_b_${SUFFIX}"
DB_C="librum_all_search_c_${SUFFIX}"
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

# The base must actually carry the OLD price predicates, or "the legacy
# column is gone" is being proved against a database that never read it.
if ! grep -q 'books.price_cents >= min_price_cents' "$WORKDIR/base_schema.sql"; then
  echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} does not filter search_books on books.price_cents -- wrong base" >&2
  exit 1
fi
# ...and it must already grant EXECUTE on this signature, because the
# migration's whole ACL story is "create or replace preserves what base
# established". If base never granted anything, path B's privileges
# would come from nowhere and the acl comparison below would be
# agreeing about a default rather than about this repository's intent.
if ! grep -q "grant execute on function public.search_books" "$WORKDIR/base_schema.sql"; then
  echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} issues no grant on public.search_books -- the preserved-ACL premise does not hold" >&2
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

# The signature, in the raw catalog terms `create or replace` actually
# has to leave alone -- including proargnames, which is the field the
# deliberately-unrenamed price bounds live in, and pronargdefaults,
# which is what a dropped `default null` would move.
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
# signature above. All five of search_books' parameters carry a
# default; a migration that lost one would still produce an identical
# proargtypes and a different callable surface.
compare function_argument_defaults "
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
       p.pronargdefaults,
       coalesce(pg_catalog.pg_get_expr(p.proargdefaults, 0), '<none>')
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)"

# The BODY, byte for byte. This is the section that forces schema.sql
# and the migration to carry the identical function text, which is the
# property that kept PR #20, PR #21 and PR #22 honest.
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

# THE section for this migration. `create or replace` preserves the
# ACL; a drop-and-create would not, and would hand PUBLIC an EXECUTE
# grant that path A never issues.
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

# The ONE signature that must exist, and the overloads that must NOT,
# as a POPULATED comparison rather than an empty one. `select ... where
# not exists` would return zero rows on a correct database, which is
# exactly the vacuous shape the non-vacuity gate above rejects -- so
# each candidate signature yields a row carrying its own resolution
# result instead.
#
# The three absent candidates are the arities `create or replace` would
# NOT have replaced: a migration that changed a parameter type would
# leave the base function standing and add a second one beside it,
# which is a strictly worse outcome than an error and is invisible to a
# body comparison.
compare search_books_signatures "
select sig, (pg_catalog.to_regprocedure(sig) is not null)::text as present
  from unnest(array[
    '${FN_SIG}',
    'public.search_books(text,text,integer,integer)',
    'public.search_books(text,text,bigint,bigint,integer)',
    'public.search_books(text,text,numeric,numeric,integer)'
  ]::text[]) as sig
 order by sig"

# Effective privileges, resolved per role rather than read off the ACL
# string, so role membership and PUBLIC inheritance are included.
#
# has_function_privilege() raises rather than returning null for a role
# that does not exist, and an errored section would compare two empty
# outputs -- so a missing role becomes a printed '<no such role>' row
# instead. Both databases live in the SAME cluster and roles are
# cluster-scoped, so that value is always identical between them; it
# records which roles the checking environment actually had, which is
# the honest thing for a local run against a non-Supabase cluster to
# say rather than silently proving less than it appears to.
compare search_books_effective_privileges "
select role_name,
       case
         when role_name = 'public'
           or exists (select 1 from pg_catalog.pg_roles r where r.rolname = role_name)
         then has_function_privilege(role_name, '${FN_SIG}', 'EXECUTE')::text
         else '<no such role>'
       end
  from unnest(array['public','anon','authenticated','service_role','postgres']::text[]) as role_name
 order by role_name"

# ============================================================
# Beyond equivalence: the two databases must AGREE ON A DATABASE THAT
# CARRIES THE CHANGE, not on two copies of the base. Everything above
# would pass if neither path had applied anything.
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      -- exactly one search_books, at the unchanged five-argument arity
      (select count(*) from pg_catalog.pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.proname = '${FN_NAME}') = 1
      and pg_catalog.to_regprocedure('${FN_SIG}') is not null
      -- the deliberately unrenamed parameter names survive verbatim
      and (select array_to_string(p.proargnames, ',') from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = '${FN_NAME}')
          -- proargnames carries the RETURNS TABLE output column too,
          -- which is why book_id is part of this string.
          = 'search_term,genre_filter,min_price_cents,max_price_cents,result_limit,book_id'
      -- SECURITY INVOKER, STABLE, empty search_path: all unchanged
      and exists (select 1 from pg_catalog.pg_proc p
                   where p.pronamespace = 'public'::regnamespace
                     and p.proname = '${FN_NAME}'
                     and not p.prosecdef
                     and p.provolatile = 's'
                     and coalesce(array_to_string(p.proconfig, ','), '') = 'search_path=\"\"')
      -- PUBLIC holds no EXECUTE; anon and authenticated do
      and not has_function_privilege('public', '${FN_SIG}', 'EXECUTE')
      and has_function_privilege('anon', '${FN_SIG}', 'EXECUTE')
      and has_function_privilege('authenticated', '${FN_SIG}', 'EXECUTE')
      -- The body carries the ALL predicates and NONE of the legacy
      -- ones. These patterns deliberately match EXECUTABLE text: the
      -- body's own comments name price_cents while explaining why it
      -- is gone, so a bare '%price_cents%' probe would be defeated by
      -- the very comment documenting its removal. The comment-stripped
      -- source is what the negative probes run against; the 'n' flag is
      -- what makes the dot metacharacter stop at a line break, so each
      -- comment is removed to end of line rather than the rest of the
      -- body. (No backquotes in this string: it is inside a
      -- double-quoted shell word, where a backquote is command
      -- substitution.)
      and (select p.prosrc from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = '${FN_NAME}') like '%books.price_all is not null%'
      and (select p.prosrc from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = '${FN_NAME}') like '%books.price_all >= min_price_cents%'
      and (select p.prosrc from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = '${FN_NAME}') like '%books.price_all <= max_price_cents%'
      and (select regexp_replace(p.prosrc, '--.*$', '', 'gn') from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = '${FN_NAME}') not like '%price_cents >%'
      and (select regexp_replace(p.prosrc, '--.*$', '', 'gn') from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = '${FN_NAME}') not like '%price_cents <%'
      and (select regexp_replace(p.prosrc, '--.*$', '', 'gn') from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = '${FN_NAME}') not like '%books.price_cents%'
      -- the ALL catalog column this body now reads actually exists,
      -- with the domain PR #21 gave it
      and exists (select 1 from pg_catalog.pg_attribute a
                   where a.attrelid = 'public.books'::regclass
                     and a.attname = 'price_all'
                     and not a.attisdropped
                     and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'integer')
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry the ALL-SEARCH-1 function surface, parameter names, privileges or body" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: one 5-arg search_books, names unrenamed, invoker + stable + empty search_path, PUBLIC denied / anon+authenticated allowed, ALL predicates only"
  fi
done

# The exact resulting owner and ACL, printed rather than only
# asserted. This is a MEASURED catalog fact about the environment, not
# evidence about what the migration did -- equivalence between A and B
# is the claim, and it is made by the function_acls section above, not
# by this line. It is printed because `create or replace` preserving
# an ACL is the premise of this whole migration, and a reviewer should
# be able to see the actual string.
for db in "$DB_A" "$DB_B"; do
  ACL="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select coalesce(p.proacl::text, '<default>')
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname = '${FN_NAME}'" 2>/dev/null)"
  OWNER="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select p.proowner::regrole::text
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname = '${FN_NAME}'" 2>/dev/null)"
  echo "  measured [$db]: owner=$OWNER proacl=$ACL"
done

# ============================================================
# Part 2: the migration applied over POPULATED data.
#
# Everything above compares two EMPTY databases, which is the right way
# to compare shape and the wrong way to learn what happens to rows that
# already exist.
#
# Two separate claims are made here, and they are deliberately NOT the
# same claim:
#
#   (a) this migration writes no row. It replaces a function body and
#       nothing else, and "writes no row" is a statement about a
#       database that HAS rows, which an empty comparison cannot make.
#
#   (b) applying it is NOT behaviour-free, and the harness measures
#       exactly how. Before, an unpriced published book is returned by
#       search_books; after, it is not -- while the function still
#       resolves through the SAME named-argument call the currently
#       deployed application makes. That is the rollout note in the
#       migration header, demonstrated instead of asserted in prose.
# ============================================================
cat > "$WORKDIR/rows.sql" <<'FIXTURES'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0630f00-0000-0000-0000-000000000001', 'p063-harness-author@test', now(),
   '{"role":"author","display_name":"P063 Harness Author","public_author_name":"P063 Harness Pen"}');

update public.profiles
  set role = 'author', public_author_name = 'P063 Harness Pen'
  where id = 'e0630f00-0000-0000-0000-000000000001';

-- A priced book and an UNPRICED one, both published and both matching
-- the same search term. The unpriced row carries a real legacy
-- price_cents, so a body that fell back to it would keep returning the
-- row and this harness would say so.
insert into public.books (id, author_id, title, description, keywords, status, price_cents, price_all) values
  ('e0630f01-0000-0000-0000-000000000001', 'e0630f00-0000-0000-0000-000000000001',
   'P063 Harness Priced', 'harness priced title', 'p063harness', 'published', 799, 500),
  ('e0630f02-0000-0000-0000-000000000001', 'e0630f00-0000-0000-0000-000000000001',
   'P063 Harness Unpriced', 'harness unpriced title', 'p063harness', 'published', 25000, null);
FIXTURES

cat > "$WORKDIR/fingerprint.sql" <<'FINGERPRINT'
select 'books:' || coalesce(string_agg(b.id::text || ':' || b.title || ':' || b.status || ':' ||
        b.price_cents::text || ':' || coalesce(b.price_all::text, '-'), ',' order by b.id), '<none>')
  from public.books b
union all
select 'profiles:' || coalesce(string_agg(p.id::text || ':' || p.role || ':' ||
        coalesce(p.public_author_name, '-'), ',' order by p.id), '<none>')
  from public.profiles p;
FINGERPRINT

# The call the currently deployed application makes, by NAME, exactly as
# PostgREST sends it. If this stopped resolving, the rollout note would
# be wrong in the dangerous direction.
SEARCH_CALL="select coalesce(string_agg(s.book_id::text, ',' order by s.book_id::text), '<none>')
  from public.search_books(
    search_term => 'P063 Harness',
    genre_filter => null,
    min_price_cents => null,
    max_price_cents => null,
    result_limit => 500) s"

echo "  building C: ${BASE_REF:0:9}:$SCHEMA_PATH + rows, then the migration"
build "$DB_C" "$STUB" "$WORKDIR/base_schema.sql" "$WORKDIR/rows.sql"

SECTIONS=$((SECTIONS + 1))
set +e
psql -X -q -t -A -F '|' -d "$DB_C" -v ON_ERROR_STOP=1 -f "$WORKDIR/fingerprint.sql" \
  > "$WORKDIR/before.out" 2> "$WORKDIR/before.err"
BEFORE_RC=$?
psql -X -q -t -A -d "$DB_C" -v ON_ERROR_STOP=1 -c "$SEARCH_CALL" \
  > "$WORKDIR/search_before.out" 2> "$WORKDIR/search_before.err"
SEARCH_BEFORE_RC=$?
set -e

# Applied the way it will be applied to staging: one transaction,
# ON_ERROR_STOP.
set +e
psql -X -q -d "$DB_C" -v ON_ERROR_STOP=1 --single-transaction -f "$MIGRATION" \
  > /dev/null 2> "$WORKDIR/migrate.err"
MIGRATE_RC=$?
set -e

set +e
psql -X -q -t -A -F '|' -d "$DB_C" -v ON_ERROR_STOP=1 -f "$WORKDIR/fingerprint.sql" \
  > "$WORKDIR/after.out" 2> "$WORKDIR/after.err"
AFTER_RC=$?
psql -X -q -t -A -d "$DB_C" -v ON_ERROR_STOP=1 -c "$SEARCH_CALL" \
  > "$WORKDIR/search_after.out" 2> "$WORKDIR/search_after.err"
SEARCH_AFTER_RC=$?
set -e

# This migration is a single `create or replace`, so unlike 062 it
# emits no NOTICE and its stderr is held to the same empty-stderr rule
# as every other step here.
if [ "$BEFORE_RC" -ne 0 ] || [ "$AFTER_RC" -ne 0 ] \
   || [ -s "$WORKDIR/before.err" ] || [ -s "$WORKDIR/after.err" ]; then
  echo "FAIL [populated_migration]: could not fingerprint the populated database" >&2
  tail -n 5 "$WORKDIR/before.err" "$WORKDIR/after.err" >&2 || true
  FAILURES=$((FAILURES + 1))
elif [ "$MIGRATE_RC" -ne 0 ] || [ -s "$WORKDIR/migrate.err" ]; then
  echo "FAIL [populated_migration]: the migration failed, or wrote to stderr, against a database with rows in it" >&2
  tail -n 10 "$WORKDIR/migrate.err" >&2
  FAILURES=$((FAILURES + 1))
elif [ ! -s "$WORKDIR/before.out" ]; then
  echo "FAIL [populated_migration]: the fixture produced no rows -- this comparison would pass vacuously" >&2
  FAILURES=$((FAILURES + 1))
elif grep -q '<none>' "$WORKDIR/before.out"; then
  echo "FAIL [populated_migration]: the fixture inserted nothing -- this comparison would pass vacuously" >&2
  cat "$WORKDIR/before.out" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/before.out" "$WORKDIR/after.out"; then
  echo "FAIL [populated_migration]: the migration changed existing rows" >&2
  diff "$WORKDIR/before.out" "$WORKDIR/after.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated_migration]: every pre-existing book and profile row is byte-identical after the migration"
fi

# (b) the measured, intentional behaviour change.
SECTIONS=$((SECTIONS + 1))
PRICED='e0630f01-0000-0000-0000-000000000001'
UNPRICED='e0630f02-0000-0000-0000-000000000001'
SB="$(cat "$WORKDIR/search_before.out")"
SA="$(cat "$WORKDIR/search_after.out")"
if [ "$SEARCH_BEFORE_RC" -ne 0 ] || [ "$SEARCH_AFTER_RC" -ne 0 ] \
   || [ -s "$WORKDIR/search_before.err" ] || [ -s "$WORKDIR/search_after.err" ]; then
  echo "FAIL [rollout_effect]: the deployed application's named-argument call did not resolve" >&2
  tail -n 5 "$WORKDIR/search_before.err" "$WORKDIR/search_after.err" >&2 || true
  FAILURES=$((FAILURES + 1))
elif [ "$SB" = "<none>" ] || [ "$SA" = "<none>" ]; then
  echo "FAIL [rollout_effect]: search returned nothing on one side (before='$SB' after='$SA') -- this comparison would pass vacuously" >&2
  FAILURES=$((FAILURES + 1))
elif ! printf '%s' "$SB" | grep -q "$UNPRICED"; then
  echo "FAIL [rollout_effect]: the BASE function did not return the unpriced book, so there is no change to measure" >&2
  echo "  before='$SB'" >&2
  FAILURES=$((FAILURES + 1))
elif printf '%s' "$SA" | grep -q "$UNPRICED"; then
  echo "FAIL [rollout_effect]: the unpriced book is STILL returned after the migration" >&2
  echo "  after='$SA'" >&2
  FAILURES=$((FAILURES + 1))
elif ! printf '%s' "$SA" | grep -q "$PRICED"; then
  echo "FAIL [rollout_effect]: the priced book stopped being returned -- the exclusion is too wide" >&2
  echo "  after='$SA'" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [rollout_effect]: the deployed named-argument call still resolves; the unpriced book is returned BEFORE and gone AFTER, the priced book is returned throughout"
  echo "    measured: before=[$SB] after=[$SA]"
  echo "    This is the migration header's rollout note, measured: applying this ahead of the"
  echo "    application deploy removes every null-price book from search immediately. It is"
  echo "    intentional under the null-price rule; it is NOT a behaviour-free interval."
fi

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 063_all_search_books_price_all_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 063_all_search_books_price_all_catalog_equivalence.sh -- $SECTIONS catalog sections identical between $PATCHED_LABEL and ${BASE_REF:0:9} + migration, none empty"
