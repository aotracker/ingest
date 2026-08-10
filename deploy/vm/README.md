# OVH VM — BullMQ workers + HTTP API

Workers and the ingest HTTP API run from **`/home/ubuntu/ingest`** using Redis + BullMQ. The Next.js app runs on **Vercel** from `client/` only and triggers jobs via HTTP (not Redis).

## Prerequisites on the VM

- Ubuntu 24.04 LTS (default `ubuntu` user)
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

## systemd — main worker

```bash
sudo cp /home/ubuntu/ingest/deploy/vm/albion-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now albion-worker
journalctl -u albion-worker -f
```

`albion-worker.service` runs scheduler (12m ingest poll, 5m health) plus continuous processors for `ingest` and `refresh` queues.

## systemd — ingest HTTP API

Vercel calls this API to enqueue jobs and read queue status.

```bash
sudo cp /home/ubuntu/ingest/deploy/vm/albion-ingest-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now albion-ingest-api
journalctl -u albion-ingest-api -f
```

Set `INGEST_API_PORT` (default `3001`) and `INGEST_API_SECRET` in `/home/ubuntu/ingest/.env`. Use the same secret as `INGEST_API_SECRET` on Vercel.

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
sudo systemctl restart albion-worker albion-ingest-api
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
npm run worker    # BullMQ workers
npm run api       # HTTP API (separate terminal)
```

Postgres + Redis: `docker compose -f deploy/docker-compose.yml up -d` (from monorepo root on your dev machine)
