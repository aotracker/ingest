import type { Queue } from "bullmq";
import {
  DISCORD_CATCHUP_INTERVAL_MS,
  HEALTH_CHECK_INTERVAL_MS,
  INGEST_POLL_INTERVAL_MS,
  LIVE_EVENTS_INTERVAL_MS,
} from "@aotracker/core/jobs/worker-state";
import { getRedisConnection } from "./connection";
import { getSchedulerQueue } from "./queues";

export const SCHEDULER_REPEAT_DEFS = [
  { name: "health-check", everyMs: HEALTH_CHECK_INTERVAL_MS, runOnStart: true },
  { name: "ingest-poll", everyMs: INGEST_POLL_INTERVAL_MS, runOnStart: true },
  { name: "live-events-poll", everyMs: LIVE_EVENTS_INTERVAL_MS, runOnStart: true },
  {
    name: "discord-guild-catchup",
    everyMs: DISCORD_CATCHUP_INTERVAL_MS,
    runOnStart: false,
  },
] as const;

export type SchedulerRepeatName = (typeof SCHEDULER_REPEAT_DEFS)[number]["name"];

const SCHEDULER_REPEAT_NAMES = new Set<string>(
  SCHEDULER_REPEAT_DEFS.map((def) => def.name)
);

const REGISTER_LOCK_KEY = "aotracker:scheduler:register-lock";
const REGISTER_LOCK_TTL_SEC = 60;
/** Next-run timestamps slightly in the past are clock skew, not a broken chain. */
export const REPEAT_STUCK_SLACK_MS = 30_000;

export function isRepeatNextStuck(
  next: number | null | undefined,
  nowMs = Date.now(),
  slackMs = REPEAT_STUCK_SLACK_MS
): boolean {
  if (next == null || !Number.isFinite(next)) return true;
  return next < nowMs - slackMs;
}

export function isProtectedSchedulerJobId(id: string | undefined): boolean {
  if (!id) return false;
  return id.startsWith("manual-") || id.startsWith("startup-");
}

async function addRepeatable(
  queue: Queue,
  def: (typeof SCHEDULER_REPEAT_DEFS)[number],
  runNow: boolean
): Promise<void> {
  // Do not use `immediately: true`. BullMQ `every` aligns to epoch; an immediate
  // run can leave the next-slot score in the past with no delayed job, which
  // silently stops health-check and ingest-poll.
  await queue.add(def.name, {}, { repeat: { every: def.everyMs } });
  if (runNow) {
    await queue.add(def.name, {}, { jobId: `startup-${def.name}-${Date.now()}` });
  }
}

async function removeLeftoverLockedJobs(queue: Queue): Promise<number> {
  const leftover = await queue.getJobs(["active", "paused"], 0, 50);
  let removed = 0;
  for (const job of leftover) {
    if (!SCHEDULER_REPEAT_NAMES.has(job.name)) continue;
    if (isProtectedSchedulerJobId(job.id)) continue;
    try {
      await job.remove();
      removed += 1;
    } catch (err) {
      console.warn(
        `[worker] Could not remove leftover ${job.name} ${job.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return removed;
}

export async function registerRepeatableJobs(): Promise<void> {
  const queue = getSchedulerQueue();
  const redis = getRedisConnection();
  const lockToken = `${process.pid}:${Date.now()}`;
  const gotLock = await redis.set(
    REGISTER_LOCK_KEY,
    lockToken,
    "EX",
    REGISTER_LOCK_TTL_SEC,
    "NX"
  );

  if (!gotLock) {
    console.log(
      "[worker] Scheduler repeats already being registered — repairing instead of wiping"
    );
    await repairStuckSchedulerRepeats();
    return;
  }

  try {
    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
      try {
        await queue.removeRepeatableByKey(job.key);
      } catch (err) {
        console.warn(
          `[worker] Failed to remove repeatable ${job.key}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    if (existing.length > 0) {
      console.log(
        `[worker] Cleared ${existing.length} previous scheduler repeatable(s)`
      );
    }

    const removed = await removeLeftoverLockedJobs(queue);
    if (removed > 0) {
      console.log(`[worker] Removed ${removed} leftover scheduler job(s)`);
    }

    for (const def of SCHEDULER_REPEAT_DEFS) {
      await addRepeatable(queue, def, def.runOnStart);
    }

    const ingestMin = SCHEDULER_REPEAT_DEFS[1].everyMs / 60_000;
    const liveSec = SCHEDULER_REPEAT_DEFS[2].everyMs / 1000;
    const healthMin = SCHEDULER_REPEAT_DEFS[0].everyMs / 60_000;
    const catchupMin = SCHEDULER_REPEAT_DEFS[3].everyMs / 60_000;
    console.log(
      `[worker] Registered scheduler repeats: ingest every ${ingestMin}m, live events every ${liveSec}s, health every ${healthMin}m, discord catch-up every ${catchupMin}m`
    );
  } finally {
    const current = await redis.get(REGISTER_LOCK_KEY);
    if (current === lockToken) {
      await redis.del(REGISTER_LOCK_KEY);
    }
  }
}

export async function repairStuckSchedulerRepeats(): Promise<void> {
  const queue = getSchedulerQueue();
  const existing = await queue.getRepeatableJobs();
  const now = Date.now();
  const pending = await queue.getJobs(["active", "waiting", "delayed"], 0, 50);
  const pendingNames = new Set(pending.map((job) => job.name));

  for (const def of SCHEDULER_REPEAT_DEFS) {
    const listed = existing.filter((job) => job.name === def.name);
    const stuck =
      listed.length === 0 ||
      listed.every((job) => isRepeatNextStuck(job.next, now));
    if (!stuck) continue;
    if (pendingNames.has(def.name)) continue;

    console.warn(
      `[worker] Scheduler repeat stuck: ${def.name} (next=${listed[0]?.next ?? "none"}) — re-registering`
    );

    for (const job of listed) {
      try {
        await queue.removeRepeatableByKey(job.key);
      } catch (err) {
        console.warn(
          `[worker] Failed to remove stuck repeatable ${job.key}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    await addRepeatable(queue, def, true);
  }
}
