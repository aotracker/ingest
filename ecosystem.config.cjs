const path = require("path");
const fs = require("fs");

const ingestRoot = __dirname;

function loadIngestEnv() {
  const envPath = path.join(ingestRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadIngestEnv();

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

const discordApp = {
  ...longRunningDefaults,
  name: "discord-bot",
  args: "run discord:bot",
  env: { JOBS_SOURCE: "discord-bot" },
};

module.exports = {
  apps: [
    ...coreApps,
    ...(process.env.ENABLE_REGIONAL_WORKERS === "1" ? regionalApps : []),
    ...(process.env.DISCORD_ENABLED === "1" ? [discordApp] : []),
  ],
};
