/**
 * Evict heavy battle JSON for battles ended >30 days ago (stub columns kept).
 * OVH VM maintenance — run from ingest/, not Vercel.
 */
import {
  BATTLE_DETAIL_EVICT_AFTER_DAYS,
  evictStaleBattleDetails,
  loadTopFameProtectedBattleKeysForEviction,
} from "@aotracker/core/db/battle-cache";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const olderThanDays = daysArg
    ? Math.max(
        1,
        parseInt(daysArg.slice("--days=".length), 10) ||
          BATTLE_DETAIL_EVICT_AFTER_DAYS
      )
    : BATTLE_DETAIL_EVICT_AFTER_DAYS;

  console.log(
    `[battle-evict] Starting${dryRun ? " (dry-run)" : ""} — older than ${olderThanDays} days (skips guild/alliance top-fame lists)`
  );

  const protectedKeys = await loadTopFameProtectedBattleKeysForEviction();
  console.log(
    `[battle-evict] Loaded ${protectedKeys.size} protected top-fame battle key(s)`
  );

  let totalCandidates = 0;
  let totalSkippedProtected = 0;
  let totalEvicted = 0;
  let batch = 0;

  while (true) {
    batch += 1;
    const { candidates, skippedProtected, evicted } =
      await evictStaleBattleDetails({
        olderThanDays,
        limit: 2_000,
        dryRun,
        protectedKeys,
      });

    totalCandidates += candidates;
    totalSkippedProtected += skippedProtected;
    totalEvicted += evicted;

    console.log(
      `[battle-evict] Batch ${batch}: candidates=${candidates} skippedProtected=${skippedProtected} evicted=${evicted}`
    );

    if (candidates === 0) break;
    if (dryRun) break;
    if (candidates < 2_000) break;
  }

  console.log(
    dryRun
      ? `[battle-evict] Dry run complete — ${totalCandidates} candidate(s), ${totalSkippedProtected} protected by top-fame lists, would evict ${totalCandidates - totalSkippedProtected}`
      : `[battle-evict] Done — evicted ${totalEvicted}, skipped ${totalSkippedProtected} top-fame protected (${totalCandidates} candidates scanned)`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[battle-evict] Failed:", err);
  process.exit(1);
});
