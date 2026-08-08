import { runIngestPoll } from "../src/scheduled";

await runIngestPoll();
console.log("[jobs] Ingest complete");
