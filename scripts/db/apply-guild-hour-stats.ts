/**
 * Create guild UTC-hour activity tables and backfill the last 30 days.
 * Usage: npm run db:apply-guild-hour-stats (from ingest/, OVH VM or local dev)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "guild_hour_stats" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "region" "region" NOT NULL,
        "guild_albion_id" text NOT NULL,
        "guild_name" text NOT NULL,
        "utc_date" date NOT NULL,
        "utc_hour" integer NOT NULL,
        "content_type" "content_type" NOT NULL,
        "unique_players" integer DEFAULT 0 NOT NULL,
        "kills" integer DEFAULT 0 NOT NULL,
        "deaths" integer DEFAULT 0 NOT NULL,
        "fame" bigint DEFAULT 0 NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "guild_hour_players" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "region" "region" NOT NULL,
        "guild_albion_id" text NOT NULL,
        "utc_date" date NOT NULL,
        "utc_hour" integer NOT NULL,
        "content_type" "content_type" NOT NULL,
        "player_albion_id" text NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "guild_hour_stats_bucket_idx"
        ON "guild_hour_stats" ("region","guild_albion_id","utc_date","utc_hour","content_type");
      CREATE INDEX IF NOT EXISTS "guild_hour_stats_hour_idx"
        ON "guild_hour_stats" ("region","utc_hour","utc_date");
      CREATE INDEX IF NOT EXISTS "guild_hour_stats_guild_idx"
        ON "guild_hour_stats" ("region","guild_albion_id","utc_date");
      CREATE UNIQUE INDEX IF NOT EXISTS "guild_hour_players_bucket_idx"
        ON "guild_hour_players" ("region","guild_albion_id","utc_date","utc_hour","content_type","player_albion_id");
      CREATE INDEX IF NOT EXISTS "guild_hour_players_hour_idx"
        ON "guild_hour_players" ("region","utc_hour","utc_date");
      CREATE INDEX IF NOT EXISTS "guild_hour_players_guild_idx"
        ON "guild_hour_players" ("region","guild_albion_id","utc_date");
    `);
    console.log("guild_hour_stats tables ready. Backfilling last 30 days…");

    const playersInserted = await sql.unsafe(`
      INSERT INTO guild_hour_players (
        region, guild_albion_id, utc_date, utc_hour, content_type, player_albion_id
      )
      SELECT DISTINCT
        ke.region,
        kp.raw_payload->>'GuildId',
        (ke.occurred_at AT TIME ZONE 'UTC')::date,
        EXTRACT(HOUR FROM ke.occurred_at AT TIME ZONE 'UTC')::int,
        ke.content_type,
        COALESCE(p.albion_id, NULLIF(kp.raw_payload->>'Id', ''))
      FROM kill_events ke
      JOIN kill_participants kp ON kp.event_id = ke.id
      LEFT JOIN players p ON p.id = kp.player_id
      WHERE ke.occurred_at >= NOW() - INTERVAL '30 days'
        AND NULLIF(TRIM(kp.raw_payload->>'GuildId'), '') IS NOT NULL
        AND COALESCE(p.albion_id, NULLIF(kp.raw_payload->>'Id', '')) IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
    console.log("guild_hour_players insert done.", playersInserted.count ?? "");

    await sql.unsafe(`
      WITH bounds AS (
        SELECT (NOW() AT TIME ZONE 'UTC')::date - 30 AS cutoff
      ),
      kill_agg AS (
        SELECT
          ke.region,
          ke.raw_payload->'Killer'->>'GuildId' AS guild_albion_id,
          MAX(NULLIF(TRIM(ke.raw_payload->'Killer'->>'GuildName'), '')) AS guild_name,
          (ke.occurred_at AT TIME ZONE 'UTC')::date AS utc_date,
          EXTRACT(HOUR FROM ke.occurred_at AT TIME ZONE 'UTC')::int AS utc_hour,
          ke.content_type,
          COUNT(*)::int AS kills,
          COALESCE(SUM(ke.total_victim_kill_fame), 0)::bigint AS fame
        FROM kill_events ke, bounds
        WHERE ke.occurred_at >= NOW() - INTERVAL '30 days'
          AND NULLIF(TRIM(ke.raw_payload->'Killer'->>'GuildId'), '') IS NOT NULL
        GROUP BY 1, 2, 4, 5, 6
      ),
      death_agg AS (
        SELECT
          ke.region,
          ke.raw_payload->'Victim'->>'GuildId' AS guild_albion_id,
          MAX(NULLIF(TRIM(ke.raw_payload->'Victim'->>'GuildName'), '')) AS guild_name,
          (ke.occurred_at AT TIME ZONE 'UTC')::date AS utc_date,
          EXTRACT(HOUR FROM ke.occurred_at AT TIME ZONE 'UTC')::int AS utc_hour,
          ke.content_type,
          COUNT(*)::int AS deaths
        FROM kill_events ke, bounds
        WHERE ke.occurred_at >= NOW() - INTERVAL '30 days'
          AND NULLIF(TRIM(ke.raw_payload->'Victim'->>'GuildId'), '') IS NOT NULL
        GROUP BY 1, 2, 4, 5, 6
      ),
      unique_agg AS (
        SELECT
          region,
          guild_albion_id,
          utc_date,
          utc_hour,
          content_type,
          COUNT(*)::int AS unique_players
        FROM guild_hour_players, bounds
        WHERE utc_date >= bounds.cutoff
        GROUP BY 1, 2, 3, 4, 5
      ),
      keys AS (
        SELECT region, guild_albion_id, utc_date, utc_hour, content_type FROM kill_agg
        UNION
        SELECT region, guild_albion_id, utc_date, utc_hour, content_type FROM death_agg
        UNION
        SELECT region, guild_albion_id, utc_date, utc_hour, content_type FROM unique_agg
      )
      INSERT INTO guild_hour_stats (
        region, guild_albion_id, guild_name, utc_date, utc_hour, content_type,
        unique_players, kills, deaths, fame
      )
      SELECT
        k.region,
        k.guild_albion_id,
        COALESCE(NULLIF(TRIM(ki.guild_name), ''), NULLIF(TRIM(d.guild_name), ''), k.guild_albion_id),
        k.utc_date,
        k.utc_hour,
        k.content_type,
        COALESCE(u.unique_players, 0),
        COALESCE(ki.kills, 0),
        COALESCE(d.deaths, 0),
        COALESCE(ki.fame, 0)
      FROM keys k
      LEFT JOIN kill_agg ki
        ON ki.region = k.region
        AND ki.guild_albion_id = k.guild_albion_id
        AND ki.utc_date = k.utc_date
        AND ki.utc_hour = k.utc_hour
        AND ki.content_type = k.content_type
      LEFT JOIN death_agg d
        ON d.region = k.region
        AND d.guild_albion_id = k.guild_albion_id
        AND d.utc_date = k.utc_date
        AND d.utc_hour = k.utc_hour
        AND d.content_type = k.content_type
      LEFT JOIN unique_agg u
        ON u.region = k.region
        AND u.guild_albion_id = k.guild_albion_id
        AND u.utc_date = k.utc_date
        AND u.utc_hour = k.utc_hour
        AND u.content_type = k.content_type
      ON CONFLICT (region, guild_albion_id, utc_date, utc_hour, content_type)
      DO UPDATE SET
        guild_name = EXCLUDED.guild_name,
        unique_players = EXCLUDED.unique_players,
        kills = EXCLUDED.kills,
        deaths = EXCLUDED.deaths,
        fame = EXCLUDED.fame
    `);
    console.log("guild_hour_stats backfill complete.");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
