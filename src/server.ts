import express, { type Request, type Response, type NextFunction } from "express";
import type { AlbionRegion } from "@aotracker/core/albion/types";
import { isRegionEnabled } from "@aotracker/core/albion/types";
import {
  ensurePlayerSyncQueued,
  ensureGuildSyncQueued,
  ensureAllianceRefreshQueued,
  ensureKillEventQueued,
  ensureBattleDetailQueued,
  ensureEntityResolveQueued,
  ensureLiveSearchQueued,
  requeueBattleDetail,
  getPlayerSyncJobState,
  getGuildSyncJobState,
  getAllianceRefreshJobState,
  triggerSchedulerJob,
} from "./jobs/enqueue";
import {
  getBattleSyncJobInfo,
  getEntityResolveJobInfo,
  getLiveSearchJobInfo,
  getQueueStatuses,
} from "./jobs/status";
import { getWorkerConnectivity } from "./jobs/worker-connectivity";
import {
  assertRedisWritable,
  checkRedisWritable,
  startRedisHealthMonitor,
} from "./jobs/connection";
import { collectFullSystemInfo, pingRedis } from "./system-info";

const PORT = parseInt(process.env.INGEST_API_PORT ?? "3001", 10);

function getApiSecret(): string | null {
  const secret = process.env.INGEST_API_SECRET?.trim();
  return secret || null;
}

function verifyAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = getApiSecret();
  if (!secret) {
    if (process.env.NODE_ENV === "development") {
      next();
      return;
    }
    res.status(503).json({ error: "INGEST_API_SECRET is not configured" });
    return;
  }

  const auth = req.headers.authorization;
  if (auth === `Bearer ${secret}`) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

function parseRegion(value: unknown): AlbionRegion | null {
  if (typeof value !== "string" || !isRegionEnabled(value)) return null;
  return value as AlbionRegion;
}

function parseEntityType(
  value: unknown
): "player" | "guild" | null {
  if (value === "player" || value === "guild") return value;
  return null;
}

function parseRegions(value: unknown): AlbionRegion[] | null {
  if (Array.isArray(value)) {
    const regions = value.filter(
      (item): item is AlbionRegion =>
        typeof item === "string" && isRegionEnabled(item)
    );
    return regions.length > 0 ? regions : null;
  }
  if (typeof value === "string" && value.trim()) {
    const regions = value
      .split(",")
      .map((part) => part.trim())
      .filter((part): part is AlbionRegion => isRegionEnabled(part));
    return regions.length > 0 ? regions : null;
  }
  return null;
}

const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  const redis = await checkRedisWritable();
  if (!redis.ok) {
    res.status(503).json({
      ok: false,
      redis,
      error: redis.error ?? "Redis is not writable",
    });
    return;
  }
  res.json({ ok: true, redis });
});

app.use(verifyAuth);

app.post("/jobs/player-sync", async (req, res) => {
  const region = parseRegion(req.body?.region);
  const playerId = req.body?.playerId ?? req.body?.albionId;
  if (!region || typeof playerId !== "string" || !playerId) {
    res.status(400).json({ error: "region and playerId are required" });
    return;
  }
  await ensurePlayerSyncQueued(region, playerId, {
    immediate: req.body?.immediate === true,
  });
  res.json({ ok: true });
});

app.post("/jobs/guild-sync", async (req, res) => {
  const region = parseRegion(req.body?.region);
  const guildId = req.body?.guildId;
  if (!region || typeof guildId !== "string" || !guildId) {
    res.status(400).json({ error: "region and guildId are required" });
    return;
  }
  await ensureGuildSyncQueued(region, guildId, {
    immediate: req.body?.immediate === true,
    force: req.body?.force === true,
  });
  res.json({ ok: true });
});

app.post("/jobs/alliance-refresh", async (req, res) => {
  const region = parseRegion(req.body?.region);
  const allianceId = req.body?.allianceId;
  if (!region || typeof allianceId !== "string" || !allianceId) {
    res.status(400).json({ error: "region and allianceId are required" });
    return;
  }
  await ensureAllianceRefreshQueued(region, allianceId, {
    immediate: req.body?.immediate === true,
  });
  res.json({ ok: true });
});

app.post("/jobs/kill-event", async (req, res) => {
  const region = parseRegion(req.body?.region);
  const eventId = req.body?.eventId;
  if (!region || typeof eventId !== "number" || Number.isNaN(eventId)) {
    res.status(400).json({ error: "region and eventId are required" });
    return;
  }
  await ensureKillEventQueued(region, eventId);
  res.json({ ok: true });
});

app.post("/jobs/battle-sync", async (req, res) => {
  const region = parseRegion(req.body?.region);
  const battleId = req.body?.battleId;
  if (!region || typeof battleId !== "number" || Number.isNaN(battleId)) {
    res.status(400).json({ error: "region and battleId are required" });
    return;
  }
  if (req.body?.requeue === true) {
    await requeueBattleDetail(region, battleId);
  } else {
    await ensureBattleDetailQueued(region, battleId, {
      immediate: req.body?.immediate === true,
      force: req.body?.force === true,
    });
  }
  res.json({ ok: true });
});

app.post("/jobs/live-search", async (req, res) => {
  const query = req.body?.query ?? req.body?.q ?? req.body?.searchQuery;
  const regions = parseRegions(req.body?.regions ?? req.body?.searchRegions);
  if (typeof query !== "string" || !query.trim()) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  await ensureLiveSearchQueued(query, regions ?? undefined, {
    immediate: req.body?.immediate === true,
  });
  res.json({ ok: true });
});

app.get("/jobs/live-search/state", async (req, res) => {
  const query = req.query.q ?? req.query.query;
  const regions = parseRegions(req.query.regions);
  if (typeof query !== "string" || !query.trim()) {
    res.status(400).json({ error: "q is required" });
    return;
  }
  const info = await getLiveSearchJobInfo(query, regions ?? undefined);
  res.json(info);
});

app.post("/jobs/entity-resolve", async (req, res) => {
  const region = parseRegion(req.body?.region);
  const entityType = parseEntityType(req.body?.type ?? req.body?.entityType);
  const name = req.body?.name ?? req.body?.entityName;
  if (!region || !entityType || typeof name !== "string" || !name.trim()) {
    res.status(400).json({
      error: "region, type (player|guild), and name are required",
    });
    return;
  }
  await ensureEntityResolveQueued(region, entityType, name, {
    immediate: req.body?.immediate === true,
  });
  res.json({ ok: true });
});

app.post("/jobs/scheduler/ingest-poll", async (_req, res) => {
  const jobId = await triggerSchedulerJob("ingest-poll");
  res.json({ ok: true, jobId });
});

app.post("/jobs/scheduler/health-check", async (_req, res) => {
  const jobId = await triggerSchedulerJob("health-check");
  res.json({ ok: true, jobId });
});

app.get("/jobs/battle-sync/:region/:battleId", async (req, res) => {
  const region = parseRegion(req.params.region);
  const battleId = parseInt(req.params.battleId, 10);
  if (!region || Number.isNaN(battleId)) {
    res.status(400).json({ error: "Invalid region or battleId" });
    return;
  }
  const info = await getBattleSyncJobInfo(region, battleId);
  res.json(info);
});

app.get("/jobs/player-sync/:region/:playerId/state", async (req, res) => {
  const region = parseRegion(req.params.region);
  const playerId = req.params.playerId;
  if (!region || !playerId) {
    res.status(400).json({ error: "Invalid region or playerId" });
    return;
  }
  const state = await getPlayerSyncJobState(region, playerId);
  res.json({ state });
});

app.get("/jobs/guild-sync/:region/:guildId/state", async (req, res) => {
  const region = parseRegion(req.params.region);
  const guildId = req.params.guildId;
  if (!region || !guildId) {
    res.status(400).json({ error: "Invalid region or guildId" });
    return;
  }
  const state = await getGuildSyncJobState(region, guildId);
  res.json({ state });
});

app.get("/jobs/alliance-refresh/:region/:allianceId/state", async (req, res) => {
  const region = parseRegion(req.params.region);
  const allianceId = req.params.allianceId;
  if (!region || !allianceId) {
    res.status(400).json({ error: "Invalid region or allianceId" });
    return;
  }
  const state = await getAllianceRefreshJobState(region, allianceId);
  res.json({ state });
});

app.get(
  "/jobs/entity-resolve/:region/:type/:name/state",
  async (req, res) => {
    const region = parseRegion(req.params.region);
    const entityType = parseEntityType(req.params.type);
    const name = decodeURIComponent(req.params.name ?? "");
    if (!region || !entityType || !name.trim()) {
      res.status(400).json({ error: "Invalid region, type, or name" });
      return;
    }
    const info = await getEntityResolveJobInfo(region, entityType, name);
    res.json(info);
  }
);

app.get("/jobs/queues", async (_req, res) => {
  const snapshot = await getQueueStatuses();
  res.json(snapshot);
});

app.get("/jobs/workers", async (_req, res) => {
  const connectivity = await getWorkerConnectivity();
  res.json(connectivity);
});

app.get("/system", async (_req, res) => {
  const [runtime, redis] = await Promise.all([
    collectFullSystemInfo(),
    pingRedis(),
  ]);
  res.json({
    fetchedAt: new Date().toISOString(),
    runtime,
    redis,
  });
});

async function start(): Promise<void> {
  await assertRedisWritable();
  startRedisHealthMonitor();
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[ingest-api] Listening on 0.0.0.0:${PORT}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[ingest-api] Port ${PORT} is already in use. Stop the other ingest API or set INGEST_API_PORT.`
      );
    } else {
      console.error("[ingest-api] Failed to start:", err);
    }
    process.exit(1);
  });
}

start().catch((err) => {
  console.error("[ingest-api] Startup failed:", err);
  process.exit(1);
});
