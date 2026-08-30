import { Worker } from "bullmq";
import {
  ALL_REGIONS,
  isRegionEnabled,
  type AlbionRegion,
} from "@aotracker/core/albion/types";
import {
  createRedisConnection,
  assertRedisWritable,
  startRedisHealthMonitor,
} from "./jobs/connection";
import { QUEUE_NAMES } from "./jobs/types";
import {
  recordWorkerRunError,
  recordWorkerRunSuccess,
} from "@aotracker/core/jobs/worker-state";
import { processBullJob } from "./processor";
import {
  registerRepeatableJobs,
  repairStuckSchedulerRepeats,
} from "./jobs/scheduler-repeats";
import { runHealthChecks, runIngestPoll } from "./scheduled";
import { runLiveEventsPoll } from "./discord/live-poll";
import { runDiscordGuildCatchup } from "./discord/catchup";
import { runMediaLivePoll } from "./media/live-poll";
import { recordOpsEvent } from "@aotracker/core/ops/events";

/** Lock must outlive the slowest ingest poll; default BullMQ lock is only 30s. */
const SCHEDULER_LOCK_MS = 40 * 60 * 1000;
const SCHEDULER_LOCK_RENEW_MS = 60 * 1000;

const args = process.argv.slice(2);
const mode = args.find((arg) => !arg.startsWith("-")) ?? "process";
const regionOnly =
  args.includes("--region-only") ||
  process.env.JOBS_REGION_ONLY === "1" ||
  process.env.JOBS_REGION_ONLY === "true";

function resolvePreferRegion(): AlbionRegion | undefined {
  const arg = args.find((a) => a.startsWith("--region="));
  const raw = (arg?.slice("--region=".length) ?? process.env.JOBS_REGION)?.trim();
  if (!raw) return undefined;

  const region = raw.toLowerCase();
  if (!(ALL_REGIONS as string[]).includes(region)) {
    console.error(
      `[worker] Invalid JOBS_REGION / --region="${raw}". Expected one of: ${ALL_REGIONS.join(", ")}`
    );
    process.exit(1);
  }
  if (!isRegionEnabled(region)) {
    console.warn(
      `[worker] Region "${region}" is disabled (DISABLED_REGIONS) — worker will idle for preferred claims`
    );
  }
  return region as AlbionRegion;
}

const preferRegion = resolvePreferRegion();
const source =
  process.env.JOBS_SOURCE ??
  (preferRegion ? `worker-${preferRegion}` : "worker");

let shuttingDown = false;
/** Prevent concurrent ingest-poll handlers from overlapping on concurrency > 1. */
let ingestPollInFlight = false;
let liveEventsInFlight = false;
let discordCatchupInFlight = false;
let mediaLiveInFlight = false;

function installSignalHandlers(): void {
  const onSignal = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received, shutting down…`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}

const SCHEDULER_REPAIR_MS = 30_000;

async function startSchedulerWorker(): Promise<{
  worker: Worker;
  stopRepair: () => void;
}> {
  await registerRepeatableJobs();

  const worker = new Worker(
    QUEUE_NAMES.SCHEDULER,
    async (job) => {
      if (job.name === "ingest-poll") {
        if (ingestPollInFlight) {
          console.log(
            "[worker] Ingest poll skipped — previous poll still running"
          );
          return;
        }
        ingestPollInFlight = true;
        const startedAt = Date.now();
        try {
          console.log("[worker] Ingest poll starting");
          await runIngestPoll();
          await recordWorkerRunSuccess("ingest", {
            task: "ingest",
            source,
            durationMs: Date.now() - startedAt,
          });
          console.log(
            `[worker] Ingest poll complete (${Math.round((Date.now() - startedAt) / 1000)}s)`
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await recordWorkerRunError("ingest", message).catch(() => undefined);
          throw err;
        } finally {
          ingestPollInFlight = false;
        }
        return;
      }

      if (job.name === "health-check") {
        try {
          console.log("[worker] Health checks starting");
          await runHealthChecks();
          await recordWorkerRunSuccess("health", { task: "health", source });
          console.log("[worker] Health checks complete");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await recordWorkerRunError("health", message).catch(() => undefined);
          throw err;
        }
        return;
      }

      if (job.name === "live-events-poll") {
        if (liveEventsInFlight) return;
        liveEventsInFlight = true;
        const startedAt = Date.now();
        try {
          await runLiveEventsPoll();
          await recordWorkerRunSuccess("live-events", {
            task: "live-events",
            source,
            durationMs: Date.now() - startedAt,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await recordWorkerRunError("live-events", message).catch(
            () => undefined
          );
          throw err;
        } finally {
          liveEventsInFlight = false;
        }
        return;
      }

      if (job.name === "discord-guild-catchup") {
        if (discordCatchupInFlight) return;
        discordCatchupInFlight = true;
        const startedAt = Date.now();
        try {
          await runDiscordGuildCatchup();
          await recordWorkerRunSuccess("discord-catchup", {
            task: "discord-catchup",
            source,
            durationMs: Date.now() - startedAt,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await recordWorkerRunError("discord-catchup", message).catch(
            () => undefined
          );
          throw err;
        } finally {
          discordCatchupInFlight = false;
        }
        return;
      }

      if (job.name === "media-live-poll") {
        if (mediaLiveInFlight) return;
        mediaLiveInFlight = true;
        const startedAt = Date.now();
        try {
          const result = await runMediaLivePoll();
          await recordWorkerRunSuccess("media-live", {
            task: "media-live",
            source,
            durationMs: Date.now() - startedAt,
            ...result,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await recordWorkerRunError("media-live", message).catch(
            () => undefined
          );
          throw err;
        } finally {
          mediaLiveInFlight = false;
        }
        return;
      }
    },
    {
      connection: createRedisConnection(),
      // Ingest poll is long-running; live events, health, and catch-up must still run.
      concurrency: 4,
      lockDuration: SCHEDULER_LOCK_MS,
      lockRenewTime: SCHEDULER_LOCK_RENEW_MS,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[worker] scheduler ${job?.name} failed:`, err);
    void recordOpsEvent({
      source: "scheduler",
      severity: "error",
      category: job?.name ?? "scheduler",
      message: err instanceof Error ? err.message : String(err),
      details: { queue: QUEUE_NAMES.SCHEDULER, jobName: job?.name },
    });
  });

  worker.on("stalled", (jobId) => {
    console.warn(`[worker] scheduler job stalled: ${jobId}`);
  });

  const repairTimer = setInterval(() => {
    void repairStuckSchedulerRepeats().catch((err) => {
      console.warn(
        "[worker] Scheduler repeat repair failed:",
        err instanceof Error ? err.message : err
      );
    });
  }, SCHEDULER_REPAIR_MS);
  repairTimer.unref?.();

  return {
    worker,
    stopRepair: () => {
      clearInterval(repairTimer);
    },
  };
}

function startJobWorker(queueName: string, concurrency = 5): Worker {
  const worker = new Worker(
    queueName,
    async (job) => {
      await processBullJob(job, {
        preferRegion,
        regionOnly: preferRegion ? regionOnly : false,
      });
      await recordWorkerRunSuccess("process-jobs", {
        processed: 1,
        source,
        preferRegion: preferRegion ?? null,
        regionOnly: preferRegion ? regionOnly : false,
        jobName: job.name,
      }).catch(() => undefined);
    },
    {
      connection: createRedisConnection(),
      concurrency,
    }
  );

  worker.on("failed", (job, err) => {
    if (job) {
      console.error(`[worker] ${queueName} ${job.name} failed:`, err);
      void recordWorkerRunError(
        "process-jobs",
        err instanceof Error ? err.message : String(err)
      ).catch(() => undefined);
      void recordOpsEvent({
        source: "job",
        severity: "error",
        category: job.name,
        region:
          typeof job.data?.region === "string"
            ? (job.data.region as import("@aotracker/core/albion/types").AlbionRegion)
            : undefined,
        message: err instanceof Error ? err.message : String(err),
        details: {
          queue: queueName,
          jobName: job.name,
          jobId: job.id,
          failedReason: job.failedReason,
        },
      });
    }
  });

  return worker;
}

async function main(): Promise<void> {
  installSignalHandlers();

  await assertRedisWritable();
  console.log("[worker] Redis write check OK");

  const stopRedisHealthMonitor = startRedisHealthMonitor();
  const stopRepairFns: Array<() => void> = [];
  const workers: Worker[] = [];

  if (mode === "scheduler") {
    console.log(
      "[worker] Starting scheduler (ingest, live events, health, discord catch-up)"
    );
    const scheduler = await startSchedulerWorker();
    workers.push(scheduler.worker);
    stopRepairFns.push(scheduler.stopRepair);
  } else if (mode === "process") {
    console.log(
      `[worker] Starting job processors (ingest + refresh + discord queues)` +
        (preferRegion
          ? ` preferRegion=${preferRegion}${regionOnly ? " regionOnly=true" : ""}`
          : "")
    );
    workers.push(startJobWorker(QUEUE_NAMES.INGEST));
    workers.push(startJobWorker(QUEUE_NAMES.REFRESH));
    // Concurrency 1 keeps kill/death posts oldest-to-newest per channel.
    workers.push(startJobWorker(QUEUE_NAMES.DISCORD, 1));
  } else if (mode === "all") {
    console.log("[worker] Starting scheduler + job processors");
    const scheduler = await startSchedulerWorker();
    workers.push(scheduler.worker);
    stopRepairFns.push(scheduler.stopRepair);
    workers.push(startJobWorker(QUEUE_NAMES.INGEST));
    workers.push(startJobWorker(QUEUE_NAMES.REFRESH));
    workers.push(startJobWorker(QUEUE_NAMES.DISCORD, 1));
  } else {
    console.error(
      `Unknown mode "${mode}". Use: process | scheduler | all [--region=americas|europe|asia] [--region-only]`
    );
    process.exit(1);
  }

  while (!shuttingDown) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  for (const stop of stopRepairFns) stop();
  stopRedisHealthMonitor();
  console.log("[worker] Closing workers…");
  await Promise.all(workers.map((w) => w.close()));
  console.log("[worker] Stopped");
}

main().catch((err) => {
  console.error("[worker] Fatal:", err);
  process.exit(1);
});
