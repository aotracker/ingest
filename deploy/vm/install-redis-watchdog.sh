#!/usr/bin/env bash
# Upgrade an existing OVH VM: Redis entrypoint, healthcheck, and watchdog cron.
# Run from /home/ubuntu/ingest after git pull:
#   sudo bash deploy/vm/install-redis-watchdog.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INGEST_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PG_DIR="${PG_DIR:-/opt/albion-postgres}"
INGEST_DIR="${INGEST_DIR:-$INGEST_ROOT}"

if [[ ! -d "$PG_DIR" ]]; then
  echo "ERROR: $PG_DIR not found." >&2
  echo "Postgres + Redis must be set up first (see deploy/vm/README.md)." >&2
  exit 1
fi

echo "==> Copy Redis scripts to $PG_DIR"
cp "$SCRIPT_DIR/redis-entrypoint.sh" "$PG_DIR/redis-entrypoint.sh"
cp "$SCRIPT_DIR/redis-watchdog.sh" "$PG_DIR/redis-watchdog.sh"
chmod +x "$PG_DIR/redis-entrypoint.sh" "$PG_DIR/redis-watchdog.sh"

echo "==> Update docker-compose.yml"
cp "$SCRIPT_DIR/docker-compose.prod.yml" "$PG_DIR/docker-compose.yml"

echo "==> Recreate Redis container (brief queue pause)"
cd "$PG_DIR"
docker compose up -d redis
sleep 3
docker exec albion-redis redis-cli REPLICAOF NO ONE >/dev/null 2>&1 || true
echo "Redis role: $(docker exec albion-redis redis-cli INFO replication | grep '^role:' | tr -d '\r')"

echo "==> Install watchdog cron for ubuntu"
WATCHDOG_CRON="*/2 * * * * $PG_DIR/redis-watchdog.sh >> /var/log/redis-watchdog.log 2>&1"
touch /var/log/redis-watchdog.log
chown ubuntu:ubuntu /var/log/redis-watchdog.log 2>/dev/null || true
EXISTING="$(crontab -u ubuntu -l 2>/dev/null || true)"
if echo "$EXISTING" | grep -Fq "$PG_DIR/redis-watchdog.sh"; then
  echo "Watchdog cron already installed"
else
  (echo "$EXISTING"; echo "$WATCHDOG_CRON") | crontab -u ubuntu -
  echo "Installed: $WATCHDOG_CRON"
fi

if [[ -d "$INGEST_DIR" && -f "$INGEST_DIR/package.json" ]]; then
  echo "==> Restart ingest PM2 apps"
  sudo -u ubuntu bash -c "cd '$INGEST_DIR' && npm run pm2:restart"
fi

echo ""
echo "Done. Verify:"
echo "  docker exec albion-redis redis-cli INFO replication | grep role"
echo "  curl -s http://127.0.0.1:\${INGEST_API_PORT:-3001}/health"
echo "  tail -f /var/log/redis-watchdog.log"
