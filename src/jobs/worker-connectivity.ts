import { getDiscordQueue, getIngestQueue, getRefreshQueue, getSchedulerQueue } from "./queues";

export interface WorkerConnectivitySnapshot {
  schedulerWorkers: number;
  ingestWorkers: number;
  refreshWorkers: number;
  discordWorkers: number;
  processorWorkers: number;
  schedulerJobActive: {
    ingestPoll: boolean;
    healthCheck: boolean;
    liveEventsPoll: boolean;
    discordCatchup: boolean;
    mediaLivePoll: boolean;
  };
  processorJobsActive: boolean;
  fetchedAt: string;
}

export async function getWorkerConnectivity(): Promise<WorkerConnectivitySnapshot> {
  const scheduler = getSchedulerQueue();
  const ingest = getIngestQueue();
  const refresh = getRefreshQueue();
  const discord = getDiscordQueue();

  const [
    schedulerWorkers,
    ingestWorkers,
    refreshWorkers,
    discordWorkers,
    activeSchedulerJobs,
    activeIngestJobs,
    activeRefreshJobs,
    activeDiscordJobs,
  ] = await Promise.all([
    scheduler.getWorkersCount(),
    ingest.getWorkersCount(),
    refresh.getWorkersCount(),
    discord.getWorkersCount(),
    scheduler.getJobs(["active"], 0, 10),
    ingest.getJobs(["active"], 0, 5),
    refresh.getJobs(["active"], 0, 5),
    discord.getJobs(["active"], 0, 5),
  ]);

  return {
    schedulerWorkers,
    ingestWorkers,
    refreshWorkers,
    discordWorkers,
    processorWorkers: ingestWorkers + refreshWorkers + discordWorkers,
    schedulerJobActive: {
      ingestPoll: activeSchedulerJobs.some((job) => job.name === "ingest-poll"),
      healthCheck: activeSchedulerJobs.some(
        (job) => job.name === "health-check"
      ),
      liveEventsPoll: activeSchedulerJobs.some(
        (job) => job.name === "live-events-poll"
      ),
      discordCatchup: activeSchedulerJobs.some(
        (job) => job.name === "discord-guild-catchup"
      ),
      mediaLivePoll: activeSchedulerJobs.some(
        (job) => job.name === "media-live-poll"
      ),
    },
    processorJobsActive:
      activeIngestJobs.length > 0 ||
      activeRefreshJobs.length > 0 ||
      activeDiscordJobs.length > 0,
    fetchedAt: new Date().toISOString(),
  };
}
