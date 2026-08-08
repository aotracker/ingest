# OVH VM — BullMQ workers + HTTP API

Workers and the ingest HTTP API run from **`ingest/`** using Redis + BullMQ. The Next.js app runs on **Vercel** from `client/` only and triggers jobs via HTTP (not Redis).

## Prerequisites on the VM

- Node.js 20+
- PostgreSQL (app data)
- Redis (BullMQ, localhost only)
- Repo cloned e.g. `/opt/aotracker`

```bash
cd /opt/aotracker
npm ci
cp ingest/.env.example ingest/.env
# Edit: DATABASE_URL, REDIS_URL, DISABLED_REGIONS, INGEST_API_SECRET
```

## systemd — main worker

```bash
cp /opt/aotracker/ingest/deploy/vm/albion-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now albion-worker
journalctl -u albion-worker -f
```

`albion-worker.service` runs scheduler (12m ingest poll, 5m health) plus continuous processors for `ingest` and `refresh` queues.

## systemd — ingest HTTP API

Vercel calls this API to enqueue jobs and read queue status.

```bash
cp /opt/aotracker/ingest/deploy/vm/albion-ingest-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now albion-ingest-api
journalctl -u albion-ingest-api -f
```

Set `INGEST_API_PORT` (default `3001`) and `INGEST_API_SECRET` in `ingest/.env`. Use the same secret as `INGEST_API_SECRET` on Vercel.

### Optional per-region processors

```bash
cp /opt/aotracker/ingest/deploy/vm/albion-worker-process@.service /etc/systemd/system/
systemctl enable --now albion-worker-process@americas albion-worker-process@europe
```

## Battle detail eviction (weekly)

```bash
cp /opt/aotracker/ingest/deploy/vm/albion-battle-evict.service /etc/systemd/system/
cp /opt/aotracker/ingest/deploy/vm/albion-battle-evict.timer /etc/systemd/system/
systemctl enable --now albion-battle-evict.timer
```

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

Postgres + Redis: `docker compose -f deploy/docker-compose.yml up -d` (from repo root)

Icon cache maintenance runs on the VM — see [deploy/vm/README.md](../../deploy/vm/README.md).
