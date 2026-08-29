/**
 * Homepage /health rollups:
 *   - player_day_stats (7/14/30d killer + fame leaderboards)
 *   - api_sync_state entity count + latest-kill snapshots
 *
 * Usage (from ingest/, OVH VM or local): npm run db:apply-page-perf-rollups
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`SET statement_timeout = 0`);

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "player_day_stats" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "region" "region" NOT NULL,
        "player_id" uuid NOT NULL,
        "utc_date" date NOT NULL,
        "content_type" "content_type" NOT NULL,
        "kill_count" integer DEFAULT 0 NOT NULL,
        "kill_fame" bigint DEFAULT 0 NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "player_day_stats_bucket_idx"
        ON "player_day_stats" ("region","player_id","utc_date","content_type");
      CREATE INDEX IF NOT EXISTS "player_day_stats_date_idx"
        ON "player_day_stats" ("utc_date","region","content_type");
    `);
    console.log("player_day_stats ready. Backfilling last 30 days…");

    await sql.unsafe(`
      INSERT INTO player_day_stats (
        region, player_id, utc_date, content_type, kill_count, kill_fame
      )
      SELECT
        region,
        killer_id,
        (occurred_at AT TIME ZONE 'UTC')::date,
        content_type,
        COUNT(*)::int,
        COALESCE(SUM(total_victim_kill_fame), 0)::bigint
      FROM kill_events
      WHERE occurred_at >= NOW() - INTERVAL '30 days'
        AND total_victim_kill_fame > 0
        AND killer_id IS NOT NULL
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (region, player_id, utc_date, content_type)
      DO UPDATE SET
        kill_count = EXCLUDED.kill_count,
        kill_fame = EXCLUDED.kill_fame
    `);
    console.log("player_day_stats backfill complete.");

    await sql.unsafe(`
      ALTER TABLE api_sync_state
        ADD COLUMN IF NOT EXISTS latest_kill_at timestamptz;
      ALTER TABLE api_sync_state
        ADD COLUMN IF NOT EXISTS player_count integer DEFAULT 0 NOT NULL;
      ALTER TABLE api_sync_state
        ADD COLUMN IF NOT EXISTS guild_count integer DEFAULT 0 NOT NULL;
      ALTER TABLE api_sync_state
        ADD COLUMN IF NOT EXISTS kill_count integer DEFAULT 0 NOT NULL;
      ALTER TABLE api_sync_state
        ADD COLUMN IF NOT EXISTS battle_count integer DEFAULT 0 NOT NULL;
    `);
    console.log("api_sync_state snapshot columns ready. Backfilling…");

    await sql.unsafe(`
      INSERT INTO api_sync_state (region)
      SELECT r.region
      FROM (VALUES ('americas'::region), ('europe'::region), ('asia'::region)) AS r(region)
      ON CONFLICT (region) DO NOTHING
    `);

    await sql.unsafe(`
      WITH player_counts AS (
        SELECT region, COUNT(*)::int AS n FROM players GROUP BY region
      ),
      guild_counts AS (
        SELECT region, COUNT(*)::int AS n FROM guilds GROUP BY region
      ),
      kill_stats AS (
        SELECT region, COUNT(*)::int AS n, MAX(occurred_at) AS latest
        FROM kill_events
        GROUP BY region
      ),
      battle_counts AS (
        SELECT region, COUNT(*)::int AS n FROM battles GROUP BY region
      )
      UPDATE api_sync_state s
      SET
        player_count = COALESCE(p.n, 0),
        guild_count = COALESCE(g.n, 0),
        kill_count = COALESCE(k.n, 0),
        battle_count = COALESCE(b.n, 0),
        latest_kill_at = k.latest,
        updated_at = NOW()
      FROM (SELECT unnest(ARRAY['americas','europe','asia']::region[]) AS region) r
      LEFT JOIN player_counts p ON p.region = r.region
      LEFT JOIN guild_counts g ON g.region = r.region
      LEFT JOIN kill_stats k ON k.region = r.region
      LEFT JOIN battle_counts b ON b.region = r.region
      WHERE s.region = r.region
    `);
    console.log("api_sync_state snapshot backfill complete.");
  }, { endTimeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
