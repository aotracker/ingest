/**
 * Phase 0 gate: verify denormalized guild columns are backfilled before feud rewrite.
 * Usage (from ingest/, OVH VM): npm run db:prove-feud-preflight
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    const [victimGap] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM kill_events ke
      JOIN kill_participants kp ON kp.event_id = ke.id AND kp.role = 'victim'
      WHERE ke.total_victim_kill_fame > 0
        AND NULLIF(BTRIM(kp.guild_name), '') IS NOT NULL
        AND ke.victim_guild_name IS NULL
    `;

    const [killerGap] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM kill_events
      WHERE total_victim_kill_fame > 0
        AND raw_payload IS NOT NULL
        AND killer_guild_name IS NULL
        AND NULLIF(BTRIM(raw_payload->'Killer'->>'GuildName'), '') IS NOT NULL
    `;

    const victimMissing = Number(victimGap?.count ?? 0);
    const killerMissing = Number(killerGap?.count ?? 0);

    console.log("feud preflight — denormalized guild column gaps");
    console.log(`  victim_guild_name missing (participant has name): ${victimMissing}`);
    console.log(`  killer_guild_name missing (payload has name):     ${killerMissing}`);

    if (victimMissing > 0 || killerMissing > 0) {
      console.error(
        "\nFAIL: run npm run db:apply-kill-victim-guild-columns and npm run db:apply-kill-leaderboard-columns until both counts are 0."
      );
      process.exit(1);
    }

    const hasVictimAlliance = await sql`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'kill_events'
        AND column_name = 'victim_alliance_albion_id'
      LIMIT 1
    `;
    if (hasVictimAlliance.length > 0) {
      const [allianceGap] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM kill_events
        WHERE total_victim_kill_fame > 0
          AND raw_payload IS NOT NULL
          AND victim_alliance_albion_id IS NULL
          AND NULLIF(BTRIM(raw_payload->'Victim'->>'AllianceId'), '') IS NOT NULL
      `;
      const allianceMissing = Number(allianceGap?.count ?? 0);
      console.log(
        `  victim_alliance_albion_id missing (payload has id): ${allianceMissing}`
      );
      if (allianceMissing > 0) {
        console.error(
          "\nWARN: run npm run db:apply-kill-victim-alliance-columns before alliance feud deploy."
        );
      }
    }

    const ext = await sql`
      SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements' LIMIT 1
    `;
    if (ext.length > 0) {
      const statsReset = await sql`
        SELECT stats_reset FROM pg_stat_statements_info LIMIT 1
      `;
      if (statsReset.length > 0) {
        console.log(`\npg_stat_statements window since: ${statsReset[0].stats_reset}`);
      }
    } else {
      console.log("\n(pg_stat_statements not installed — skip stats window on dev)");
    }

    console.log("\nOK — safe to apply feud indexes and deploy client feud rewrite.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
