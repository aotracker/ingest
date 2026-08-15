# Ingest — backend workers + HTTP API (OVH VM only)

**Do not deploy to Vercel.** This package runs BullMQ workers against Redis, exposes an HTTP API for job triggers, polls the Albion API, and runs VM maintenance jobs.

## Stack on the VM

Production OVH host: **8 vCPU / 24 GB RAM**. Postgres and Redis run in Docker (`/opt/albion-postgres/`). Default limits: Postgres **14 GB**, Redis **2 GB** — see [deploy/vm/README.md](./deploy/vm/README.md).

- **Redis** — BullMQ job queues (`ingest`, `refresh`, `scheduler`, `discord`), localhost only in production
- **Postgres** — app data (shared with Vercel `client/`)
- **This package** — workers + Express HTTP API on port 3001 (production Vercel calls `https://queue.aotracker.net`, not the raw port)

## Commands

| Command | What it does |
|---------|----------------|
| `npm run start` | HTTP API + scheduler + job processors (local dev) |
| `npm run worker` | Scheduler (ingest poll, live events, health, Discord catch-up) + job queues |
| `npm run api` | HTTP API for Vercel job triggers and queue status |
| `npm run worker:process` | Job processors (`ingest` + `refresh` + `discord`) |
| `npm run worker:scheduler` | Repeatable ingest/health/live-events jobs only |
| `npm run discord:bot` | Discord gateway + slash commands (`DISCORD_ENABLED=1`) |
| `npm run db:apply-discord-bot` | Discord servers/feeds/post-log tables |
| `npm run jobs:ingest` | One-off ingest poll |
| `npm run jobs:health` | One-off API health check |
| `npm run db:evict-battle-details` | Weekly battle JSON eviction |

## Setup on the VM

```bash
cd /home/ubuntu/ingest
git clone https://github.com/aotracker/ingest.git .
npm ci
cp .env.example .env   # DATABASE_URL, REDIS_URL, INGEST_API_SECRET
npm run start          # HTTP API + workers (local dev)
```

Production: use PM2 — see [deploy/vm/README.md](deploy/vm/README.md) and [DEPLOY.md](../DEPLOY.md).

## Relationship to `client/`

| | `client/` (Vercel) | `ingest/` (OVH VM) |
|--|-------------------|-------------------|
| Serves web UI | Yes | No |
| Triggers jobs | Via HTTPS (`INGEST_API_URL=https://queue.aotracker.net`) | Enqueues to Redis |
| Processes BullMQ jobs | No | Yes |
| Runs ingest poll / health loops | No | Yes |

`client/` talks to Postgres directly and calls the ingest HTTP API for jobs. BullMQ job code lives in `ingest/src/jobs/`. DB and Albion API helpers live in `ingest/src/lib/` (a local copy, independent of `client/`).
