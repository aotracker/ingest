# Migration: systemd → PM2

This runbook migrates ingest process management from application-level systemd units to PM2. Docker (Postgres + Redis) is unchanged. PM2 uses a single `pm2-ubuntu.service` systemd unit for boot persistence.

## Before you start

- SSH into the OVH VM as `ubuntu`
- Confirm ingest is currently running via systemd: `systemctl status albion-ingest-worker`
- Note whether per-region workers are enabled: `systemctl status 'albion-worker-process@*'`

## Cutover

```bash
# 1. Pull PM2 config
cd /home/ubuntu/ingest
git pull
npm ci

# 2. Stop old systemd units (prevents duplicate schedulers)
sudo systemctl stop albion-ingest-worker
sudo systemctl stop 'albion-worker-process@*' 2>/dev/null || true
sudo systemctl disable albion-ingest-worker albion-battle-evict.timer

# 3. Start PM2
bash deploy/vm/pm2-setup.sh

# 4. Configure boot persistence (run as ubuntu — PM2 prints the exact sudo command)
npx pm2 startup systemd -u ubuntu --hp /home/ubuntu
# Copy/paste the sudo command PM2 prints (it includes the path to node_modules/.bin/pm2)
npx pm2 save

# 5. Verify
npm run pm2:status
curl -s http://127.0.0.1:3001/health
npm run pm2:logs -- --lines 50
```

## Optional per-region workers

If you previously ran `albion-worker-process@americas` and `@europe`:

```bash
cd /home/ubuntu/ingest
ENABLE_REGIONAL_WORKERS=1 npm run pm2:start
npx pm2 save
```

Or add them individually:

```bash
npx pm2 start ecosystem.config.cjs --only ingest-worker-americas,ingest-worker-europe
npx pm2 save
```

## Clean up old units

After confirming PM2 is stable (wait at least one ingest poll cycle, ~12 min):

```bash
sudo rm -f /etc/systemd/system/albion-ingest-worker.service \
            /etc/systemd/system/albion-worker-process@.service \
            /etc/systemd/system/albion-battle-evict.service \
            /etc/systemd/system/albion-battle-evict.timer
sudo systemctl daemon-reload
```

## Rollback

```bash
npx pm2 kill
sudo systemctl enable --now albion-ingest-worker
sudo systemctl enable --now albion-battle-evict.timer
# If regional workers were in use:
# sudo systemctl enable --now albion-worker-process@americas albion-worker-process@europe
```

## Behavioral changes

| Before (systemd) | After (PM2) |
|------------------|-------------|
| Single unit runs `npm start` (API + worker via `start.ts`) | Separate `ingest-api`, `ingest-scheduler`, and `ingest-worker` apps |
| `journalctl -u albion-ingest-worker` | `npm run pm2:logs -- ingest-scheduler` / `ingest-worker` |
| `systemctl restart albion-ingest-worker` | `npm run pm2:startOrReload` or `bash deploy/vm/pm2-deploy.sh` |
| Weekly eviction timer with ±30m jitter | PM2 cron at Sun 05:30 UTC (no jitter) |

Legacy systemd unit files are kept in [`legacy/`](legacy/) for reference.
