#!/usr/bin/env bash
# ALL-CHECKOUT-1: proves that a database built from the PATCHED
# supabase/schema.sql and one built from the BASE schema plus the new
# migration describe the same database -- not approximately, across
# every catalog that can differ.
#
# Modelled on 061_all_catalog_schema_expansion_catalog_equivalence.sh
# and 060_pok_fulfilment_gap_first_seen_catalog_equivalence.sh, which
# exist for the same reason: this repository has two build paths -- a
# fresh environment is created from schema.sql, staging is migrated --
# and nothing else compares them.
#
# Why the risk is concrete in THIS change rather than theoretical:
#
#   * this migration DROPS a function and CREATES a different one with
#     a narrower parameter list. Function identity in Postgres is
#     (name, argument types), so a drop list that misses an arity, or a
#     create whose parameter types differ by one `text` on one path,
#     produces two databases that both look correct in isolation and
#     disagree about which functions exist.
#   * the whole body is duplicated between schema.sql and the
#     migration. Nothing but a prosrc comparison would notice a body
#     that drifted between them -- and the body is where the pricing
#     arithmetic, the 9900 floor and the three internal constants live,
#     so a drift there is a financial difference between a fresh
#     environment and staging.
#   * a newly created function is granted EXECUTE to PUBLIC by default.
#     The revokes that undo that run on both paths, and a path that
#     ended up without them would hand an anonymous caller a checkout
#     RPC. That is a proacl difference and nothing else here would see
#     it.
#   * two `comment on column` statements exist on both paths and on
#     neither table's definition, so a comment present on one path only
#     is exactly the kind of difference a "does the column exist" check
#     passes over.
#
# Every section must ALSO be non-vacuous, and that is enforced rather
# than hoped for: two identical EMPTY results are the failure mode a
# "byte-identical outputs" check silently passes. So each section
# requires a non-zero row count on BOTH sides, a zero exit status from
# psql, and empty stderr -- and stderr is captured to its own file,
# never merged into the stdout that is later compared, so a matching
# error message can never be mistaken for matching catalog output.
#
# `"char"` columns (contype, typtype, relkind) are cast to text
# explicitly: without the cast the query errors, and an errored section
# would otherwise compare two empty outputs and report a pass.
#
# Usage, from the repo root, against a cluster where the connecting
# user may create and drop databases:
#
#   ./supabase/tests/062_all_checkout_intent_catalog_equivalence.sh
#
# Overrides: BASE_REF, MIGRATION, STUB, SCHEMA_PATH, MARKER, and either
# SCHEMA (an explicit patched-schema file) or PATCHED_REF (an explicit
# patched-schema commit). Exits non-zero on any difference, any empty
# section, any non-zero psql exit, or anything written to stderr.

set -euo pipefail

# The commit whose supabase/schema.sql is the BASE this migration was
# written against: origin/staging at the time, the merge of PR #21.
BASE_REF="${BASE_REF:-15dbc4113507a5f4dc540afee6704831ec0d9412}"
MIGRATION="${MIGRATION:-supabase/migrations/20260922113721_all_checkout_intent_arithmetic.sql}"
STUB="${STUB:-supabase/tests/00_stub_supabase_platform.sql}"
SCHEMA_PATH="${SCHEMA_PATH:-supabase/schema.sql}"
# The identifier that must be ABSENT from the base schema and PRESENT in
# the patched one. This is what makes "we resolved the wrong schema" a
# named failure instead of a confusing diff.
MARKER="${MARKER:-ALL-CHECKOUT-1}"
# This migration may still be uncommitted, so the working-tree
# comparison is permitted here. Harnesses for merged migrations set 0.
ALLOW_WORKTREE=1

# The function under change, and every signature this migration removes.
# Listed once, used by three sections below.
FN_NAME="create_book_checkout_intent"
OBSOLETE_SIGS="public.create_book_checkout_intent(uuid,text)
public.create_book_checkout_intent(uuid,text,text,text,integer)
public.create_book_checkout_intent(uuid,text,text,text,integer,boolean,uuid)"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

for f in "$MIGRATION" "$STUB"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: $f not found -- run this from a checkout that carries the patch" >&2
    exit 1
  fi
done

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

SUFFIX="$$"
DB_A="librum_all_checkout_a_${SUFFIX}"
DB_B="librum_all_checkout_b_${SUFFIX}"
WORKDIR="$(mktemp -d)"

cleanup() {
  dropdb --if-exists "$DB_A" >/dev/null 2>&1 || true
  dropdb --if-exists "$DB_B" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

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

# The base must actually carry the OLD surface, or "the old overload is
# gone" is being proved against a database that never had it.
if ! grep -q 'create_book_checkout_intent(uuid, text, text, text, integer, boolean, uuid)' "$WORKDIR/base_schema.sql"; then
  echo "FAIL: ${BASE_REF}:${SCHEMA_PATH} does not define the seven-argument create_book_checkout_intent -- wrong base" >&2
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

# The signature, in the raw catalog terms the migration actually has to
# get right. pg_get_functiondef above renders the same facts, but this
# section is the one that names them individually, so a difference says
# WHICH of them moved rather than dumping two function bodies.
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

# The BODY, byte for byte. This is the section that forces schema.sql
# and the migration to carry the identical function text, which is the
# property that kept PR #20 and PR #21 honest.
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

# Object comments, column and otherwise. This change ships two
# `comment on column` statements on both paths, and nothing else in
# this file would notice if one path carried a comment the other did
# not.
compare column_comments "
select c.relname, a.attname, d.description
  from pg_catalog.pg_description d
  join pg_catalog.pg_class c on c.oid = d.objoid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attribute a
    on a.attrelid = d.objoid and a.attnum = d.objsubid
 where n.nspname = 'public' and d.objsubid > 0
 order by c.relname, a.attnum"

# The removed overloads, as a POPULATED comparison rather than an empty
# one. `select ... where not exists` would return zero rows on a
# correct database, which is exactly the vacuous shape the non-vacuity
# gate above exists to reject -- so each obsolete signature yields a
# row carrying its own resolution result instead.
OBSOLETE_SQL="select sig, (pg_catalog.to_regprocedure(sig) is null)::text as absent
  from unnest(array[$(printf "'%s'," $OBSOLETE_SIGS | sed 's/,$//')]::text[]) as sig
 order by sig"
compare obsolete_overloads "$OBSOLETE_SQL"

# Same shape for the function that must EXIST, so "both databases
# resolved nothing" cannot be mistaken for agreement.
compare current_signature "
select 'public.${FN_NAME}(uuid,text,boolean,uuid)' as sig,
       (pg_catalog.to_regprocedure('public.${FN_NAME}(uuid,text,boolean,uuid)') is not null)::text as present"

# ============================================================
# Beyond equivalence: the two databases must AGREE ON A DATABASE THAT
# CARRIES THE CHANGE, not on two copies of the base. Everything above
# would pass if neither path had applied anything.
# ============================================================
for db in "$DB_A" "$DB_B"; do
  SECTIONS=$((SECTIONS + 1))
  PRESENT="$(psql -X -q -t -A -d "$db" -v ON_ERROR_STOP=1 -c "
    select (
      -- exactly one create_book_checkout_intent, of arity 4
      (select count(*) from pg_catalog.pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.proname = '${FN_NAME}') = 1
      and exists (select 1 from pg_catalog.pg_proc p
                   where p.pronamespace = 'public'::regnamespace
                     and p.proname = '${FN_NAME}' and p.pronargs = 4)
      -- none of the removed parameter names survives anywhere
      and not exists (select 1 from pg_catalog.pg_proc p
                       where p.pronamespace = 'public'::regnamespace
                         and p.proname = '${FN_NAME}'
                         and (p.proargnames && array['p_regime','p_currency','p_royalty_rate_bps']))
      -- SECURITY DEFINER with an empty search_path
      and exists (select 1 from pg_catalog.pg_proc p
                   where p.pronamespace = 'public'::regnamespace
                     and p.proname = '${FN_NAME}'
                     and p.prosecdef
                     and coalesce(array_to_string(p.proconfig, ','), '') = 'search_path=\"\"')
      -- PUBLIC and anon hold no EXECUTE; authenticated does
      and not has_function_privilege('public', 'public.${FN_NAME}(uuid,text,boolean,uuid)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.${FN_NAME}(uuid,text,boolean,uuid)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.${FN_NAME}(uuid,text,boolean,uuid)', 'EXECUTE')
      -- The body carries the new arithmetic and none of the old.
      -- These patterns deliberately match EXECUTABLE text, not bare
      -- words: the body's own comments name greatest() and the old
      -- v_price_cents variable while explaining why they are gone, so
      -- a bare '%greatest(%' probe would be defeated by the very
      -- comment documenting its removal.
      and (select p.prosrc from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = '${FN_NAME}') like '%v_minimum_paid_minor constant integer := 9900%'
      and (select p.prosrc from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = '${FN_NAME}') like '%v_price_minor := v_book.price_all * 100%'
      and (select p.prosrc from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = '${FN_NAME}') not like '%:= greatest(%'
      and (select p.prosrc from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = '${FN_NAME}') not like '%v_book.price_cents%'
      and (select p.prosrc from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = '${FN_NAME}') not like '%b.price_cents%'
      -- both column comments exist
      and exists (select 1 from pg_catalog.pg_description d
                   join pg_catalog.pg_attribute a
                     on a.attrelid = d.objoid and a.attnum = d.objsubid
                  where d.objoid = 'public.book_checkout_intents'::regclass
                    and a.attname = 'price_cents_at_checkout')
      and exists (select 1 from pg_catalog.pg_description d
                   join pg_catalog.pg_attribute a
                     on a.attrelid = d.objoid and a.attnum = d.objsubid
                  where d.objoid = 'public.purchases'::regclass
                    and a.attname = 'amount_cents')
    )::text" 2> "$WORKDIR/present.err")"
  if [ -s "$WORKDIR/present.err" ] || [ "$PRESENT" != "true" ]; then
    echo "FAIL: $db does not carry the ALL-CHECKOUT-1 function surface, privileges, body or comments" >&2
    tail -n 5 "$WORKDIR/present.err" >&2 || true
    FAILURES=$((FAILURES + 1))
  else
    echo "  ok [carries_change:$db]: arity 4, no removed parameters, definer + empty search_path, PUBLIC/anon denied, new arithmetic, both comments"
  fi
done

# The exact resulting ACL, printed rather than only asserted. Default
# privileges on a real Supabase project may leave a direct service_role
# grant that this migration never issued; that is a MEASURED catalog
# fact about the environment, not evidence about what the migration
# did. Equivalence between A and B is the claim -- and it is made by
# the function_acls section above, not by this line.
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
# already exist. This migration writes no rows -- that is its rollback
# story -- and "writes no rows" is a claim about a database that HAS
# rows, which an empty comparison cannot make.
#
# The fixture deliberately includes a legacy_stripe_connect_v1/USD
# intent, because decision B3 keeps exactly those readable and
# finalizable while removing the ability to mint new ones.
# ============================================================
DB_C="librum_all_checkout_c_${SUFFIX}"

cleanup_c() {
  dropdb --if-exists "$DB_C" >/dev/null 2>&1 || true
}
trap 'cleanup; cleanup_c' EXIT

cat > "$WORKDIR/legacy_rows.sql" <<'FIXTURES'
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0620f00-0000-0000-0000-000000000001', 'p062-harness-author@test', now(),
   '{"role":"author","display_name":"P062 Harness Author"}'),
  ('e0620f00-0000-0000-0000-000000000002', 'p062-harness-reader@test', now(),
   '{"role":"reader","display_name":"P062 Harness Reader"}');

insert into public.books (id, author_id, title, price_cents, status) values
  ('e0620f01-0000-0000-0000-000000000001', 'e0620f00-0000-0000-0000-000000000001', 'P062 Harness Legacy USD Book', 799, 'published');

-- An open legacy intent and a settled one. Neither may be touched by a
-- migration that only replaces a function.
insert into public.book_checkout_intents
  (id, book_id, reader_id, book_title, price_cents_at_checkout, expires_at,
   regime, currency, royalty_rate_bps)
values ('e0620f02-0000-0000-0000-000000000001', 'e0620f01-0000-0000-0000-000000000001',
        'e0620f00-0000-0000-0000-000000000002', 'P062 Harness Legacy USD Book', 799,
        now() + interval '23 hours', 'legacy_stripe_connect_v1', 'USD', null);

insert into public.book_checkout_intents
  (id, book_id, reader_id, book_title, price_cents_at_checkout, expires_at,
   regime, currency, royalty_rate_bps, completed_at, fulfilled_at,
   stripe_checkout_session_id, stripe_payment_intent_id)
values ('e0620f02-0000-0000-0000-000000000002', 'e0620f01-0000-0000-0000-000000000001',
        'e0620f00-0000-0000-0000-000000000002', 'P062 Harness Legacy USD Book', 799,
        now() + interval '23 hours', 'legacy_stripe_connect_v1', 'USD', null,
        now(), now(), 'cs_p062_harness', 'pi_p062_harness');

insert into public.purchases (id, book_id, reader_id, stripe_checkout_session_id, amount_cents) values
  ('e0620f03-0000-0000-0000-000000000001', 'e0620f01-0000-0000-0000-000000000001',
   'e0620f00-0000-0000-0000-000000000002', 'cs_p062_harness', 799);
FIXTURES

cat > "$WORKDIR/populated_before.sql" <<'BEFORE'
select 'intents:' || string_agg(i.id::text || ':' || i.price_cents_at_checkout::text || ':' ||
        i.regime || ':' || i.currency || ':' || coalesce(i.royalty_rate_bps::text, '-') || ':' ||
        coalesce(i.superseded_reason, '-'), ',' order by i.id)
  from public.book_checkout_intents i
union all
select 'purchases:' || string_agg(p.id::text || ':' || p.amount_cents::text, ',' order by p.id)
  from public.purchases p
union all
select 'books:' || string_agg(b.id::text || ':' || b.price_cents::text || ':' ||
        coalesce(b.price_all::text, '-'), ',' order by b.id)
  from public.books b;
BEFORE

echo "  building C: ${BASE_REF:0:9}:$SCHEMA_PATH + legacy rows, then the migration"
build "$DB_C" "$STUB" "$WORKDIR/base_schema.sql" "$WORKDIR/legacy_rows.sql"

SECTIONS=$((SECTIONS + 1))
set +e
psql -X -q -t -A -F '|' -d "$DB_C" -v ON_ERROR_STOP=1 -f "$WORKDIR/populated_before.sql" \
  > "$WORKDIR/populated_before.out" 2> "$WORKDIR/populated_before.err"
BEFORE_RC=$?
set -e

# Applied the way it will be applied to staging: one transaction,
# ON_ERROR_STOP.
set +e
psql -X -q -d "$DB_C" -v ON_ERROR_STOP=1 --single-transaction -f "$MIGRATION" \
  > /dev/null 2> "$WORKDIR/populated_migrate.err"
MIGRATE_RC=$?
set -e

set +e
psql -X -q -t -A -F '|' -d "$DB_C" -v ON_ERROR_STOP=1 -f "$WORKDIR/populated_before.sql" \
  > "$WORKDIR/populated_after.out" 2> "$WORKDIR/populated_after.err"
AFTER_RC=$?
set -e

# The migration emits NOTICEs for the `drop ... if exists` statements
# that match nothing, so stderr is expected to be non-empty here and
# only the EXIT STATUS decides. The two fingerprint reads are held to
# the stricter rule.
if [ "$BEFORE_RC" -ne 0 ] || [ "$AFTER_RC" -ne 0 ] \
   || [ -s "$WORKDIR/populated_before.err" ] || [ -s "$WORKDIR/populated_after.err" ]; then
  echo "FAIL [populated_migration]: could not fingerprint the populated database" >&2
  tail -n 5 "$WORKDIR/populated_before.err" "$WORKDIR/populated_after.err" >&2 || true
  FAILURES=$((FAILURES + 1))
elif [ "$MIGRATE_RC" -ne 0 ]; then
  echo "FAIL [populated_migration]: the migration failed against a database with rows in it" >&2
  tail -n 10 "$WORKDIR/populated_migrate.err" >&2
  FAILURES=$((FAILURES + 1))
elif [ ! -s "$WORKDIR/populated_before.out" ]; then
  echo "FAIL [populated_migration]: the fixture produced no rows -- this comparison would pass vacuously" >&2
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$WORKDIR/populated_before.out" "$WORKDIR/populated_after.out"; then
  echo "FAIL [populated_migration]: the migration changed existing rows" >&2
  diff "$WORKDIR/populated_before.out" "$WORKDIR/populated_after.out" | head -n 20 >&2
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [populated_migration]: every pre-existing intent, purchase and book row is byte-identical after the migration"
fi

# And the legacy rows are still READABLE and FINALIZABLE afterwards --
# decision B3's explicit carve-out, checked against a database that
# actually contains them rather than against the design document.
SECTIONS=$((SECTIONS + 1))
# The SETTLED legacy intent is the one used here. Replaying its
# finalization must still resolve to already_finalized -- the same
# answer it gave before the migration -- and the open one must still be
# readable through get_book_checkout_quote as its own reader, at its own
# USD amount. Between them they cover both halves of "historical legacy
# intents must remain readable and finalizable".
# get_book_checkout_quote is SECURITY DEFINER and bounded to
# auth.uid(), so the reader's subject has to be set on the SAME
# connection -- hence one -c carrying both statements, and tail -n1 to
# take the answer rather than set_config's echo.
LEGACY="$(psql -X -q -t -A -d "$DB_C" -v ON_ERROR_STOP=1 -c "
  select set_config('request.jwt.claim.sub', 'e0620f00-0000-0000-0000-000000000002', false);
  select (
    (select outcome from public.finalize_book_checkout_intent(
       'e0620f02-0000-0000-0000-000000000002'::uuid, 'cs_p062_after', 'pi_p062_after', 799)) = 'already_finalized'
    and (select count(*) from public.book_checkout_intents
          where regime = 'legacy_stripe_connect_v1') = 2
    and (select q.price_cents_at_checkout || ':' || q.currency
           from public.get_book_checkout_quote(
             'e0620f02-0000-0000-0000-000000000001'::uuid,
             'e0620f01-0000-0000-0000-000000000001'::uuid) q) = '799:USD'
  )::text" 2> "$WORKDIR/legacy.err" | tail -n1)"
if [ -s "$WORKDIR/legacy.err" ] || [ "$LEGACY" != "true" ]; then
  echo "FAIL [legacy_still_usable]: an existing legacy intent is no longer reachable through the legacy finalizer" >&2
  tail -n 5 "$WORKDIR/legacy.err" >&2 || true
  FAILURES=$((FAILURES + 1))
else
  echo "  ok [legacy_still_usable]: the pre-existing legacy intents are still there and still reach the legacy finalizer"
fi

if [ "$SECTIONS" -eq 0 ]; then
  echo "FAIL: no comparison ran" >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "FAIL: 062_all_checkout_intent_catalog_equivalence.sh -- $FAILURES of $SECTIONS comparisons failed" >&2
  exit 1
fi

echo "PASS: 062_all_checkout_intent_catalog_equivalence.sh -- $SECTIONS catalog sections identical between $PATCHED_LABEL and ${BASE_REF:0:9} + migration, none empty"
