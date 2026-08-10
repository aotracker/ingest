# OVH VM — BullMQ workers + HTTP API

Workers and the ingest HTTP API run from **`/home/ubuntu/ingest`** using Redis + BullMQ. The Next.js app runs on **Vercel** from `client/` only and triggers jobs via HTTP (not Redis).

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

## systemd — ingest API + workers

Runs the ingest HTTP API (Vercel job triggers) and BullMQ workers (scheduler + processors) in one process via `npm start`.

```bash
sudo cp /home/ubuntu/ingest/deploy/vm/albion-ingest-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now albion-ingest-worker
journalctl -u albion-ingest-worker -f
```

`albion-ingest-worker.service` runs `scripts/start.ts`, which launches:
- **HTTP API** on `INGEST_API_PORT` (default `3001`) — queue status, job triggers for Vercel
- **BullMQ workers** — scheduler (12m ingest poll, 5m health) plus continuous processors for `ingest` and `refresh` queues

Set `INGEST_API_PORT` and `INGEST_API_SECRET` in `/home/ubuntu/ingest/.env`. Use the same secret as `INGEST_API_SECRET` on Vercel.

### Migrating from separate `albion-worker` + `albion-ingest-api` services

If the VM still has the old units:

```bash
sudo systemctl disable --now albion-ingest-api albion-worker
sudo rm -f /etc/systemd/system/albion-ingest-api.service /etc/systemd/system/albion-worker.service
sudo cp /home/ubuntu/ingest/deploy/vm/albion-ingest-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now albion-ingest-worker
```

### Optional per-region processors

```bash
sudo cp /home/ubuntu/ingest/deploy/vm/albion-worker-process@.service /etc/systemd/system/
sudo systemctl enable --now albion-worker-process@americas albion-worker-process@europe
```

## Battle detail eviction (weekly)

```bash
sudo cp /home/ubuntu/ingest/deploy/vm/albion-battle-evict.service /etc/systemd/system/
sudo cp /home/ubuntu/ingest/deploy/vm/albion-battle-evict.timer /etc/systemd/system/
sudo systemctl enable --now albion-battle-evict.timer
```

## Deploy updates

```bash
cd /home/ubuntu/ingest
git fetch origin && git reset --hard origin/main
npm ci
npm run db:apply-pending
sudo systemctl restart albion-ingest-worker
```

If systemd unit files changed, re-copy from `deploy/vm/` and `sudo systemctl daemon-reload`.

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
npm run start     # HTTP API + BullMQ workers (same as production VM)
```

Or run separately: `npm run worker` and `npm run api`.

Postgres + Redis: `docker compose -f deploy/docker-compose.yml up -d` (from monorepo root on your dev machine)

## Redis `READONLY` / replica errors

If journal logs show `READONLY You can't write against a read only replica` or `master -> replica`:

BullMQ requires a **writable Redis master**. The local Docker Redis should never be a replica — this usually means the container restarted badly, hit memory pressure, or was manually misconfigured.

```bash
cd /opt/albion-postgres
docker compose ps
docker logs albion-redis --tail 50

# Should show role:master
docker exec albion-redis redis-cli INFO replication | grep role

# If role:slave, promote this instance back to master:
docker exec albion-redis redis-cli REPLICAOF NO ONE

# Restart ingest after Redis is writable:
sudo systemctl restart albion-ingest-worker
```

To cap Redis memory (production template: **2 GB** container, **1800 MB** `maxmemory`), ensure `/opt/albion-postgres/docker-compose.yml` matches [docker-compose.prod.yml](../../../deploy/vm/docker-compose.prod.yml):

`redis-server --appendonly yes --maxmemory 1800mb --maxmemory-policy noeviction` with `mem_limit: 2g`

To **expand Redis** on the 24 GB VM, raise both `mem_limit` and `maxmemory` in `/opt/albion-postgres/docker-compose.yml`, then `docker compose up -d redis`. Example production values: `mem_limit: 2g`, `--maxmemory 1800mb`.
