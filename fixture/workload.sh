#!/usr/bin/env bash
# Generate application traffic so performance_schema has something to rank.
# The mix is intentionally lopsided: a few queries should dominate total time,
# which is exactly the signal DBSCOPE must surface.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rounds="${1:-3}"
echo "==> generating workload (${rounds} rounds)"

run() { docker compose exec -T mysql mysql -uappuser -papppass appdb -e "$1" >/dev/null 2>&1; }

for i in $(seq 1 "$rounds"); do
  # The timeline query: no index on created_at => full scan + filesort. The
  # single most expensive thing in the database, and the point of the demo.
  run "SELECT id, user_id, body, created_at FROM posts ORDER BY created_at DESC LIMIT 20;"

  # Per-user lookup: no index on user_id => full scan every time.
  run "SELECT COUNT(*) FROM posts WHERE user_id = $((RANDOM % 2000 + 1));"
  run "SELECT id, body FROM posts WHERE user_id = $((RANDOM % 2000 + 1)) ORDER BY created_at DESC LIMIT 10;"

  # Comment fan-out: no index on post_id.
  run "SELECT COUNT(*) FROM comments WHERE post_id = $((RANDOM % 262144 + 1));"

  # A join with an unindexed key on one side.
  run "SELECT p.id, COUNT(c.id) c FROM posts p LEFT JOIN comments c ON c.post_id = p.id WHERE p.id BETWEEN 1 AND 500 GROUP BY p.id;"

  # GROUP BY on an unindexed column => temporary table.
  run "SELECT mime, COUNT(*) FROM posts GROUP BY mime;"

  # The healthy counterexample: reactions.post_id IS indexed.
  run "SELECT COUNT(*) FROM reactions WHERE post_id = $((RANDOM % 262144 + 1));"

  # Cheap PK lookups, many times over: high count, low impact. Tests that the
  # ranking is by total time and not by call count.
  for _ in $(seq 1 5); do
    run "SELECT * FROM users WHERE id = $((RANDOM % 2000 + 1));"
  done

  echo "  round $i/$rounds done"
done

docker compose exec -T mysql mysql -uappuser -papppass appdb 2>/dev/null -e "
SELECT
  LEFT(DIGEST_TEXT, 60) AS query,
  COUNT_STAR AS execs,
  ROUND(SUM_TIMER_WAIT/1e9, 1) AS total_ms,
  SUM_ROWS_EXAMINED AS examined
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME = 'appdb'
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 8;"
