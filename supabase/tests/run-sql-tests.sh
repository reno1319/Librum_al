#!/usr/bin/env bash
# LOCAL/DISPOSABLE DATABASE ONLY. Never point this at Staging or
# Production: it creates and drops databases and cluster roles.
#
# Runs every supabase/tests/*.test.sql suite, each in its own fresh
# database copied from one template built from
# 00_stub_supabase_platform.sql + supabase/schema.sql. CI runs it on
# PostgreSQL 17, the version Production runs (.github/workflows/ci.yml).
# The *.sh catalog-equivalence and contention harnesses are not run
# here: they compare against a base checkout or need several sessions.
#
# Usage, from the repo root, against a disposable PostgreSQL 17 server
# reached through the usual PGHOST/PGPORT/PGUSER variables (PGUSER must
# be a superuser):
#
#   LIBRUM_SQL_TESTS_DISPOSABLE=1 ./supabase/tests/run-sql-tests.sh
#
# Exit status is 0 only when the template builds and every suite passes.

set -uo pipefail

if [ "${LIBRUM_SQL_TESTS_DISPOSABLE:-}" != "1" ]; then
  echo "refusing to run: set LIBRUM_SQL_TESTS_DISPOSABLE=1 to confirm the server is disposable" >&2
  exit 2
fi

# Only a local server: a socket directory, localhost or 127.0.0.1.
case "${PGHOST:-}" in
  /*|localhost|127.0.0.1) ;;
  *)
    echo "refusing to run: PGHOST must be a local socket directory, localhost or 127.0.0.1 (got '${PGHOST:-}')" >&2
    exit 2
    ;;
esac

cd "$(dirname "$0")/../.." || exit 2

TEMPLATE=librum_sqltest_template
RUN_DB=librum_sqltest_run
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" -d postgres -c "select version();" -At || exit 2

# 00_stub grants to anon a few lines before the block that creates the
# platform roles, so they exist before it runs.
"${PSQL[@]}" -d postgres <<'SQL' || exit 2
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;
SQL

"${PSQL[@]}" -d postgres -c "drop database if exists $RUN_DB with (force);" || exit 2
"${PSQL[@]}" -d postgres -c "drop database if exists $TEMPLATE with (force);" || exit 2
"${PSQL[@]}" -d postgres -c "create database $TEMPLATE;" || exit 2

if ! "${PSQL[@]}" -d "$TEMPLATE" -f supabase/tests/00_stub_supabase_platform.sql > /dev/null; then
  echo "FAIL: 00_stub_supabase_platform.sql did not load" >&2
  exit 1
fi
if ! schema_output=$("${PSQL[@]}" -d "$TEMPLATE" -f supabase/schema.sql 2>&1 > /dev/null); then
  printf '%s\n' "$schema_output" | grep -E 'ERROR' | head -n 5 >&2
  echo "FAIL: supabase/schema.sql did not load" >&2
  exit 1
fi

passed=0
failed=()
for suite in supabase/tests/*.test.sql; do
  name=$(basename "$suite")
  "${PSQL[@]}" -d postgres -c "create database $RUN_DB template $TEMPLATE;" || exit 2
  if output=$("${PSQL[@]}" -d "$RUN_DB" -f "$suite" 2>&1); then
    echo "PASS: $name"
    passed=$((passed + 1))
  else
    echo "FAIL: $name"
    printf '%s\n' "$output" | grep -E 'ERROR|FAIL|CONTEXT' | head -n 5 | sed 's/^/    /'
    failed+=("$name")
  fi
  "${PSQL[@]}" -d postgres -c "drop database $RUN_DB with (force);" || exit 2
done

"${PSQL[@]}" -d postgres -c "drop database $TEMPLATE with (force);" || exit 2

echo "$passed passed, ${#failed[@]} failed"
if [ "${#failed[@]}" -ne 0 ]; then
  printf 'failed: %s\n' "${failed[@]}" >&2
  exit 1
fi
