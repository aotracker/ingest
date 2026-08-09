# Ingest — backend workers + HTTP API (OVH VM only)

**Do not deploy to Vercel.** This package runs BullMQ workers against Redis, exposes an HTTP API for job triggers, polls the Albion API, and runs VM maintenance jobs.

## Stack on the VM

- **Redis** — BullMQ job queues (`ingest`, `refresh`, `scheduler`), localhost only in production
- **Postgres** — app data (shared with Vercel `client/`)
- **This package** — workers + Express HTTP API on port 3001

## Commands

| Command | What it does |
|---------|----------------|
| `npm run start` | HTTP API + scheduler + job processors (local dev) |
| `npm run worker` | Scheduler (ingest poll + health) + both job queues |
| `npm run api` | HTTP API for Vercel job triggers and queue status |
| `npm run worker:process` | Job processors only (`ingest` + `refresh`) |
| `npm run worker:scheduler` | Repeatable ingest/health jobs only |
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

Production: use systemd — see [deploy/vm/README.md](deploy/vm/README.md) and [DEPLOY.md](../DEPLOY.md).

## Relationship to `client/`

| | `client/` (Vercel) | `ingest/` (OVH VM) |
|--|-------------------|-------------------|
| Serves web UI | Yes | No |
| Triggers jobs | Via HTTP (`INGEST_API_URL`) | Enqueues to Redis |
| Processes BullMQ jobs | No | Yes |
| Runs ingest poll / health loops | No | Yes |

`client/` talks to Postgres directly and calls the ingest HTTP API for jobs. BullMQ job code lives in `ingest/src/jobs/`. DB and Albion API helpers live in `ingest/src/lib/` (a local copy, independent of `client/`).
