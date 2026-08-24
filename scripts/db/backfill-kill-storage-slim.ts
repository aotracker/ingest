/**
 * Backfill slim kill storage on existing full-detail rows.
 * Usage: npm run db:backfill-kill-storage [--dry-run] [--batch=500]
 */
import postgres from "postgres";
import { slimKillEventPayload } from "../../src/lib/albion/slim-kill-event";
import type { AlbionEvent } from "../../src/lib/albion/types";

function parseBatch(): number {
  const arg = process.argv.find((a) => a.startsWith("--batch="));
  if (!arg) return 500;
  return Math.max(1, parseInt(arg.slice("--batch=".length), 10) || 500);
}

function trimOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const dryRun = process.argv.includes("--dry-run");
  const batch = parseBatch();
  const prefix = "[db:backfill-kill-storage]";
  const sql = postgres(url, { max: 1 });

  try {
    await sql.unsafe(`SET statement_timeout = 0`);

    let participantCols = 0;
    for (;;) {
      const rows = await sql<{ id: string; raw_payload: Record<string, unknown> | null }[]>`
        SELECT id, raw_payload
        FROM kill_participants
        WHERE raw_payload IS NOT NULL
          AND (
            guild_albion_id IS NULL
            OR alliance_id IS NULL
            OR alliance_tag IS NULL
          )
        LIMIT ${batch}
      `;
      if (rows.length === 0) break;

      if (!dryRun) {
        for (const row of rows) {
          const payload = row.raw_payload;
          if (!payload) continue;
          await sql`
            UPDATE kill_participants
            SET
              guild_albion_id = COALESCE(guild_albion_id, ${trimOrNull(payload.GuildId)}),
              alliance_id = COALESCE(alliance_id, ${trimOrNull(payload.AllianceId)}),
              alliance_tag = COALESCE(alliance_tag, ${trimOrNull(payload.AllianceTag)})
            WHERE id = ${row.id}
          `;
        }
      }
      participantCols += rows.length;
      console.log(
        `${prefix} participant cols batch: ${rows.length} (total ${participantCols})`
      );
      if (dryRun) break;
    }

    let nulledParticipantPayload = 0;
    for (;;) {
      if (dryRun) {
        const [{ count }] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM kill_participants kp
          WHERE kp.raw_payload IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM kill_items ki
              WHERE ki.event_id = kp.event_id
                AND ki.owner_role = kp.role
                AND ki.category = 'equipment'
            )
        `;
        nulledParticipantPayload = count;
        console.log(
          `${prefix} would null participant raw_payload for ${count} row(s)`
        );
        break;
      }

      const updated = await sql`
        WITH batch AS (
          SELECT kp.id
          FROM kill_participants kp
          WHERE kp.raw_payload IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM kill_items ki
              WHERE ki.event_id = kp.event_id
                AND ki.owner_role = kp.role
                AND ki.category = 'equipment'
            )
          LIMIT ${batch}
        )
        UPDATE kill_participants kp
        SET raw_payload = NULL
        FROM batch
        WHERE kp.id = batch.id
        RETURNING kp.id
      `;
      if (updated.count === 0) break;
      nulledParticipantPayload += updated.count;
      console.log(
        `${prefix} nulled participant raw_payload batch: ${updated.count} (total ${nulledParticipantPayload})`
      );
    }

    let slimmedEvents = 0;
    for (;;) {
      const rows = await sql<{ id: string; raw_payload: AlbionEvent }[]>`
        SELECT id, raw_payload
        FROM kill_events
        WHERE detail_evicted_at IS NULL
          AND raw_payload IS NOT NULL
          AND (
            raw_payload ? 'GroupMembers'
            OR raw_payload ? 'Participants'
            OR raw_payload->'Killer' ? 'Equipment'
            OR raw_payload->'Killer' ? 'Inventory'
            OR raw_payload->'Victim' ? 'Equipment'
            OR raw_payload->'Victim' ? 'Inventory'
          )
        LIMIT ${batch}
      `;
      if (rows.length === 0) break;

      if (!dryRun) {
        for (const row of rows) {
          const slim = slimKillEventPayload(row.raw_payload);
          await sql`
            UPDATE kill_events
            SET raw_payload = ${sql.json(slim as unknown as postgres.JSONValue)}
            WHERE id = ${row.id}
          `;
        }
      }
      slimmedEvents += rows.length;
      console.log(
        `${prefix} slim event payload batch: ${rows.length} (total ${slimmedEvents})`
      );
      if (dryRun) break;
    }

    console.log(
      dryRun
        ? `${prefix} Dry run complete — would backfill participant cols (${participantCols}), null participant JSONB (${nulledParticipantPayload}), slim events (${slimmedEvents}). Re-run without --dry-run to apply.`
        : `${prefix} Done — participant cols ${participantCols}, nulled participant JSONB ${nulledParticipantPayload}, slim events ${slimmedEvents}. Run VACUUM ANALYZE on kill_events, kill_participants, kill_items when convenient.`
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[db:backfill-kill-storage] Failed:", err);
  process.exit(1);
});
