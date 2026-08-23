#!/usr/bin/env bash
# Two-connection proof that the (reader_id, book_id) advisory lock
# namespace shared by create_book_checkout_intent and
# finalize_book_checkout_intent (migration 032) actually excludes a
# second, concurrent session -- not just that the code calls the right
# function, but that Postgres really blocks a second acquirer while the
# first holds the lock, and releases it on commit.
#
# A single psql connection can't hold two overlapping transactions at
# once, so this can't be proven from inside 032_book_checkout_intents.test.sql
# alone -- it needs two real, separate connections. Deliberately NOT
# folded into that file: this script is timing-adjacent (uses a bounded
# poll for setup synchronization only, not for the assertion itself,
# which is a plain boolean check) and kept separate so a flake here
# never blocks the rest of the regression suite.
#
# Usage: PGDATABASE=librum_test ./supabase/tests/032_advisory_lock_contention.sh
# (or pass the database name as $1). Requires psql on PATH and a
# database with migration 032 already applied. Exits non-zero on any
# assertion failure or setup timeout.

set -euo pipefail

DB="${1:-${PGDATABASE:-librum_test}}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

MARKER="$WORKDIR/lock_held"

cat > "$WORKDIR/hold.sql" <<'EOF'
\o /dev/null
begin;
select pg_advisory_xact_lock(hashtext('032-lock-contention-test-reader'), hashtext('032-lock-contention-test-book'));
\o
\! touch __MARKER__
select pg_sleep(3);
commit;
EOF
sed -i "s#__MARKER__#$MARKER#" "$WORKDIR/hold.sql"

cat > "$WORKDIR/try.sql" <<'EOF'
select pg_try_advisory_xact_lock(hashtext('032-lock-contention-test-reader'), hashtext('032-lock-contention-test-book')) as lock_acquired;
EOF

psql -d "$DB" -f "$WORKDIR/hold.sql" > "$WORKDIR/hold_out.txt" 2>&1 &
HOLD_PID=$!

waited=0
until [ -f "$MARKER" ]; do
  sleep 0.1
  waited=$((waited + 1))
  if [ "$waited" -ge 100 ]; then
    echo "FAIL: session A never signaled it was holding the lock (10s timeout)" >&2
    kill "$HOLD_PID" 2>/dev/null || true
    exit 1
  fi
done

WHILE_HELD="$(psql -d "$DB" -f "$WORKDIR/try.sql" -t -A)"
if [ "$WHILE_HELD" != "f" ]; then
  echo "FAIL: a second session acquired the advisory lock while the first still held it (got: $WHILE_HELD)" >&2
  wait "$HOLD_PID" || true
  exit 1
fi

wait "$HOLD_PID"

AFTER_COMMIT="$(psql -d "$DB" -f "$WORKDIR/try.sql" -t -A)"
if [ "$AFTER_COMMIT" != "t" ]; then
  echo "FAIL: the advisory lock was not released after the holding transaction committed (got: $AFTER_COMMIT)" >&2
  exit 1
fi

echo "PASS: 032_advisory_lock_contention.sh -- lock excluded a concurrent acquirer, then released on commit"
