import { getIngestQueue, getRefreshQueue, getSchedulerQueue } from "./queues";

export interface WorkerConnectivitySnapshot {
  schedulerWorkers: number;
  ingestWorkers: number;
  refreshWorkers: number;
  processorWorkers: number;
  schedulerJobActive: {
    ingestPoll: boolean;
    healthCheck: boolean;
  };
  processorJobsActive: boolean;
  fetchedAt: string;
}

export async function getWorkerConnectivity(): Promise<WorkerConnectivitySnapshot> {
  const scheduler = getSchedulerQueue();
  const ingest = getIngestQueue();
  const refresh = getRefreshQueue();

  const [
    schedulerWorkers,
    ingestWorkers,
    refreshWorkers,
    activeSchedulerJobs,
    activeIngestJobs,
    activeRefreshJobs,
  ] = await Promise.all([
    scheduler.getWorkersCount(),
    ingest.getWorkersCount(),
    refresh.getWorkersCount(),
    scheduler.getJobs(["active"], 0, 10),
    ingest.getJobs(["active"], 0, 5),
    refresh.getJobs(["active"], 0, 5),
  ]);

  return {
    schedulerWorkers,
    ingestWorkers,
    refreshWorkers,
    processorWorkers: ingestWorkers + refreshWorkers,
    schedulerJobActive: {
      ingestPoll: activeSchedulerJobs.some((job) => job.name === "ingest-poll"),
      healthCheck: activeSchedulerJobs.some(
        (job) => job.name === "health-check"
      ),
    },
    processorJobsActive:
      activeIngestJobs.length > 0 || activeRefreshJobs.length > 0,
    fetchedAt: new Date().toISOString(),
  };
}
