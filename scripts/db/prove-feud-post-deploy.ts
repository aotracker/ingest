/**
 * Post-deploy check: feud queries should no longer appear in pg_stat top offenders.
 * Usage (from ingest/, OVH VM): npm run db:prove-feud-post-deploy
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    const ext = await sql`
      SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements' LIMIT 1
    `;
    if (ext.length === 0) {
      console.log("pg_stat_statements not installed — skip automated check.");
      return;
    }

    const legacy = await sql.unsafe(`
      SELECT
        round(mean_exec_time::numeric, 1) AS mean_ms,
        calls,
        left(query, 140) AS query
      FROM pg_stat_statements
      WHERE query ILIKE '%feud_killer%'
         OR query ILIKE '%rival_victim%'
         OR query ILIKE '%Victim''->>''AllianceId%'
      ORDER BY total_exec_time DESC
      LIMIT 10
    `);

    console.log("Legacy feud/rivals query patterns still in pg_stat_statements:");
    if (legacy.length === 0) {
      console.log("  (none — good)");
    } else {
      console.table(legacy);
      console.log(
        "\nNote: historical stats remain until reset; verify mean_ms on NEW calls after deploy."
      );
    }

    const statsReset = await sql`
      SELECT stats_reset FROM pg_stat_statements_info LIMIT 1
    `;
    if (statsReset.length > 0) {
      console.log(`\nStats window since: ${statsReset[0].stats_reset}`);
    }

    console.log("\nManual smoke:");
    console.log("  - Kill page with guild feud block");
    console.log("  - /feud/{region}/{guildA}/{guildB}");
    console.log("  - Guild profile rivals panel");
    console.log("  - Kill page with alliance feud block");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
