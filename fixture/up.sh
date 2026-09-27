#!/usr/bin/env bash
# Boot the private-database SSH fixture. Idempotent: safe to re-run.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

if [[ ! -f ssh/id_ed25519 ]]; then
  echo "==> generating fixture SSH keypair"
  ssh-keygen -t ed25519 -N '' -C 'dbscope-fixture' -f ssh/id_ed25519 >/dev/null
fi
chmod 600 ssh/id_ed25519
chmod 644 ssh/id_ed25519.pub

# The init scripts are read by the in-container database user, not by us.
# A default umask of 077 leaves them mode 600, and the entrypoint then dies
# with a bare "Permission denied", so set the mode explicitly every run.
chmod 755 mysql postgres
chmod 644 mysql/*.sql postgres/*.sql

# Another sshd (or a leftover fixture) may already own the default port, so
# find a free one and record it for the verifier and the UI to read.
pick_port() {
  local candidate
  for candidate in $(seq 2222 2299); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$candidate") 2>/dev/null; then
      echo "$candidate"
      return 0
    fi
    exec 3<&- 2>/dev/null || true
  done
  echo "no free port in 2222-2299" >&2
  return 1
}

DBSCOPE_SSH_PORT="${DBSCOPE_SSH_PORT:-$(pick_port)}"
export DBSCOPE_SSH_PORT
echo "$DBSCOPE_SSH_PORT" > .ssh-port
echo "==> ssh port: $DBSCOPE_SSH_PORT"

echo "==> starting containers (first run seeds ~1M rows, please wait)"
docker compose up -d --build

echo "==> waiting for both databases to finish seeding"
for _ in $(seq 1 240); do
  mysql_ready=$(docker compose exec -T mysql mysql -uappuser -papppass appdb \
    -sN -e 'SELECT COUNT(*) FROM post_categories' 2>/dev/null || true)
  pg_ready=$(docker compose exec -T postgres psql -U appuser -d appdb \
    -tA -c 'SELECT count(*) FROM post_categories' 2>/dev/null || true)
  if [[ -n "$mysql_ready" && -n "$pg_ready" ]]; then
    break
  fi
  sleep 3
done

# Both engines are seeded from equivalent scripts and must end up identical, so
# the row counts are printed side by side: a mismatch here means the two are no
# longer comparable.
echo
printf '  %-18s %12s %12s\n' TABLE MYSQL POSTGRES
for table in users posts comments reactions categories post_categories; do
  m=$(docker compose exec -T mysql mysql -uappuser -papppass appdb \
        -sN -e "SELECT COUNT(*) FROM $table" 2>/dev/null | tr -d '\r')
  p=$(docker compose exec -T postgres psql -U appuser -d appdb \
        -tA -c "SELECT count(*) FROM $table" 2>/dev/null | tr -d '\r')
  marker=$([[ "$m" == "$p" ]] && echo '' || echo '  <- DIFFERS')
  printf '  %-18s %12s %12s%s\n' "$table" "$m" "$p" "$marker"
done
echo

# DBSCOPE verifies host keys against known_hosts by default. Recording the
# fixture's key here means the local workflow exercises the same safe path a
# real connection takes, instead of the insecure opt-out.
known_hosts="$here/.known_hosts"
ssh-keyscan -p "$DBSCOPE_SSH_PORT" -H 127.0.0.1 > "$known_hosts" 2>/dev/null
echo "==> recorded fixture host key in $known_hosts"

cat <<EOF

==> fixture ready

  SSH        127.0.0.1:$DBSCOPE_SSH_PORT  user: appuser  key: $here/ssh/id_ed25519

  MySQL      host: mysql     port: 3306
  PostgreSQL host: postgres  port: 5432

  Both reachable only through the SSH tunnel, and both hold the same schema and
  the same rows, so the two engines can be compared directly.

  user: appuser  password: apppass  database: appdb

  These credentials are for this local fixture only.

  Confirm the two are identical with: pnpm verify:parity

  Host key recorded in fixture/.known_hosts. To let DBSCOPE use it:

    DBSCOPE_KNOWN_HOSTS=$known_hosts pnpm start

EOF
