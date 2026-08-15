import { startDiscordBot } from "./bot";

let shuttingDown = false;

function installSignalHandlers(): void {
  const onSignal = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[discord] ${signal} received, shutting down…`);
    process.exit(0);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}

installSignalHandlers();

startDiscordBot().catch((err) => {
  console.error("[discord] Fatal:", err);
  process.exit(1);
});
