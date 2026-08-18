import type { Job } from "bullmq";
import { and, eq } from "drizzle-orm";
import type { AlbionRegion } from "@aotracker/core/albion/types";
import { isRegionEnabled } from "@aotracker/core/albion/types";
import { db, schema } from "@aotracker/core/db";
import {
  battleMeetsDetailSyncThreshold,
  BATTLE_BELOW_SYNC_THRESHOLD_ERROR,
  clearBattleDetailUnavailable,
  getBattleByAlbionId,
  isBattleDetailSyncUnavailable,
  markBattleDetailUnavailable,
} from "@aotracker/core/db/battle-cache";
import {
  BATTLE_DETAIL_SYNC_DELAY_MS,
  JOB_PRIORITY_DEFAULT,
  JOB_PRIORITY_PROMOTED,
  MAX_USER_PROMOTE_REMAINING_MS,
  WARM_SYNC_DELAY_MS,
} from "./constants";
import { isNotReadyJobError } from "./errors";
import { getSchedulerQueue, queueForJobQueue } from "./queues";
import {
  QUEUE_NAMES,
  toLegacyJobState,
  type EnqueueJobInput,
  type JobPayload,
} from "./types";
import {
  entityResolveDedupeKey,
  type EntityResolveType,
} from "../entity-resolve";
import {
  liveSearchDedupeKey,
  normalizeLiveSearchQuery,
  normalizeLiveSearchRegions,
} from "../live-search";

export async function enqueueJob(input: EnqueueJobInput): Promise<void> {
  const queue = queueForJobQueue(input.queue);
  const delayMs = input.delayMs ?? 0;
  const payload = input.payload ?? {};
  const priority =
    input.priority ??
    (payload.userPromoted === true
      ? JOB_PRIORITY_PROMOTED
      : JOB_PRIORITY_DEFAULT);

  const existing = await queue.getJob(input.dedupeKey);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove();
    }
  }

  try {
    await queue.add(input.name, payload, {
      jobId: input.dedupeKey,
      delay: delayMs > 0 ? delayMs : undefined,
      priority,
      attempts: input.maxAttempts ?? 3,
      backoff: { type: "exponential", delay: 15_000 },
    });
  } catch (err) {
    // BullMQ rejects duplicate jobId while an active copy exists — expected dedupe.
    if (
      err instanceof Error &&
      (err.message.includes("Job") && err.message.includes("exists"))
    ) {
      return;
    }
    throw err;
  }
}

async function getJobByDedupeKey(
  dedupeKey: string
): Promise<Job<JobPayload> | null> {
  for (const queueName of [
    QUEUE_NAMES.REFRESH,
    QUEUE_NAMES.INGEST,
    QUEUE_NAMES.DISCORD,
  ]) {
    const queue = queueForJobQueue(queueName);
    const job = await queue.getJob(dedupeKey);
    if (job) return job as Job<JobPayload>;
  }
  return null;
}

export async function getJobStateByDedupeKey(
  dedupeKey: string
): Promise<string | null> {
  const job = await getJobByDedupeKey(dedupeKey);
  if (!job) return null;
  const state = await job.getState();
  if (state === "completed" || state === "failed") {
    return state;
  }
  const delayedUntil =
    typeof job.timestamp === "number" && typeof job.delay === "number"
      ? job.timestamp + job.delay
      : job.processedOn ?? null;
  return toLegacyJobState(state, delayedUntil);
}

function isInProgressState(state: string | null | undefined): boolean {
  return state === "waiting" || state === "delayed" || state === "active";
}

async function promotePendingJob(dedupeKey: string): Promise<boolean> {
  const job = await getJobByDedupeKey(dedupeKey);
  if (!job) return false;

  const state = await job.getState();
  if (state !== "waiting" && state !== "delayed" && state !== "prioritized") {
    return false;
  }

  const delayedUntil =
    typeof job.timestamp === "number" && typeof job.delay === "number"
      ? job.timestamp + job.delay
      : Date.now();
  const remainingMs = delayedUntil - Date.now();
  if (remainingMs > MAX_USER_PROMOTE_REMAINING_MS) return false;

  const prior = (job.data ?? {}) as JobPayload;
  if (prior.userPromoted === true && remainingMs <= 0) return true;

  await job.updateData({ ...prior, userPromoted: true });
  await job.changePriority({ priority: JOB_PRIORITY_PROMOTED });
  if (state === "delayed") {
    await job.promote();
  }
  return true;
}

async function promotePendingJobs(dedupeKeys: string[]): Promise<void> {
  for (const key of dedupeKeys) {
    await promotePendingJob(key);
  }
}

async function anyJobInProgress(dedupeKeys: string[]): Promise<boolean> {
  for (const key of dedupeKeys) {
    if (isInProgressState(await getJobStateByDedupeKey(key))) return true;
  }
  return false;
}

async function getPreferredJobState(dedupeKeys: string[]): Promise<string | null> {
  let fallback: string | null = null;
  for (const key of dedupeKeys) {
    const state = await getJobStateByDedupeKey(key);
    if (!state) continue;
    if (isInProgressState(state)) return state;
    if (!fallback) fallback = state;
  }
  return fallback;
}

function playerSyncDedupeKeys(region: AlbionRegion, albionId: string): string[] {
  return [
    `sync-player-${region}-${albionId}`,
    `refresh-${region}-${albionId}`,
    `backfill-player-history-${region}-${albionId}`,
  ];
}

function guildSyncDedupeKeys(region: AlbionRegion, guildId: string): string[] {
  return [
    `sync-guild-${region}-${guildId}`,
    `refresh-guild-${region}-${guildId}`,
    `backfill-guild-top-kills-${region}-${guildId}`,
  ];
}

const LIVE_SEARCH_MIN_QUERY_LENGTH = 2;

export async function ensureLiveSearchQueued(
  query: string,
  regions?: AlbionRegion[],
  options?: { immediate?: boolean }
): Promise<void> {
  const trimmed = normalizeLiveSearchQuery(query);
  if (trimmed.length < LIVE_SEARCH_MIN_QUERY_LENGTH) return;

  const searchRegions = normalizeLiveSearchRegions(regions);
  if (searchRegions.length === 0) return;

  const dedupeKey = liveSearchDedupeKey(trimmed, searchRegions);
  const immediate = options?.immediate === true;
  const existingState = await getJobStateByDedupeKey(dedupeKey);

  if (isInProgressState(existingState)) {
    if (immediate) await promotePendingJob(dedupeKey);
    return;
  }

  if (existingState === "completed") {
    return;
  }

  await enqueueJob({
    dedupeKey,
    queue: QUEUE_NAMES.REFRESH,
    name: "live-search",
    payload: {
      searchQuery: trimmed,
      searchRegions,
      ...(immediate ? { userPromoted: true } : {}),
    },
    delayMs: immediate ? 0 : WARM_SYNC_DELAY_MS,
  });
}

export async function getLiveSearchJobState(
  query: string,
  regions?: AlbionRegion[]
): Promise<string | null> {
  const trimmed = normalizeLiveSearchQuery(query);
  if (!trimmed) return null;
  return getJobStateByDedupeKey(
    liveSearchDedupeKey(trimmed, normalizeLiveSearchRegions(regions))
  );
}

export async function ensureEntityResolveQueued(
  region: AlbionRegion,
  entityType: EntityResolveType,
  name: string,
  options?: { immediate?: boolean }
): Promise<void> {
  if (!isRegionEnabled(region)) return;
  const trimmed = name.trim();
  if (!trimmed) return;

  const dedupeKey = entityResolveDedupeKey(region, entityType, trimmed);
  const immediate = options?.immediate === true;
  if (isInProgressState(await getJobStateByDedupeKey(dedupeKey))) {
    if (immediate) await promotePendingJob(dedupeKey);
    return;
  }

  await enqueueJob({
    dedupeKey,
    queue: QUEUE_NAMES.REFRESH,
    name: "entity-resolve",
    payload: {
      region,
      entityType,
      entityName: trimmed,
      ...(immediate ? { userPromoted: true } : {}),
    },
    delayMs: immediate ? 0 : WARM_SYNC_DELAY_MS,
  });
}

export async function ensurePlayerSyncQueued(
  region: AlbionRegion,
  albionId: string,
  options?: { immediate?: boolean }
): Promise<void> {
  if (!isRegionEnabled(region)) return;
  const keys = playerSyncDedupeKeys(region, albionId);
  const immediate = options?.immediate === true;
  if (await anyJobInProgress(keys)) {
    if (immediate) await promotePendingJobs(keys);
    return;
  }
  await enqueueJob({
    dedupeKey: keys[0],
    queue: QUEUE_NAMES.REFRESH,
    name: "sync-player",
    payload: {
      region,
      albionId,
      ...(immediate ? { userPromoted: true } : {}),
    },
    delayMs: immediate ? 0 : WARM_SYNC_DELAY_MS,
  });
}

export async function ensureGuildSyncQueued(
  region: AlbionRegion,
  guildId: string,
  options?: { immediate?: boolean; force?: boolean }
): Promise<void> {
  if (!isRegionEnabled(region)) return;
  const keys = guildSyncDedupeKeys(region, guildId);
  const immediate = options?.immediate === true;
  if (await anyJobInProgress(keys)) {
    if (immediate) await promotePendingJobs(keys);
    return;
  }
  await enqueueJob({
    dedupeKey: keys[0],
    queue: QUEUE_NAMES.REFRESH,
    name: "sync-guild",
    payload: {
      region,
      guildId,
      ...(options?.force ? { force: true } : {}),
      ...(immediate ? { userPromoted: true } : {}),
    },
    delayMs: immediate ? 0 : WARM_SYNC_DELAY_MS,
  });
}

export async function ensureAllianceRefreshQueued(
  region: AlbionRegion,
  allianceId: string,
  options?: { immediate?: boolean }
): Promise<void> {
  if (!isRegionEnabled(region)) return;
  const dedupeKey = `refresh-alliance-${region}-${allianceId}`;
  const immediate = options?.immediate === true;
  if (isInProgressState(await getJobStateByDedupeKey(dedupeKey))) {
    if (immediate) await promotePendingJob(dedupeKey);
    return;
  }
  await enqueueJob({
    dedupeKey,
    queue: QUEUE_NAMES.REFRESH,
    name: "refresh-alliance",
    payload: {
      region,
      allianceId,
      ...(immediate ? { userPromoted: true } : {}),
    },
    delayMs: immediate ? 0 : WARM_SYNC_DELAY_MS,
  });
}

export async function ensureKillEventQueued(
  region: AlbionRegion,
  eventId: number
): Promise<void> {
  if (!isRegionEnabled(region)) return;
  const dedupeKey = `ingest-event-${region}-${eventId}`;
  if (isInProgressState(await getJobStateByDedupeKey(dedupeKey))) return;
  await enqueueJob({
    dedupeKey,
    queue: QUEUE_NAMES.INGEST,
    name: "ingest-event",
    payload: { region, eventId },
    delayMs: 0,
  });
}

function battleSyncDedupeKey(region: AlbionRegion, battleId: number): string {
  return `sync-battle-${region}-${battleId}`;
}

async function battleAlreadyHasDetail(
  region: AlbionRegion,
  battleId: number
): Promise<boolean> {
  const row = await db.query.battles.findFirst({
    where: and(
      eq(schema.battles.albionBattleId, battleId),
      eq(schema.battles.region, region)
    ),
    columns: {
      totalFame: true,
      detailPayload: true,
    },
  });
  return row?.totalFame != null && row.detailPayload != null;
}

export async function ensureBattleDetailQueued(
  region: AlbionRegion,
  battleId: number,
  options?: { immediate?: boolean; force?: boolean }
): Promise<void> {
  if (!isRegionEnabled(region)) return;
  if (await battleAlreadyHasDetail(region, battleId)) return;

  const force = options?.force === true;
  const known = await getBattleByAlbionId(region, battleId);
  const wasEvicted = known?.detailEvictedAt != null;
  const allowRetry = force || wasEvicted;

  if (wasEvicted) {
    await clearBattleDetailUnavailable(region, battleId).catch(() => undefined);
  }

  if (!allowRetry && (await isBattleDetailSyncUnavailable(region, battleId))) {
    return;
  }

  if (
    known &&
    (known.totalPlayers != null || known.totalKills != null) &&
    !battleMeetsDetailSyncThreshold(known)
  ) {
    await markBattleDetailUnavailable(
      region,
      battleId,
      BATTLE_BELOW_SYNC_THRESHOLD_ERROR
    ).catch(() => undefined);
    return;
  }

  const dedupeKey = battleSyncDedupeKey(region, battleId);
  const latest = await getJobByDedupeKey(dedupeKey);
  const immediate = options?.immediate === true || allowRetry;

  if (latest) {
    const state = await latest.getState();
    const legacy = toLegacyJobState(
      state,
      typeof latest.timestamp === "number" && typeof latest.delay === "number"
        ? latest.timestamp + latest.delay
        : null
    );
    if (isInProgressState(legacy)) {
      if (immediate) await promotePendingJob(dedupeKey);
      return;
    }

    if (state === "failed") {
      const lastError =
        typeof latest.failedReason === "string" ? latest.failedReason : null;
      if (!allowRetry) {
        if (isNotReadyJobError(lastError)) {
          await markBattleDetailUnavailable(
            region,
            battleId,
            lastError ?? "Battle detail unavailable from Albion API"
          ).catch(() => undefined);
        }
        return;
      }
    }

    if (state === "completed" && !allowRetry) {
      await markBattleDetailUnavailable(
        region,
        battleId,
        latest.failedReason ??
          "Battle sync completed without detail; Albion data unavailable"
      ).catch(() => undefined);
      return;
    }
  }

  await enqueueJob({
    dedupeKey,
    queue: QUEUE_NAMES.REFRESH,
    name: "sync-battle",
    payload: {
      region,
      battleId,
      ...(immediate ? { userPromoted: true } : {}),
    },
    delayMs: immediate ? 0 : BATTLE_DETAIL_SYNC_DELAY_MS,
  });
}

export async function getPlayerSyncJobState(
  region: AlbionRegion,
  albionId: string
): Promise<string | null> {
  return getPreferredJobState(playerSyncDedupeKeys(region, albionId));
}

export async function getGuildSyncJobState(
  region: AlbionRegion,
  guildId: string
): Promise<string | null> {
  return getPreferredJobState(guildSyncDedupeKeys(region, guildId));
}

export async function getAllianceRefreshJobState(
  region: AlbionRegion,
  allianceId: string
): Promise<string | null> {
  return getJobStateByDedupeKey(`refresh-alliance-${region}-${allianceId}`);
}

export async function getEntityResolveJobState(
  region: AlbionRegion,
  entityType: EntityResolveType,
  name: string
): Promise<string | null> {
  return getJobStateByDedupeKey(
    entityResolveDedupeKey(region, entityType, name.trim())
  );
}

export async function getKillEventIngestJobState(
  region: AlbionRegion,
  eventId: number
): Promise<string | null> {
  return getJobStateByDedupeKey(`ingest-event-${region}-${eventId}`);
}

export async function getBattleSyncJobState(
  region: AlbionRegion,
  battleId: number
): Promise<string | null> {
  return getJobStateByDedupeKey(battleSyncDedupeKey(region, battleId));
}

export async function requeueBattleDetail(
  region: AlbionRegion,
  battleId: number
): Promise<void> {
  if (!isRegionEnabled(region)) return;
  if (await battleAlreadyHasDetail(region, battleId)) return;

  await clearBattleDetailUnavailable(region, battleId);

  const dedupeKey = battleSyncDedupeKey(region, battleId);
  const existing = await getJobByDedupeKey(dedupeKey);

  if (existing && (await existing.getState()) === "failed") {
    const prior = (existing.data ?? {}) as JobPayload;
    const {
      circuitDefers: _circuitDefers,
      notReadyDefers: _notReadyDefers,
      notReadySince: _notReadySince,
      ...rest
    } = prior;
    await existing.updateData({ ...rest, userPromoted: true });
    await existing.retry();
    return;
  }

  await ensureBattleDetailQueued(region, battleId, {
    immediate: true,
    force: true,
  });
}

/** Enqueue a one-off scheduler job (used by emergency cron routes). */
export async function triggerSchedulerJob(
  name: "ingest-poll" | "health-check"
): Promise<string> {
  const queue = getSchedulerQueue();
  const job = await queue.add(name, {}, {
    jobId: `manual-${name}-${Date.now()}`,
  });
  return job.id ?? name;
}
