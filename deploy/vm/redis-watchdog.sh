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

log "Redis write check failed — restarting ingest PM2 runtime apps"
if [[ ! -d "$INGEST_DIR" ]]; then
  log "INGEST_DIR $INGEST_DIR not found"
  exit 1
fi

# Never `pm2 restart ecosystem.config.cjs` — that also runs battle-evict.
runtime_apps=(
  ingest-api
  ingest-scheduler
  ingest-worker
  discord-bot
  ingest-worker-americas
  ingest-worker-europe
)
to_restart=()
for name in "${runtime_apps[@]}"; do
  if (cd "$INGEST_DIR" && npx pm2 describe "$name" >/dev/null 2>&1); then
    to_restart+=("$name")
  fi
done

if [[ ${#to_restart[@]} -eq 0 ]]; then
  log "No ingest PM2 runtime apps found"
  exit 1
fi

if (cd "$INGEST_DIR" && npx pm2 restart "${to_restart[@]}" >>"$LOG_FILE" 2>&1); then
  log "pm2 restart completed: ${to_restart[*]}"
else
  log "pm2 restart failed — see $LOG_FILE"
  exit 1
fi
