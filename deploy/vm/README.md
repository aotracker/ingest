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
| `ingest-api` | `tsx src/server.ts` | HTTP API on `INGEST_API_PORT` (default `3001`) — queue status, job triggers for Vercel |
| `ingest-scheduler` | `tsx src/worker.ts scheduler` | Repeatable jobs only: 25m ingest poll, ~45s live events, 5m health, 5m Discord catch-up |
| `ingest-worker` | `tsx src/worker.ts process` | Processors for `ingest`, `refresh`, and `discord` queues |
| `discord-bot` | `tsx src/discord/start.ts` | Discord gateway + slash commands. **Only started when `DISCORD_ENABLED=1`** |
| `db-retain` | `tsx scripts/db-retain.ts` | Weekly retention (Sun 05:30 UTC): battle JSON eviction, kill compact, hour-stat purge. Do not `pm2 restart` the whole ecosystem — that runs retention immediately |

Per-app logs are in `logs/<name>-out.log` and `logs/<name>-error.log`. `pm2-logrotate` is installed by `pm2-setup.sh`.

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

This starts `ingest-worker-americas` and `ingest-worker-europe` (processors only, `JOBS_REGION` + `JOBS_REGION_ONLY=1`). The generic `ingest-worker` stays running so Asia jobs are still processed. You can also set `ENABLE_REGIONAL_WORKERS=1` in `.env` so `pm2-setup.sh` / `pm2:start` pick it up.

### Discord bot kill switch

The bot is off unless `DISCORD_ENABLED=1` in `/home/ubuntu/ingest/.env`.

```bash
# Immediate — disconnect gateway; ingest keeps running
pm2 stop discord-bot

# Durable — do not start bot, do not enqueue Discord posts, skip guild catch-up
# Set DISCORD_ENABLED=0 in .env, then:
cd /home/ubuntu/ingest
npm run pm2:startOrReload

# Re-enable
# Set DISCORD_ENABLED=1 in .env, then:
npm run pm2:startOrReload
```

Feeds stay in Postgres. Do not delete the Discord application. See [DEPLOY.md](../../../DEPLOY.md).

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
npm run pm2:startOrReload
npx pm2 save
```

`pm2:startOrReload` starts newly added apps (for example `ingest-scheduler`) and reloads existing ones. Avoid `npm run pm2:restart` unless you intend to run `db-retain` immediately.

### One-time cutover (combined worker → split)

Do **not** run `npx pm2 startOrReload ecosystem.config.cjs` by itself. That reloads `db-retain` (runs retention immediately) and fails if `logs/` is not writable or old PIDs are gone.

```bash
cd /home/ubuntu/ingest
git pull && npm ci
# Stop accidental eviction first if a previous reload started it
npx pm2 stop db-retain
sudo chown -R ubuntu:ubuntu logs
chmod u+rwx logs
bash deploy/vm/pm2-resync.sh
curl -s http://127.0.0.1:3001/health
```

`pm2-resync.sh` deletes dead runtime apps, starts `ingest-api` / `ingest-scheduler` / `ingest-worker` (and discord/regionals if enabled), deletes leftover `battle-evict`, and leaves `db-retain` **stopped** until Sun 05:30 UTC.

If `logs/` is owned by root (`EACCES: permission denied, open '.../logs/...'`), `chown` as above. The ecosystem falls back to `~/.pm2/logs` when `ingest/logs` is not writable.

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
| `npm run db:apply-battles-and-participants-idx` | Battles feed + player-analytics indexes |
| `npm run db:apply-guild-hour-stats` | Guild UTC-hour activity tables |
| `npm run db:apply-discord-bot` | Discord servers, feeds, and post-log tables |
| `npm run db:apply-kill-detail-eviction` | Kill `detail_evicted_at` + nullable `raw_payload`; drop unused `background_jobs` |
| `npm run db:apply-kill-victim-guild-columns` | Kill `victim_guild_name` / `victim_guild_albion_id` + backfill |
| `npm run db:apply-kill-participant-columns` | Participant `guild_albion_id` / alliance cols; drop unused `kill_items.participant_id` FK |
| `npm run db:backfill-kill-storage` | Optional: null redundant participant JSONB, slim event payloads (`--dry-run` first) |

Uses `DATABASE_URL` from `/home/ubuntu/ingest/.env` (localhost Postgres). Safe to re-run — all statements are idempotent.

After the first weekly `db-retain` run that actually compacts kills, run `VACUUM ANALYZE kill_events, kill_participants, kill_items;` inside the Postgres container. Do not use `VACUUM FULL` unless you can take a lock.

**Retention ops:** run only one `db-retain` at a time. Tune chunk size with `RETAIN_EVICT_CHUNK_SIZE` (default 25) and `RETAIN_COMPACT_BATCH_LIMIT` (default 500). For emergency manual compaction, use small batches (10–25 event IDs) with `WITH batch AS MATERIALIZED (...)`.

For **local dev**, use `npm run db:push` from `client/` against local Docker Postgres only.

## Vercel connection

Vercel (`client/`) talks to this VM two ways:

| Path | Service | Used by |
|------|---------|---------|
| VM **public IP** `:5432` | Postgres (TLS) | `DATABASE_URL` reads/writes |
| `https://queue.aotracker.net` | Ingest HTTP API | Job triggers + queue status |

The Node process still listens HTTP on `INGEST_API_PORT` (default `3001`). Production Vercel does **not** use `http://VM_IP:3001`; it uses `INGEST_API_URL=https://queue.aotracker.net`. That hostname is DNS-only today (not Cloudflare-proxied). Prefer a Cloudflare Tunnel to `127.0.0.1:3001` and close public `:3001` — see [DEPLOY.md](../../../DEPLOY.md) and [deploy/cloudflare/README.md](../../../deploy/cloudflare/README.md).

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
| VM watchdog cron | Every 2 min: promote Redis if needed; restart `ingest-api` / `ingest-scheduler` / `ingest-worker` (and optional bot/regionals) if writes still fail. Never restarts `db-retain`. |
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

# Restart ingest runtime after Redis is writable (not db-retain):
cd /home/ubuntu/ingest && npx pm2 restart ingest-api ingest-scheduler ingest-worker
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
| Logs | `npm run pm2:logs -- ingest-scheduler`, `npm run pm2:logs -- ingest-worker`, or `tail -f logs/ingest-scheduler-out.log` |
| Restart | `npm run pm2:startOrReload` (deploy). Do not `pm2:restart` the whole ecosystem (runs `db-retain`). |
| Deploy | `bash deploy/vm/pm2-deploy.sh` |
