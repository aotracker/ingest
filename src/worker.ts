import { Worker } from "bullmq";
import {
  ALL_REGIONS,
  isRegionEnabled,
  type AlbionRegion,
} from "@aotracker/core/albion/types";
import { createRedisConnection } from "./jobs/connection";
import { QUEUE_NAMES } from "./jobs/types";
import {
  getIngestQueue,
  getRefreshQueue,
  getSchedulerQueue,
} from "./jobs/queues";
import {
  recordWorkerRunError,
  recordWorkerRunSuccess,
} from "@aotracker/core/jobs/worker-state";
import { processBullJob } from "./processor";
import { runHealthChecks, runIngestPoll } from "./scheduled";
import { recordOpsEvent } from "@aotracker/core/ops/events";

/** Discovery poll interval — recent events + recent battles per enabled region. */
const INGEST_LOOP_MS = 12 * 60 * 1000;
const HEALTH_LOOP_MS = 5 * 60 * 1000;

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

function installSignalHandlers(): void {
  const onSignal = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received, shutting down…`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}

async function registerRepeatableJobs(): Promise<void> {
  const queue = getSchedulerQueue();
  await queue.add(
    "ingest-poll",
    {},
    {
      repeat: { every: INGEST_LOOP_MS },
      jobId: "repeat-ingest-poll",
    }
  );
  await queue.add(
    "health-check",
    {},
    {
      repeat: { every: HEALTH_LOOP_MS },
      jobId: "repeat-health-check",
    }
  );
}

async function startSchedulerWorker(): Promise<Worker> {
  await registerRepeatableJobs();

  const worker = new Worker(
    QUEUE_NAMES.SCHEDULER,
    async (job) => {
      if (job.name === "ingest-poll") {
        try {
          await runIngestPoll();
          await recordWorkerRunSuccess("ingest", { task: "ingest", source });
          console.log("[worker] Ingest poll complete");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await recordWorkerRunError("ingest", message).catch(() => undefined);
          throw err;
        }
        return;
      }

      if (job.name === "health-check") {
        try {
          await runHealthChecks();
          await recordWorkerRunSuccess("health", { task: "health", source });
          console.log("[worker] Health checks complete");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await recordWorkerRunError("health", message).catch(() => undefined);
          throw err;
        }
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
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

  return worker;
}

function startJobWorker(queueName: string): Worker {
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
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    if (job) {
      console.error(`[worker] ${queueName} ${job.name} failed:`, err);
      void recordWorkerRunError(
        "process-jobs",
        err instanceof Error ? err.message : String(err)
      );
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

  const workers: Worker[] = [];

  if (mode === "scheduler") {
    console.log("[worker] Starting scheduler (ingest + health repeatable jobs)");
    workers.push(await startSchedulerWorker());
  } else if (mode === "process") {
    console.log(
      `[worker] Starting job processors (ingest + refresh queues)` +
        (preferRegion
          ? ` preferRegion=${preferRegion}${regionOnly ? " regionOnly=true" : ""}`
          : "")
    );
    workers.push(startJobWorker(QUEUE_NAMES.INGEST));
    workers.push(startJobWorker(QUEUE_NAMES.REFRESH));
  } else if (mode === "all") {
    console.log("[worker] Starting scheduler + job processors");
    workers.push(await startSchedulerWorker());
    workers.push(startJobWorker(QUEUE_NAMES.INGEST));
    workers.push(startJobWorker(QUEUE_NAMES.REFRESH));
  } else {
    console.error(
      `Unknown mode "${mode}". Use: process | scheduler | all [--region=americas|europe|asia] [--region-only]`
    );
    process.exit(1);
  }

  while (!shuttingDown) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log("[worker] Closing workers…");
  await Promise.all(workers.map((w) => w.close()));
  console.log("[worker] Stopped");
}

main().catch((err) => {
  console.error("[worker] Fatal:", err);
  process.exit(1);
});
