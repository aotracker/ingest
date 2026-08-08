import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ingestRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === "win32";
const apiPort = Number.parseInt(process.env.INGEST_API_PORT ?? "3001", 10);

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE");
    });
    probe.once("listening", () => {
      probe.close(() => resolve(false));
    });
    probe.listen({ port, host: "0.0.0.0" });
  });
}

function run(name: string, npmScript: string): ChildProcess {
  const child = spawn("npm", ["run", npmScript], {
    cwd: ingestRoot,
    stdio: "inherit",
    shell: isWindows,
    env: process.env,
  });

  child.on("error", (err) => {
    console.error(`[start] Failed to launch ${name}:`, err);
    shutdown("SIGTERM");
    process.exit(1);
  });

  return child;
}

const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[start] ${signal} received, stopping api + worker…`);
  for (const child of children) {
    if (!child.killed && child.pid) {
      child.kill(signal);
    }
  }
}

async function main(): Promise<void> {
  if (await isPortInUse(apiPort)) {
    console.error(
      `[start] Port ${apiPort} is already in use (another ingest API is probably still running).`
    );
    if (isWindows) {
      console.error(
        `  Find it: netstat -ano | findstr :${apiPort}\n` +
          `  Stop it: taskkill /PID <pid> /F`
      );
    } else {
      console.error(`  Find it: lsof -i :${apiPort}`);
    }
    console.error("  Or run workers only: npm run worker");
    process.exit(1);
  }

  children.push(run("api", "api"), run("worker", "worker"));

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  for (const child of children) {
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      if (signal) return;
      if (code !== 0 && code !== null) {
        console.error(`[start] Process exited with code ${code}`);
        shutdown("SIGTERM");
        process.exit(code);
      }
    });
  }

  console.log("[start] Running ingest HTTP API + BullMQ workers");
}

main().catch((err) => {
  console.error("[start] Fatal:", err);
  process.exit(1);
});
