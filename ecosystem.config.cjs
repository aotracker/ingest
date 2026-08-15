const path = require("path");
const fs = require("fs");

const ingestRoot = __dirname;
const logDir = path.join(ingestRoot, "logs");

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

function resolveLogDir() {
  const homeLogs = path.join(
    process.env.HOME || "/home/ubuntu",
    ".pm2",
    "logs"
  );
  const candidates = [logDir, homeLogs];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // try the next writable location
    }
  }
  return logDir;
}

const resolvedLogDir = resolveLogDir();
if (resolvedLogDir !== logDir) {
  console.warn(
    `[ecosystem] ${logDir} is not writable; using ${resolvedLogDir}`
  );
}

function longRunning(name, scriptArgs, extra = {}) {
  const { env: extraEnv, ...rest } = extra;
  return {
    name,
    cwd: ingestRoot,
    script: "./node_modules/tsx/dist/cli.mjs",
    args: scriptArgs,
    interpreter: "node",
    kill_timeout: 60_000,
    max_restarts: 30,
    min_uptime: "15s",
    exp_backoff_restart_delay: 200,
    max_memory_restart: extra.max_memory_restart ?? "1G",
    merge_logs: true,
    time: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    out_file: path.join(resolvedLogDir, `${name}-out.log`),
    error_file: path.join(resolvedLogDir, `${name}-error.log`),
    vizion: false,
    env: { NODE_ENV: "production", ...extraEnv },
    ...rest,
  };
}

const coreApps = [
  longRunning("ingest-api", "--env-file=.env src/server.ts", {
    max_memory_restart: "512M",
    wait_ready: true,
    listen_timeout: 10_000,
    kill_timeout: 8_000,
  }),
  longRunning("ingest-scheduler", "--env-file=.env src/worker.ts scheduler", {
    env: { JOBS_SOURCE: "scheduler" },
    max_memory_restart: "1G",
  }),
  longRunning("ingest-worker", "--env-file=.env src/worker.ts process", {
    env: { JOBS_SOURCE: "worker" },
    max_memory_restart: "2G",
  }),
  {
    name: "battle-evict",
    cwd: ingestRoot,
    script: "./node_modules/tsx/dist/cli.mjs",
    args: "--env-file=.env scripts/evict-stale-battle-details.ts",
    interpreter: "node",
    autorestart: false,
    cron_restart: "30 5 * * 0",
    merge_logs: true,
    time: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    out_file: path.join(resolvedLogDir, "battle-evict-out.log"),
    error_file: path.join(resolvedLogDir, "battle-evict-error.log"),
    vizion: false,
    env: { NODE_ENV: "production", TZ: "UTC" },
  },
];

const regionalApps = [
  longRunning(
    "ingest-worker-americas",
    "--env-file=.env src/worker.ts process",
    {
      env: {
        JOBS_REGION: "americas",
        JOBS_REGION_ONLY: "1",
        JOBS_SOURCE: "worker-americas",
      },
      max_memory_restart: "2G",
    }
  ),
  longRunning("ingest-worker-europe", "--env-file=.env src/worker.ts process", {
    env: {
      JOBS_REGION: "europe",
      JOBS_REGION_ONLY: "1",
      JOBS_SOURCE: "worker-europe",
    },
    max_memory_restart: "2G",
  }),
];

const discordApp = longRunning(
  "discord-bot",
  "--env-file=.env src/discord/start.ts",
  {
    env: { JOBS_SOURCE: "discord-bot" },
    max_memory_restart: "512M",
  }
);

module.exports = {
  apps: [
    ...coreApps,
    ...(process.env.ENABLE_REGIONAL_WORKERS === "1" ? regionalApps : []),
    ...(process.env.DISCORD_ENABLED === "1" ? [discordApp] : []),
  ],
};
