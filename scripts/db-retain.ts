/**
 * Weekly DB retention: battle JSON eviction, kill compact, hour-stat purge.
 * Replaces battle-evict. OVH VM maintenance — run from ingest/, not Vercel.
 */
import {
  evictStaleBattleDetails,
  loadTopFameProtectedBattleKeysForEviction,
} from "@aotracker/core/db/battle-cache";
import { purgeExpiredGuildHourStats } from "@aotracker/core/db/guild-hour-stats";
import {
  countKillsNeedingCompaction,
  deleteExpiredKillStubs,
  evictStaleKillDetails,
} from "@aotracker/core/db/kill-retention";
import {
  KILL_STUB_TTL_DAYS,
  RETAIN_FULL_DAYS,
} from "@aotracker/core/db/retention";

const BATTLE_BATCH_LIMIT = 2_000;

function parseDays(flag: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!arg) return fallback;
  return Math.max(1, parseInt(arg.slice(flag.length + 1), 10) || fallback);
}

function parseBatchLimit(): number {
  const arg = process.argv.find((a) => a.startsWith("--batch="));
  if (!arg) {
    const configured = process.env.RETAIN_COMPACT_BATCH_LIMIT;
    if (configured) {
      const parsed = parseInt(configured, 10);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
    return 500;
  }
  return Math.max(1, parseInt(arg.slice("--batch=".length), 10) || 500);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const olderThanDays = parseDays("--days", RETAIN_FULL_DAYS);
  const stubTtlDays = parseDays("--stub-ttl-days", KILL_STUB_TTL_DAYS);
  const killBatchLimit = parseBatchLimit();
  const prefix = "[db-retain]";

  console.log(
    `${prefix} Starting${dryRun ? " (dry-run)" : ""} — full retain ${olderThanDays}d, stub TTL ${stubTtlDays}d, kill batch ${killBatchLimit}`
  );

  const needCompactStart = await countKillsNeedingCompaction(olderThanDays);
  console.log(`${prefix} Kills needing compaction: ${needCompactStart}`);

  const protectedKeys = await loadTopFameProtectedBattleKeysForEviction();
  console.log(
    `${prefix} Loaded ${protectedKeys.size} protected top-fame battle key(s)`
  );

  let battleCandidates = 0;
  let battleSkippedProtected = 0;
  let battleEvicted = 0;
  let battleBatch = 0;
  while (true) {
    battleBatch += 1;
    const { candidates, skippedProtected, evicted } =
      await evictStaleBattleDetails({
        olderThanDays,
        limit: BATTLE_BATCH_LIMIT,
        dryRun,
        protectedKeys,
      });
    battleCandidates += candidates;
    battleSkippedProtected += skippedProtected;
    battleEvicted += evicted;
    console.log(
      `${prefix} Battles batch ${battleBatch}: candidates=${candidates} skippedProtected=${skippedProtected} evicted=${evicted}`
    );
    if (candidates === 0) break;
    if (dryRun) break;
    if (candidates < BATTLE_BATCH_LIMIT) break;
  }

  let killCandidates = 0;
  let killCompacted = 0;
  let killBatch = 0;
  while (true) {
    killBatch += 1;
    const { candidates, compacted } = await evictStaleKillDetails({
      olderThanDays,
      limit: killBatchLimit,
      dryRun,
    });
    killCandidates += candidates;
    killCompacted += compacted;
    const needCompact = dryRun
      ? needCompactStart
      : await countKillsNeedingCompaction(olderThanDays);
    console.log(
      `${prefix} Kills compact batch ${killBatch}: candidates=${candidates} compacted=${compacted} needCompact=${needCompact}`
    );
    if (candidates === 0) break;
    if (dryRun) break;
    if (candidates < killBatchLimit) break;
  }

  let stubCandidates = 0;
  let stubsDeleted = 0;
  let stubBatch = 0;
  while (true) {
    stubBatch += 1;
    const { candidates, deleted } = await deleteExpiredKillStubs({
      stubTtlDays,
      limit: killBatchLimit,
      dryRun,
    });
    stubCandidates += candidates;
    stubsDeleted += deleted;
    console.log(
      `${prefix} Kill stubs batch ${stubBatch}: candidates=${candidates} deleted=${deleted}`
    );
    if (candidates === 0) break;
    if (dryRun) break;
    if (candidates < killBatchLimit) break;
  }

  const hours = await purgeExpiredGuildHourStats({
    olderThanDays,
    dryRun,
  });
  console.log(
    `${prefix} Guild hours: players=${hours.playersDeleted} stats=${hours.statsDeleted}${dryRun ? " (would delete)" : ""}`
  );

  const needCompactEnd = await countKillsNeedingCompaction(olderThanDays);
  console.log(
    dryRun
      ? `${prefix} Dry run complete — battles ${battleCandidates} candidates (${battleSkippedProtected} protected, would evict ${battleCandidates - battleSkippedProtected}); kills compact ${killCandidates}; stubs ${stubCandidates}; hours players=${hours.playersDeleted} stats=${hours.statsDeleted}; needCompact=${needCompactEnd}`
      : `${prefix} Done — battles evicted ${battleEvicted} (skipped ${battleSkippedProtected} protected); kills compacted ${killCompacted}; stubs deleted ${stubsDeleted}; hours players=${hours.playersDeleted} stats=${hours.statsDeleted}; needCompact ${needCompactStart} -> ${needCompactEnd}`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[db-retain] Failed:", err);
  process.exit(1);
});
