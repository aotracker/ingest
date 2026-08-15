import type { Job } from "bullmq";
import { lte } from "drizzle-orm";
import type { AlbionRegion } from "@aotracker/core/albion/types";
import { db, schema } from "@aotracker/core/db";
import { getBattleByAlbionId } from "@aotracker/core/db/battle-cache";
import { BATTLE_API_DELAY_NOTICE_MS } from "./constants";
import {
  entityResolveDedupeKey,
  type EntityResolveType,
} from "../entity-resolve";
import {
  liveSearchDedupeKey,
  normalizeLiveSearchQuery,
  normalizeLiveSearchRegions,
  type LiveSearchResult,
} from "../live-search";
import { ALL_JOB_QUEUES, queueForJobQueue } from "./queues";
import { toLegacyJobState, type JobPayload } from "./types";

/** Successfully completed jobs older than this are omitted from the status UI. */
const COMPLETED_VISIBLE_MS = 3 * 60 * 60 * 1000;
const QUEUE_STATUS_MAX_ROWS = 5_000;
const API_REQUEST_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface BattleSyncJobInfo {
  state: string | null;
  lastError: string | null;
  createdAt: number | null;
  runAt: number | null;
  delayMs: number | null;
  notReadySince: number | null;
  notReadyDefers: number;
  waitingOnAlbionApi: boolean;
  apiWaitMs: number | null;
  showApiDelayNotice: boolean;
  detailUnavailable: boolean;
  detailUnavailableError: string | null;
}

function isNotReadyJobError(error: string | null | undefined): boolean {
  if (!error) return false;
  return (
    error.includes("Battle detail not ready") ||
    error.includes("Battle detail unavailable") ||
    error.includes("still has not published this battle") ||
    error.includes("below sync threshold") ||
    error.includes("circuit defers") ||
    /\bHTTP 404\b/.test(error)
  );
}

function battleSyncDedupeKey(region: string, battleId: number): string {
  return `sync-battle-${region}-${battleId}`;
}

export async function getBattleSyncJobInfo(
  region: string,
  battleId: number
): Promise<BattleSyncJobInfo> {
  const battleRow = await getBattleByAlbionId(region as AlbionRegion, battleId);
  const detailUnavailable = (battleRow?.detailSyncUnavailable ?? 0) === 1;
  const detailUnavailableError = battleRow?.detailSyncLastError ?? null;

  const dedupeKey = battleSyncDedupeKey(region, battleId);
  const queue = queueForJobQueue("refresh");
  const job = (await queue.getJob(dedupeKey)) as Job<JobPayload> | null;

  if (!job) {
    return {
      state: detailUnavailable ? "failed" : null,
      lastError: detailUnavailableError,
      createdAt: null,
      runAt: null,
      delayMs: null,
      notReadySince: null,
      notReadyDefers: 0,
      waitingOnAlbionApi: false,
      apiWaitMs: null,
      showApiDelayNotice: false,
      detailUnavailable,
      detailUnavailableError,
    };
  }

  const state = await job.getState();
  const payload = (job.data ?? {}) as JobPayload;
  const notReadyDefers = payload.notReadyDefers ?? 0;
  const notReadySince = payload.notReadySince ?? null;
  const lastError =
    (typeof job.failedReason === "string" ? job.failedReason : null) ??
    detailUnavailableError;
  const waitingOnAlbionApi =
    !detailUnavailable &&
    (notReadyDefers > 0 ||
      (lastError != null && isNotReadyJobError(lastError)));

  const createdAt = job.timestamp ?? Date.now();
  const anchorMs =
    notReadySince ?? (waitingOnAlbionApi ? createdAt : null);
  const apiWaitMs =
    anchorMs != null ? Math.max(0, Date.now() - anchorMs) : null;
  const showApiDelayNotice =
    waitingOnAlbionApi &&
    apiWaitMs != null &&
    apiWaitMs >= BATTLE_API_DELAY_NOTICE_MS &&
    state !== "failed";

  const delayedUntil =
    typeof job.timestamp === "number" && typeof job.delay === "number"
      ? job.timestamp + job.delay
      : null;
  const runAtMs = delayedUntil ?? job.processedOn ?? createdAt;
  const delayMs =
    state === "delayed" && delayedUntil != null && delayedUntil > Date.now()
      ? delayedUntil - Date.now()
      : null;

  return {
    state: detailUnavailable
      ? "failed"
      : toLegacyJobState(state, delayedUntil),
    lastError,
    createdAt,
    runAt: runAtMs,
    delayMs,
    notReadySince,
    notReadyDefers,
    waitingOnAlbionApi,
    apiWaitMs,
    showApiDelayNotice,
    detailUnavailable,
    detailUnavailableError,
  };
}

export interface QueueJobSummary {
  id: string;
  name: string;
  queue: string;
  state: "active" | "waiting" | "delayed" | "failed" | "completed";
  dbStatus: "pending" | "processing" | "failed" | "completed";
  data: Record<string, unknown>;
  timestamp: number | null;
  processedOn: number | null;
  completedOn: number | null;
  runAt: number | null;
  failedReason: string | null;
  delay: number | null;
}

export interface QueueStatusSnapshot {
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
  };
  jobs: QueueJobSummary[];
}

function summarizePayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const source = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    "region",
    "albionId",
    "guildId",
    "allianceId",
    "eventId",
    "battleId",
    "playerId",
    "feedId",
    "searchQuery",
    "entityType",
    "entityName",
  ]) {
    if (source[key] != null && source[key] !== "") {
      out[key] = source[key];
    }
  }
  return out;
}

function legacyStateFromBullJob(
  state: string,
  delayedUntil: number | null
): QueueJobSummary["state"] | null {
  const legacy = toLegacyJobState(state, delayedUntil);
  if (
    legacy === "active" ||
    legacy === "waiting" ||
    legacy === "delayed" ||
    legacy === "failed" ||
    legacy === "completed"
  ) {
    return legacy;
  }
  return null;
}

function mapDbStatus(
  state: string
): QueueJobSummary["dbStatus"] {
  if (state === "active") return "processing";
  if (state === "failed") return "failed";
  if (state === "completed") return "completed";
  return "pending";
}

async function purgeOldApiRequestLogs(): Promise<void> {
  const cutoff = new Date(Date.now() - API_REQUEST_LOG_RETENTION_MS);
  await db
    .delete(schema.apiRequestLogs)
    .where(lte(schema.apiRequestLogs.createdAt, cutoff));
}

async function purgeOldOpsEvents(): Promise<void> {
  const { purgeOldOpsEvents: purge } = await import(
    "@aotracker/core/ops/events"
  );
  await purge();
}

async function getMergedQueueSnapshot(): Promise<QueueStatusSnapshot> {
  await purgeOldApiRequestLogs().catch((err) => {
    console.warn("[jobs] api-request-log purge skipped:", err);
  });
  await purgeOldOpsEvents().catch((err) => {
    console.warn("[jobs] ops-events purge skipped:", err);
  });

  const counts = {
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  };
  const jobs: QueueJobSummary[] = [];
  const completedAfter = Date.now() - COMPLETED_VISIBLE_MS;

  for (const queueName of ALL_JOB_QUEUES) {
    const queue = queueForJobQueue(queueName);
    const queueCounts = await queue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
      "completed"
    );
    counts.waiting += queueCounts.waiting ?? 0;
    counts.active += queueCounts.active ?? 0;
    counts.delayed += queueCounts.delayed ?? 0;
    counts.failed += queueCounts.failed ?? 0;
    counts.completed += queueCounts.completed ?? 0;

    const rows = await queue.getJobs(
      ["waiting", "active", "delayed", "failed", "completed"],
      0,
      QUEUE_STATUS_MAX_ROWS
    );

    for (const job of rows) {
      const state = await job.getState();
      if (state === "completed" && job.finishedOn != null) {
        if (job.finishedOn < completedAfter) continue;
      }

      const delayedUntil =
        typeof job.timestamp === "number" && typeof job.delay === "number"
          ? job.timestamp + job.delay
          : null;
      const legacy = legacyStateFromBullJob(state, delayedUntil);
      if (!legacy) continue;

      jobs.push({
        id: job.id ?? job.name,
        name: job.name,
        queue: queueName,
        state: legacy,
        dbStatus: mapDbStatus(state),
        data: summarizePayload(job.data),
        timestamp: job.timestamp ?? null,
        processedOn: job.processedOn ?? null,
        completedOn: job.finishedOn ?? null,
        runAt: delayedUntil ?? job.processedOn ?? job.timestamp ?? null,
        failedReason:
          typeof job.failedReason === "string" ? job.failedReason : null,
        delay:
          state === "delayed" && delayedUntil != null && delayedUntil > Date.now()
            ? delayedUntil - Date.now()
            : null,
      });
    }
  }

  const order: Record<QueueJobSummary["state"], number> = {
    active: 0,
    waiting: 1,
    delayed: 2,
    failed: 3,
    completed: 4,
  };

  return {
    counts,
    jobs: jobs.sort((a, b) => {
      const stateDiff = order[a.state] - order[b.state];
      if (stateDiff !== 0) return stateDiff;
      return (b.timestamp ?? 0) - (a.timestamp ?? 0);
    }),
  };
}

export async function getQueueStatuses(): Promise<{
  queue: QueueStatusSnapshot | null;
  fetchedAt: string;
  error: string | null;
}> {
  try {
    const queue = await getMergedQueueSnapshot();
    return {
      queue,
      fetchedAt: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    return {
      queue: null,
      fetchedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : "Queue status unavailable",
    };
  }
}

export interface LiveSearchJobInfo {
  state: string | null;
  playersFound: number | null;
  guildsFound: number | null;
  regionsSearched: AlbionRegion[];
  lastError: string | null;
}

export async function getLiveSearchJobInfo(
  query: string,
  regions?: AlbionRegion[]
): Promise<LiveSearchJobInfo> {
  const trimmed = normalizeLiveSearchQuery(query);
  const searchRegions = normalizeLiveSearchRegions(regions);
  const empty: LiveSearchJobInfo = {
    state: null,
    playersFound: null,
    guildsFound: null,
    regionsSearched: searchRegions,
    lastError: null,
  };

  if (!trimmed) return empty;

  const dedupeKey = liveSearchDedupeKey(trimmed, searchRegions);
  const queue = queueForJobQueue("refresh");
  const job = (await queue.getJob(dedupeKey)) as Job<JobPayload> | null;

  if (!job) return empty;

  const state = await job.getState();
  const delayedUntil =
    typeof job.timestamp === "number" && typeof job.delay === "number"
      ? job.timestamp + job.delay
      : job.processedOn ?? null;
  const legacyState = toLegacyJobState(state, delayedUntil);
  const returnValue = job.returnvalue as LiveSearchResult | undefined;

  return {
    state: legacyState,
    playersFound:
      typeof returnValue?.playersFound === "number"
        ? returnValue.playersFound
        : null,
    guildsFound:
      typeof returnValue?.guildsFound === "number" ? returnValue.guildsFound : null,
    regionsSearched: returnValue?.regionsSearched ?? searchRegions,
    lastError:
      typeof job.failedReason === "string" ? job.failedReason : null,
  };
}

export interface EntityResolveJobInfo {
  state: string | null;
  albionId: string | null;
  lastError: string | null;
}

export async function getEntityResolveJobInfo(
  region: AlbionRegion,
  entityType: EntityResolveType,
  name: string
): Promise<EntityResolveJobInfo> {
  const dedupeKey = entityResolveDedupeKey(region, entityType, name.trim());
  const queue = queueForJobQueue("refresh");
  const job = (await queue.getJob(dedupeKey)) as Job<JobPayload> | null;

  if (!job) {
    return { state: null, albionId: null, lastError: null };
  }

  const state = await job.getState();
  const delayedUntil =
    typeof job.timestamp === "number" && typeof job.delay === "number"
      ? job.timestamp + job.delay
      : job.processedOn ?? null;
  const legacyState = toLegacyJobState(state, delayedUntil);
  const returnValue = job.returnvalue as { albionId?: string } | undefined;
  const albionId =
    typeof returnValue?.albionId === "string" ? returnValue.albionId : null;

  return {
    state: legacyState,
    albionId,
    lastError:
      typeof job.failedReason === "string" ? job.failedReason : null,
  };
}

export {
  ensurePlayerSyncQueued,
  ensureGuildSyncQueued,
  ensureAllianceRefreshQueued,
  ensureKillEventQueued,
  ensureBattleDetailQueued,
  ensureEntityResolveQueued,
  ensureLiveSearchQueued,
  getPlayerSyncJobState,
  getGuildSyncJobState,
  getAllianceRefreshJobState,
  getEntityResolveJobState,
  getLiveSearchJobState,
  getKillEventIngestJobState,
  getBattleSyncJobState,
  requeueBattleDetail,
  getJobStateByDedupeKey,
} from "./enqueue";
