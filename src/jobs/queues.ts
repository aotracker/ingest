import { Queue } from "bullmq";
import { getRedisConnection } from "./connection";
import { QUEUE_NAMES } from "./types";

const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 24 * 60 * 60 },
  removeOnFail: { age: 60 * 60 },
};

const queueCache = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  const existing = queueCache.get(name);
  if (existing) return existing;

  const queue = new Queue(name, {
    connection: getRedisConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  queueCache.set(name, queue);
  return queue;
}

export function getIngestQueue(): Queue {
  return getQueue(QUEUE_NAMES.INGEST);
}

export function getRefreshQueue(): Queue {
  return getQueue(QUEUE_NAMES.REFRESH);
}

export function getSchedulerQueue(): Queue {
  return getQueue(QUEUE_NAMES.SCHEDULER);
}

export function queueForJobQueue(queue: string): Queue {
  if (queue === QUEUE_NAMES.INGEST) return getIngestQueue();
  if (queue === QUEUE_NAMES.REFRESH) return getRefreshQueue();
  if (queue === QUEUE_NAMES.SCHEDULER) return getSchedulerQueue();
  throw new Error(`Unknown job queue: ${queue}`);
}

export const ALL_JOB_QUEUES = [QUEUE_NAMES.INGEST, QUEUE_NAMES.REFRESH] as const;
