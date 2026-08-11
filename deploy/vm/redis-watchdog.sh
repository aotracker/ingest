#!/usr/bin/env bash
# VM cron helper: keep Redis writable and restart ingest when writes fail.
# Installed by deploy/vm/install-redis-watchdog.sh to /opt/albion-postgres/
set -euo pipefail

LOG_TAG="redis-watchdog"
REDIS_CONTAINER="${REDIS_CONTAINER:-albion-redis}"
INGEST_DIR="${INGEST_DIR:-/home/ubuntu/ingest}"
LOG_FILE="${LOG_FILE:-/var/log/redis-watchdog.log}"

log() {
  echo "$(date -Is) [$LOG_TAG] $*"
}

if ! docker inspect "$REDIS_CONTAINER" >/dev/null 2>&1; then
  log "Container $REDIS_CONTAINER not found — skipping"
  exit 0
fi

ROLE="$(docker exec "$REDIS_CONTAINER" redis-cli INFO replication 2>/dev/null | grep '^role:' | tr -d '\r' || true)"
if [[ "$ROLE" != "role:master" ]]; then
  log "Redis not master (${ROLE:-unknown}) — running REPLICAOF NO ONE"
  docker exec "$REDIS_CONTAINER" redis-cli REPLICAOF NO ONE
  sleep 2
fi

if docker exec "$REDIS_CONTAINER" redis-cli SET ingest:watchdog:ping 1 EX 60 >/dev/null 2>&1; then
  exit 0
fi

log "Redis write check failed — restarting ingest PM2 apps"
if [[ -d "$INGEST_DIR" ]]; then
  if (cd "$INGEST_DIR" && npm run pm2:restart >>"$LOG_FILE" 2>&1); then
    log "pm2:restart completed"
  else
    log "pm2:restart failed — see $LOG_FILE"
    exit 1
  fi
else
  log "INGEST_DIR $INGEST_DIR not found"
  exit 1
fi
