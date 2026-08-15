#!/usr/bin/env bash
# Recover a dirty PM2 list and start runtime apps only (never battle-evict).
# Run from /home/ubuntu/ingest as ubuntu.
set -euo pipefail

INGEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$INGEST_ROOT"

LOG_DIR="$INGEST_ROOT/logs"
mkdir -p "$LOG_DIR"

if [[ ! -w "$LOG_DIR" ]]; then
  echo "==> $LOG_DIR is not writable — fixing ownership (needs sudo)…"
  sudo chown -R "$(id -u):$(id -g)" "$LOG_DIR"
fi
chmod u+rwx "$LOG_DIR" 2>/dev/null || true

echo "==> Stopping battle-evict if it was started by a reload…"
npx pm2 stop battle-evict >/dev/null 2>&1 || true

RUNTIME_NAMES="$(node deploy/vm/pm2-runtime-names.cjs)"
if [[ -z "$RUNTIME_NAMES" ]]; then
  echo "ERROR: no runtime PM2 apps found in ecosystem.config.cjs" >&2
  exit 1
fi

echo "==> Replacing runtime apps: $RUNTIME_NAMES"
IFS=',' read -r -a runtime_apps <<< "$RUNTIME_NAMES"
for name in "${runtime_apps[@]}"; do
  npx pm2 delete "$name" >/dev/null 2>&1 || true
done

npx pm2 start ecosystem.config.cjs --only "$RUNTIME_NAMES" --update-env

if ! npx pm2 describe battle-evict >/dev/null 2>&1; then
  echo "==> Registering battle-evict cron (then stopping so it does not run now)…"
  npx pm2 start ecosystem.config.cjs --only battle-evict
fi
npx pm2 stop battle-evict >/dev/null 2>&1 || true

npx pm2 save
npx pm2 status

echo ""
echo "==> Done. Verify:"
echo "    curl -s http://127.0.0.1:\${INGEST_API_PORT:-3001}/health"
echo "    npx pm2 logs ingest-scheduler --lines 30"
echo "    battle-evict should be 'stopped' until Sun 05:30 UTC"
