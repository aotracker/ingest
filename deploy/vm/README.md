# OVH VM — BullMQ workers + HTTP API

Workers and the ingest HTTP API run from **`/home/ubuntu/ingest`** using Redis + BullMQ, managed by **PM2**. The Next.js app runs on **Vercel** from `client/` only and triggers jobs via HTTP (not Redis).

## Prerequisites on the VM

- Ubuntu 24.04 LTS (default `ubuntu` user)
- **8 vCPU / 24 GB RAM** (production OVH ingest host)
- Node.js 20+
- PostgreSQL + Redis (Docker at `/opt/albion-postgres/`)
- Ingest repo cloned to `/home/ubuntu/ingest`

```bash
cd /home/ubuntu/ingest
git clone https://github.com/aotracker/ingest.git .
npm ci
cp .env.example .env
# Edit: DATABASE_URL, REDIS_URL, DISABLED_REGIONS, INGEST_API_SECRET, INGEST_API_PORT
```

## PM2 — ingest API + workers

PM2 runs the ingest HTTP API and BullMQ workers as separate managed processes via [`ecosystem.config.cjs`](../../ecosystem.config.cjs).

| PM2 app | Command | Purpose |
|---------|---------|---------|
| `ingest-api` | `npm run api` | HTTP API on `INGEST_API_PORT` (default `3001`) — queue status, job triggers for Vercel |
| `ingest-worker` | `npm run worker` | BullMQ scheduler (12m ingest poll, 5m health) + processors for `ingest` and `refresh` queues |
| `battle-evict` | `npm run db:evict-battle-details` | Weekly battle JSON eviction (Sun 05:30 UTC) |

### First-time setup

```bash
cd /home/ubuntu/ingest
bash deploy/vm/pm2-setup.sh
```

Then run `npx pm2 startup systemd -u ubuntu --hp /home/ubuntu` as **ubuntu** (not root), copy/paste the `sudo` command PM2 prints, and run `npx pm2 save`.

### Verify

```bash
npm run pm2:status
npm run pm2:logs
curl -s http://127.0.0.1:3001/health
```

Set `INGEST_API_PORT` and `INGEST_API_SECRET` in `/home/ubuntu/ingest/.env`. Use the same secret as `INGEST_API_SECRET` on Vercel.

### Optional per-region processors

Enable regional worker apps by setting `ENABLE_REGIONAL_WORKERS=1` when starting:

```bash
cd /home/ubuntu/ingest
ENABLE_REGIONAL_WORKERS=1 npm run pm2:start
npx pm2 save
```

This starts `ingest-worker-americas` and `ingest-worker-europe` (processors only, with `JOBS_REGION` set).

### Migrating from systemd

If the VM still uses the old systemd units, see [MIGRATION-SYSTEMD-TO-PM2.md](MIGRATION-SYSTEMD-TO-PM2.md). Legacy unit files are in [`legacy/`](legacy/).

## Deploy updates

```bash
cd /home/ubuntu/ingest
bash deploy/vm/pm2-deploy.sh
```

Or manually:

```bash
cd /home/ubuntu/ingest
git fetch origin && git reset --hard origin/main
npm ci
npm run db:apply-pending
npm run pm2:reload
npx pm2 save
```

If `ecosystem.config.cjs` changed, use `npm run pm2:restart` instead of `pm2:reload`.

## Schema migrations (production)

Production schema changes are applied from **ingest on this VM**, not from Vercel or the `client` repo.

Idempotent scripts live in `scripts/db/`. After pulling ingest changes that touch the database:

```bash
cd /home/ubuntu/ingest
npm run db:apply-pending
```

Or run individual scripts:

| Script | Purpose |
|--------|---------|
| `npm run db:apply-api-sync-health` | `api_sync_state` health columns |
| `npm run db:apply-alliance-battles` | Alliance battles cache columns |
| `npm run db:apply-kill-fame-idx` | Kill fame partial index |
| `npm run db:apply-battle-detail-unavailable` | Battle detail sync unavailable columns |
| `npm run db:apply-battle-detail-eviction` | Battle detail eviction column + index |
| `npm run db:apply-ops-events` | `ops_events` table |
| `npm run db:apply-api-request-log-details` | `api_request_logs.details` column |

Uses `DATABASE_URL` from `/home/ubuntu/ingest/.env` (localhost Postgres). Safe to re-run — all statements are idempotent.

For **local dev**, use `npm run db:push` from `client/` against local Docker Postgres only.

## Vercel connection

Vercel (`client/`) needs network access to this VM:

| Port | Service | Used by |
|------|---------|---------|
| 5432 | Postgres | Vercel reads/writes app data |
| 3001 | Ingest HTTP API | Vercel job triggers + queue status |

Set `DATABASE_URL`, `INGEST_API_URL`, and `INGEST_API_SECRET` on Vercel. Redis (6379) is localhost-only on the VM.

Full deployment guide: [DEPLOY.md](../../../DEPLOY.md).

## Local dev

```bash
cd ingest
cp .env.example .env
npm run start     # HTTP API + BullMQ workers (single terminal)
```

Or run separately: `npm run worker` and `npm run api`.

Postgres + Redis: `docker compose -f deploy/docker-compose.yml up -d` (from monorepo root on your dev machine)

## Redis `READONLY` / replica errors

If PM2 logs show `READONLY You can't write against a read only replica` or `master -> replica`:

BullMQ requires a **writable Redis master**. The local Docker Redis should never be a replica — this usually means the container restarted badly, hit memory pressure, or was manually misconfigured.

**Automatic recovery (after pulling latest ingest + VM scripts):**

| Layer | Behavior |
|-------|----------|
| Redis entrypoint | Runs `REPLICAOF NO ONE` on every container start |
| Docker healthcheck | Fails unless Redis is `role:master` and accepts writes |
| VM watchdog cron | Every 2 min: promote Redis if needed; `pm2:restart` if writes still fail |
| Ingest worker / API | Heartbeat every 60s; exit after 3 consecutive READONLY errors (PM2 restarts) |
| `GET /health` | Returns 503 when Redis is not writable |

Upgrade an existing VM without re-running full setup:

```bash
cd /home/ubuntu/ingest
git pull && npm ci
sudo npm run vm:install-redis-watchdog
```

**Manual recovery** (if auto-recovery has not been deployed yet):

```bash
cd /opt/albion-postgres
docker compose ps
docker logs albion-redis --tail 50

# Should show role:master
docker exec albion-redis redis-cli INFO replication | grep role

# If role:slave, promote this instance back to master:
docker exec albion-redis redis-cli REPLICAOF NO ONE

# Restart ingest after Redis is writable:
cd /home/ubuntu/ingest && npm run pm2:restart
```

Watchdog log: `/var/log/redis-watchdog.log`

To cap Redis memory (production template: **2 GB** container, **1800 MB** `maxmemory`), ensure `/opt/albion-postgres/docker-compose.yml` matches [docker-compose.prod.yml](./docker-compose.prod.yml):

`redis-server --appendonly yes --maxmemory 1800mb --maxmemory-policy noeviction` with `mem_limit: 2g` (via [redis-entrypoint.sh](./redis-entrypoint.sh))

| Script | Purpose |
|--------|---------|
| [install-redis-watchdog.sh](./install-redis-watchdog.sh) | One-shot VM upgrade: entrypoint, healthcheck, cron, PM2 restart |
| [redis-watchdog.sh](./redis-watchdog.sh) | Cron helper (installed to `/opt/albion-postgres/`) |
| [redis-entrypoint.sh](./redis-entrypoint.sh) | Redis container entrypoint (self-promote to master) |
| [docker-compose.prod.yml](./docker-compose.prod.yml) | Production Postgres + Redis compose template |

To **expand Redis** on the 24 GB VM, raise both `mem_limit` and `maxmemory` in `/opt/albion-postgres/docker-compose.yml`, then `docker compose up -d redis`. Example production values: `mem_limit: 2g`, `--maxmemory 1800mb`.

## Ops cheat sheet

| Task | Command |
|------|---------|
| Status | `npm run pm2:status` |
| Logs | `npm run pm2:logs` or `npm run pm2:logs -- ingest-api` |
| Restart | `npm run pm2:reload` (deploy) or `npm run pm2:restart` |
| Deploy | `bash deploy/vm/pm2-deploy.sh` |
