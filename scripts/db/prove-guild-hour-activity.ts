/**
 * Validate hour-bucket guild activity SQL and log ingest coverage.
 * Usage: npm run db:prove-guild-hour-activity
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    const prove = await sql.unsafe(`
      SELECT
        kp.raw_payload->>'GuildId' AS guild_id,
        kp.guild_name,
        extract(hour from ke.occurred_at at time zone 'UTC')::int AS utc_hour,
        count(distinct kp.player_id)::int AS unique_members,
        count(*) FILTER (WHERE kp.role = 'killer')::int AS kills,
        count(*) FILTER (WHERE kp.role = 'victim')::int AS deaths,
        coalesce(sum(ke.total_victim_kill_fame) FILTER (WHERE kp.role = 'killer'), 0)::bigint AS fame
      FROM kill_events ke
      JOIN kill_participants kp ON kp.event_id = ke.id
      WHERE ke.region = 'europe'
        AND ke.occurred_at >= now() - interval '14 days'
        AND nullif(trim(kp.raw_payload->>'GuildId'), '') IS NOT NULL
      GROUP BY 1, 2, 3
      ORDER BY unique_members DESC, fame DESC
      LIMIT 8
    `);
    console.log("PROVE_HOUR_BUCKET");
    console.log(prove);

    const sync = await sql.unsafe(`
      SELECT region, events_ingested_last_hour, last_ingest_at
      FROM api_sync_state
      ORDER BY region
    `);
    console.log("SYNC_STATE");
    console.log(sync);

    const last25 = await sql.unsafe(`
      SELECT region, count(*)::int AS events
      FROM kill_events
      WHERE occurred_at >= now() - interval '25 minutes'
      GROUP BY region
      ORDER BY region
    `);
    console.log("LAST_25_MIN");
    console.log(last25);

    const hourly = await sql.unsafe(`
      SELECT
        region,
        date_trunc('hour', occurred_at AT TIME ZONE 'UTC') AS utc_hour,
        count(*)::int AS events
      FROM kill_events
      WHERE occurred_at >= now() - interval '6 hours'
      GROUP BY 1, 2
      ORDER BY utc_hour DESC, region
    `);
    console.log("HOURLY_6H");
    console.log(hourly);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
