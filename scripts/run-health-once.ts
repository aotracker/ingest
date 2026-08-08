import { runHealthChecks } from "../src/scheduled";

await runHealthChecks();
console.log("[jobs] Health checks complete");
