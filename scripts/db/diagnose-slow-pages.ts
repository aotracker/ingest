/**
 * Read-only diagnostics for the slow production pages:
 *   /leaderboards?region=all
 *   /leaderboards?region=all&tab=guilds
 *   /battles?region=all
 *
 * Usage (from ingest/, OVH VM or local): npm run db:diagnose-slow-pages
 *
 * Prints table/TOAST sizes, EXPLAIN (ANALYZE, BUFFERS) for the three page
 * shapes, pg_stat_statements if installed, and how to grep the 1s slow log.
 */
import postgres from "postgres";

const REGIONS_SQL = `'americas','europe','asia'`;
const EXPLAIN = "EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)";
const STATEMENT_TIMEOUT = "120s";

function banner(title: string) {
  const line = "=".repeat(72);
  console.log(`\n${line}\n${title}\n${line}`);
}

async function runExplain(
  sql: postgres.Sql,
  label: string,
  query: string
): Promise<void> {
  banner(`EXPLAIN ANALYZE — ${label}`);
  console.log(query.trim());
  console.log("---");
  const started = Date.now();
  try {
    const rows = await sql.unsafe(`${EXPLAIN}\n${query}`);
    for (const row of rows) {
      const text = Object.values(row as Record<string, unknown>)[0];
      console.log(String(text));
    }
    console.log(`(wall clock ${Date.now() - started}ms)`);
  } catch (err) {
    console.error(`FAILED after ${Date.now() - started}ms:`, err);
  }
}

async function columnExists(
  sql: postgres.Sql,
  table: string,
  column: string
): Promise<boolean> {
  const rows = await sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
      AND column_name = ${column}
    LIMIT 1
  `;
  return rows.length > 0;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);

    banner("Relation sizes (heap / indexes / TOAST)");
    const sizes = await sql.unsafe(`
      SELECT
        n.nspname AS schema,
        c.relname AS relation,
        pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
        pg_size_pretty(pg_relation_size(c.oid)) AS heap,
        pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
        CASE
          WHEN c.reltoastrelid = 0 THEN '0 bytes'
          ELSE pg_size_pretty(pg_relation_size(c.reltoastrelid))
        END AS toast
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'i', 'm')
        AND c.relname IN (
          'kill_events',
          'battles',
          'kill_participants',
          'kill_items',
          'guild_hour_stats',
          'guild_hour_players',
          'kill_events_region_occurred_fame_idx',
          'kill_events_killer_idx',
          'kill_events_occurred_idx',
          'kill_events_lb_killer_idx',
          'kill_events_lb_fame_idx',
          'kill_events_lb_guild_idx',
          'kill_events_lb_alliance_idx',
          'battles_region_start_time_idx',
          'battles_feed_start_time_idx'
        )
      ORDER BY pg_total_relation_size(c.oid) DESC
    `);
    console.table(sizes);

    banner("Row counts (estimated from pg_class)");
    const estimates = await sql.unsafe(`
      SELECT relname, reltuples::bigint AS est_rows
      FROM pg_class
      WHERE relname IN (
        'kill_events', 'battles', 'kill_participants', 'guild_hour_stats'
      )
      ORDER BY relname
    `);
    console.table(estimates);

    const killersSql = `
SELECT killer_id, COUNT(*) AS kill_count
FROM kill_events
WHERE total_victim_kill_fame > 0
  AND occurred_at >= now() - interval '7 days'
  AND region IN (${REGIONS_SQL})
  AND killer_id IS NOT NULL
GROUP BY killer_id
ORDER BY COUNT(*) DESC
LIMIT 50`;
    await runExplain(sql, "leaderboards killers (region=all, 7d)", killersSql);

    const hasGuildCol = await columnExists(
      sql,
      "kill_events",
      "killer_guild_albion_id"
    );
    if (hasGuildCol) {
      const guildColSql = `
SELECT region, killer_guild_albion_id, killer_guild_name,
       SUM(total_victim_kill_fame) AS kill_fame, COUNT(*) AS kill_count
FROM kill_events
WHERE total_victim_kill_fame > 0
  AND occurred_at >= now() - interval '7 days'
  AND region IN (${REGIONS_SQL})
  AND killer_id IS NOT NULL
  AND killer_guild_albion_id IS NOT NULL
  AND trim(killer_guild_name) <> ''
GROUP BY region, killer_guild_albion_id, killer_guild_name
ORDER BY SUM(total_victim_kill_fame) DESC
LIMIT 50`;
      await runExplain(
        sql,
        "leaderboards guilds via denormalized columns",
        guildColSql
      );
    } else {
      console.log(
        "\n(killer_guild_albion_id not present — skipping denormalized guild EXPLAIN)"
      );
    }

    const guildJsonSql = `
SELECT region,
       raw_payload->'Killer'->>'GuildId' AS guild_id,
       raw_payload->'Killer'->>'GuildName' AS guild_name,
       SUM(total_victim_kill_fame) AS kill_fame,
       COUNT(*) AS kill_count
FROM kill_events
WHERE total_victim_kill_fame > 0
  AND occurred_at >= now() - interval '7 days'
  AND region IN (${REGIONS_SQL})
  AND killer_id IS NOT NULL
  AND raw_payload->'Killer'->>'GuildId' IS NOT NULL
  AND trim(raw_payload->'Killer'->>'GuildName') <> ''
GROUP BY 1, 2, 3
ORDER BY SUM(total_victim_kill_fame) DESC
LIMIT 50`;
    await runExplain(
      sql,
      "leaderboards guilds via JSONB (legacy / comparison)",
      guildJsonSql
    );

    const hasPreview = await columnExists(sql, "battles", "feed_preview");
    const battlesSelect = hasPreview
      ? `albion_battle_id, region, start_time, total_fame, total_kills, total_players, feed_preview`
      : `albion_battle_id, region, start_time, total_fame, total_kills, total_players, raw_payload, detail_payload`;
    const battlesFeedSql = `
SELECT ${battlesSelect}
FROM battles
WHERE region IN (${REGIONS_SQL})
  AND total_fame IS NOT NULL
  AND total_kills IS NOT NULL
  AND total_players IS NOT NULL
  AND total_players >= 10
ORDER BY start_time DESC NULLS LAST, created_at DESC
LIMIT 20`;
    await runExplain(
      sql,
      `battles feed page 1 (${hasPreview ? "feed_preview" : "full JSONB"})`,
      battlesFeedSql
    );

    const battlesCountSql = `
SELECT COUNT(*)
FROM battles
WHERE region IN (${REGIONS_SQL})
  AND total_fame IS NOT NULL
  AND total_kills IS NOT NULL
  AND total_players IS NOT NULL
  AND total_players >= 10`;
    await runExplain(sql, "battles feed COUNT(*)", battlesCountSql);

    banner("pg_stat_statements");
    const ext = await sql`
      SELECT extversion
      FROM pg_extension
      WHERE extname = 'pg_stat_statements'
    `;
    if (ext.length === 0) {
      console.log(`Not installed.

To enable on the OVH VM:
  1. Add to deploy/vm/postgresql.24g.conf (copied to /opt/albion-postgres/postgresql.conf):
       shared_preload_libraries = 'pg_stat_statements'
       pg_stat_statements.track = all
  2. Recreate/restart the Postgres container so the preload takes effect.
  3. psql: CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
`);
    } else {
      console.log(`Installed (version ${ext[0].extversion}). Top queries by mean time:`);
      const top = await sql.unsafe(`
        SELECT
          round(mean_exec_time::numeric, 1) AS mean_ms,
          round(total_exec_time::numeric, 0) AS total_ms,
          calls,
          rows,
          left(query, 180) AS query
        FROM pg_stat_statements
        WHERE query NOT LIKE '%pg_stat_statements%'
        ORDER BY mean_exec_time DESC
        LIMIT 20
      `);
      console.table(top);
    }

    banner("Slow-query log (log_min_duration_statement = 1000)");
    console.log(`Postgres logs statements slower than 1s.
On the VM:
  docker logs albion-postgres 2>&1 | grep -E 'duration: [0-9]{4,}'
or, if logging to the data dir:
  grep -R "duration:" /opt/albion-postgres/data/log | tail
`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
