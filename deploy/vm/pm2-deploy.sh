#!/usr/bin/env bash
# Routine ingest deploy on the OVH VM.
# Run from /home/ubuntu/ingest as the ubuntu user.
set -euo pipefail

INGEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$INGEST_ROOT"

echo "==> Pulling latest changes…"
git fetch origin
git reset --hard origin/main

echo "==> Installing dependencies…"
npm ci

echo "==> Applying pending schema migrations…"
npm run db:apply-pending

echo "==> Reloading PM2 apps (starts missing apps such as ingest-scheduler)…"
npm run pm2:startOrReload

echo "==> Saving PM2 process list…"
npx pm2 save

echo ""
echo "==> Deploy complete. Verify with:"
echo "    npm run pm2:status"
echo "    npm run pm2:logs -- --lines 50"
