import type { Client } from "discord.js";
import { startDiscordBot, stopDiscordBot } from "./bot";

let shuttingDown = false;
let client: Client | null = null;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[discord] ${signal} received, shutting down…`);
  if (client) {
    try {
      await stopDiscordBot(client);
    } catch (err) {
      console.error(
        "[discord] Error during shutdown:",
        err instanceof Error ? err.message : err
      );
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

startDiscordBot()
  .then((started) => {
    client = started;
  })
  .catch((err) => {
    console.error("[discord] Fatal:", err);
    process.exit(1);
  });
