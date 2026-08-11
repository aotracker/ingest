#!/usr/bin/env bash
# First-time PM2 setup for ingest on the OVH VM.
# Run from /home/ubuntu/ingest as the ubuntu user.
set -euo pipefail

INGEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$INGEST_ROOT"

echo "==> Checking prerequisites…"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "ERROR: Node.js 20+ required (found $(node --version))." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not running." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found. Copy .env.example and configure it first." >&2
  exit 1
fi

echo "==> Installing dependencies…"
npm ci

echo "==> Starting PM2 apps…"
npm run pm2:start

echo "==> Saving PM2 process list…"
npx pm2 save

if systemctl is-enabled pm2-ubuntu.service >/dev/null 2>&1; then
  echo "==> PM2 startup already configured (pm2-ubuntu.service)."
else
  echo ""
  echo "==> PM2 startup not yet configured. Run the command printed below (as root):"
  echo ""
  npx pm2 startup systemd -u ubuntu --hp /home/ubuntu
  echo ""
  echo "Then run: npx pm2 save"
fi

echo ""
echo "==> Done. Verify with:"
echo "    npm run pm2:status"
echo "    curl -s http://127.0.0.1:\${INGEST_API_PORT:-3001}/health"
