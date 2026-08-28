/**
 * Denormalize victim alliance onto kill_events and backfill from payload /
 * participant rows so alliance feud avoids JSONB filters.
 * Usage: npm run db:apply-kill-victim-alliance-columns (from ingest/, OVH VM or local)
 */
import { withDatabaseUrl } from "./with-database-url";

const BACKFILL_BATCH = 2000;

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      ALTER TABLE "kill_events" ADD COLUMN IF NOT EXISTS "victim_alliance_albion_id" text;
      ALTER TABLE "kill_events" ADD COLUMN IF NOT EXISTS "victim_alliance_name" text
    `);
    console.log("kill_events victim alliance columns ready.");

    let payloadBackfilled = 0;
    for (;;) {
      const updated = await sql.unsafe(`
        WITH batch AS (
          SELECT id
          FROM kill_events
          WHERE raw_payload IS NOT NULL
            AND (
              (
                victim_alliance_name IS NULL
                AND NULLIF(BTRIM(raw_payload->'Victim'->>'AllianceName'), '') IS NOT NULL
              )
              OR (
                victim_alliance_albion_id IS NULL
                AND NULLIF(BTRIM(raw_payload->'Victim'->>'AllianceId'), '') IS NOT NULL
              )
            )
          LIMIT ${BACKFILL_BATCH}
        )
        UPDATE kill_events ke
        SET
          victim_alliance_albion_id = COALESCE(
            ke.victim_alliance_albion_id,
            NULLIF(BTRIM(ke.raw_payload->'Victim'->>'AllianceId'), '')
          ),
          victim_alliance_name = COALESCE(
            ke.victim_alliance_name,
            NULLIF(BTRIM(ke.raw_payload->'Victim'->>'AllianceName'), '')
          )
        FROM batch
        WHERE ke.id = batch.id
        RETURNING ke.id
      `);
      const count = updated.length;
      if (count === 0) break;
      payloadBackfilled += count;
      console.log(`victim alliance payload backfill: ${payloadBackfilled} rows`);
    }

    let participantBackfilled = 0;
    for (;;) {
      const updated = await sql.unsafe(`
        WITH batch AS (
          SELECT ke.id
          FROM kill_events ke
          JOIN kill_participants kp
            ON kp.event_id = ke.id AND kp.role = 'victim'
          WHERE (
              (
                ke.victim_alliance_name IS NULL
                AND NULLIF(BTRIM(kp.raw_payload->>'AllianceName'), '') IS NOT NULL
              )
              OR (
                ke.victim_alliance_albion_id IS NULL
                AND NULLIF(BTRIM(kp.raw_payload->>'AllianceId'), '') IS NOT NULL
              )
            )
          LIMIT ${BACKFILL_BATCH}
        )
        UPDATE kill_events ke
        SET
          victim_alliance_albion_id = COALESCE(
            ke.victim_alliance_albion_id,
            NULLIF(BTRIM(kp.raw_payload->>'AllianceId'), '')
          ),
          victim_alliance_name = COALESCE(
            ke.victim_alliance_name,
            NULLIF(BTRIM(kp.raw_payload->>'AllianceName'), '')
          )
        FROM batch
        JOIN kill_participants kp
          ON kp.event_id = batch.id AND kp.role = 'victim'
        WHERE ke.id = batch.id
        RETURNING ke.id
      `);
      const count = updated.length;
      if (count === 0) break;
      participantBackfilled += count;
      console.log(
        `victim alliance participant backfill: ${participantBackfilled} rows`
      );
    }
  }, { endTimeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
