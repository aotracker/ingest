#!/usr/bin/env bash
# Start or reload long-running ingest apps. Never touches battle-evict.
set -euo pipefail

INGEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$INGEST_ROOT"

LOG_DIR="$INGEST_ROOT/logs"
mkdir -p "$LOG_DIR"
if [[ ! -w "$LOG_DIR" ]]; then
  echo "==> $LOG_DIR is not writable — fixing ownership (needs sudo)…"
  sudo chown -R "$(id -u):$(id -g)" "$LOG_DIR"
fi

RUNTIME_NAMES="$(node deploy/vm/pm2-runtime-names.cjs)"
if [[ -z "$RUNTIME_NAMES" ]]; then
  echo "ERROR: no runtime PM2 apps found in ecosystem.config.cjs" >&2
  exit 1
fi

echo "==> startOrReload runtime apps: $RUNTIME_NAMES"
if ! npx pm2 startOrReload ecosystem.config.cjs --update-env --only "$RUNTIME_NAMES"; then
  echo "==> startOrReload failed (dirty process list) — falling back to resync"
  bash deploy/vm/pm2-resync.sh
  exit 0
fi

npx pm2 stop battle-evict >/dev/null 2>&1 || true
