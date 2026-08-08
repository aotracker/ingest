import type { Job } from "bullmq";
import { DelayedError } from "bullmq";
import type { AlbionRegion } from "@aotracker/core/albion/types";
import { isBattleNotReadyError } from "@aotracker/core/albion/errors";
import {
  CIRCUIT_JOB_DEFER_MS,
  CIRCUIT_MAX_JOB_DEFERS,
  CircuitOpenError,
  isCircuitOpenError,
} from "@aotracker/core/db/api-state";
import { markBattleDetailUnavailable } from "@aotracker/core/db/battle-cache";
import {
  BATTLE_NOT_READY_MAX_DEFERS,
  battleNotReadyDelayMs,
  isJobTimeoutError,
  JobTimeoutError,
  jobTimeoutMs,
} from "./jobs/constants";
import type { JobPayload } from "./jobs/types";
import { executeJob } from "./handlers";

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  jobName: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new JobTimeoutError(jobName, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (isJobTimeoutError(err)) {
      void work.catch(() => undefined);
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function deferForCircuit(
  job: Job<JobPayload>,
  error: string
): Promise<void> {
  const payload = job.data ?? {};
  const circuitDefers = (payload.circuitDefers ?? 0) + 1;

  if (circuitDefers > CIRCUIT_MAX_JOB_DEFERS) {
    if (payload.region != null && payload.battleId != null) {
      await markBattleDetailUnavailable(
        payload.region,
        payload.battleId,
        `${error} — exceeded ${CIRCUIT_MAX_JOB_DEFERS} circuit defers`
      ).catch((err) => {
        console.warn(
          `[jobs] failed to mark battle unavailable ${payload.region}/${payload.battleId}:`,
          err
        );
      });
    }
    throw new Error(
      `${error} — exceeded ${CIRCUIT_MAX_JOB_DEFERS} circuit defers`
    );
  }

  const { userPromoted: _userPromoted, ...rest } = payload;
  await job.updateData({ ...rest, circuitDefers });
  await job.moveToDelayed(Date.now() + CIRCUIT_JOB_DEFER_MS);
  throw new DelayedError();
}

async function deferForBattleNotReady(
  job: Job<JobPayload>,
  error: string
): Promise<void> {
  const payload = job.data ?? {};
  const notReadyDefers = (payload.notReadyDefers ?? 0) + 1;

  if (notReadyDefers > BATTLE_NOT_READY_MAX_DEFERS) {
    if (payload.region != null && payload.battleId != null) {
      await markBattleDetailUnavailable(
        payload.region,
        payload.battleId,
        error
      ).catch((err) => {
        console.warn(
          `[jobs] failed to mark battle unavailable ${payload.region}/${payload.battleId}:`,
          err
        );
      });
    }
    throw new Error(
      `${error} — Albion still has not published this battle after ${BATTLE_NOT_READY_MAX_DEFERS} soft retries`
    );
  }

  const notReadySince = payload.notReadySince ?? Date.now();
  const delayMs = battleNotReadyDelayMs(notReadyDefers);
  const { userPromoted: _userPromoted, ...rest } = payload;
  await job.updateData({
    ...rest,
    notReadyDefers,
    notReadySince,
  });
  await job.moveToDelayed(Date.now() + delayMs);
  throw new DelayedError();
}

export interface ProcessorOptions {
  preferRegion?: AlbionRegion;
  regionOnly?: boolean;
}

export async function processBullJob(
  job: Job<JobPayload>,
  options?: ProcessorOptions
): Promise<void> {
  const payload = job.data ?? {};
  const preferRegion = options?.preferRegion;
  const regionOnly = options?.regionOnly === true;

  if (preferRegion && payload.region && payload.region !== preferRegion) {
    if (regionOnly) {
      await job.moveToDelayed(Date.now() + 250);
      throw new DelayedError();
    }
    await job.moveToDelayed(Date.now() + 250);
    throw new DelayedError();
  }

  const timeoutMs = jobTimeoutMs(job.name);
  try {
    await withTimeout(executeJob(job.name, payload), timeoutMs, job.name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isCircuitOpenError(err) || err instanceof CircuitOpenError) {
      console.warn(`[jobs] ${job.name} deferred — circuit open: ${message}`);
      await deferForCircuit(job, message);
      return;
    }
    if (isBattleNotReadyError(err)) {
      console.warn(`[jobs] ${job.name} deferred — battle not ready: ${message}`);
      await deferForBattleNotReady(job, message);
      return;
    }
    if (isJobTimeoutError(err)) {
      console.error(`[jobs] ${job.name} timed out:`, message);
    } else {
      console.error(`[jobs] ${job.name} failed:`, message);
    }
    throw err;
  }
}
