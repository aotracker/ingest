const path = require("path");

const ingestRoot = __dirname;

const longRunningDefaults = {
  cwd: ingestRoot,
  script: "npm",
  kill_timeout: 60_000,
  max_restarts: 10,
  min_uptime: "10s",
  merge_logs: true,
  time: true,
};

const coreApps = [
  {
    ...longRunningDefaults,
    name: "ingest-api",
    args: "run api",
  },
  {
    ...longRunningDefaults,
    name: "ingest-worker",
    args: "run worker",
    env: { JOBS_SOURCE: "worker" },
  },
  {
    name: "battle-evict",
    cwd: ingestRoot,
    script: "npm",
    args: "run db:evict-battle-details",
    autorestart: false,
    cron_restart: "30 5 * * 0",
    merge_logs: true,
    time: true,
  },
];

const regionalApps = [
  {
    ...longRunningDefaults,
    name: "ingest-worker-americas",
    args: "run worker:process",
    env: { JOBS_REGION: "americas", JOBS_SOURCE: "worker-americas" },
  },
  {
    ...longRunningDefaults,
    name: "ingest-worker-europe",
    args: "run worker:process",
    env: { JOBS_REGION: "europe", JOBS_SOURCE: "worker-europe" },
  },
];

module.exports = {
  apps: [
    ...coreApps,
    ...(process.env.ENABLE_REGIONAL_WORKERS === "1" ? regionalApps : []),
  ],
};
