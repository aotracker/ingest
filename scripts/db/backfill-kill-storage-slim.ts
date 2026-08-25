/**
 * Backfill slim kill storage on existing full-detail rows.
 *
 * Usage:
 *   npm run db:backfill-kill-storage [--dry-run] [--batch=N] [--phase=all|cols|null-payload|slim-events]
 *
 * Phases:
 *   cols          — copy GuildId / AllianceId / AllianceTag into columns (only when payload has a value)
 *   null-payload  — null all remaining participant raw_payload (builds read kill_items)
 *   slim-events   — rewrite kill_events.raw_payload to slim form
 *   all           — run phases in order (default)
 *
 * Resume after Ctrl-C:
 *   npm run db:backfill-kill-storage -- --phase=null-payload --batch=20000
 *   npm run db:backfill-kill-storage -- --phase=slim-events --batch=1000
 */
import postgres from "postgres";
import { slimKillEventPayload } from "../../src/lib/albion/slim-kill-event";
import type { AlbionEvent } from "../../src/lib/albion/types";

type Phase = "all" | "cols" | "null-payload" | "slim-events";

function parsePhase(): Phase {
  const arg = process.argv.find((a) => a.startsWith("--phase="));
  if (!arg) return "all";
  const value = arg.slice("--phase=".length) as Phase;
  if (
    value === "all" ||
    value === "cols" ||
    value === "null-payload" ||
    value === "slim-events"
  ) {
    return value;
  }
  throw new Error(
    `Invalid --phase=${arg}. Use all|cols|null-payload|slim-events`
  );
}

/** Defaults sized for prod: null-payload was ~30s+/500 with EXISTS join — too slow. */
function parseBatch(phase: Phase): number {
  const arg = process.argv.find((a) => a.startsWith("--batch="));
  if (arg) {
    return Math.max(1, parseInt(arg.slice("--batch=".length), 10) || 500);
  }
  if (phase === "null-payload") return 20_000;
  if (phase === "slim-events") return 1_000;
  if (phase === "cols") return 5_000;
  return 5_000;
}

function shouldRun(phase: Phase, target: Exclude<Phase, "all">): boolean {
  return phase === "all" || phase === target;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const dryRun = process.argv.includes("--dry-run");
  const phase = parsePhase();
  const batch = parseBatch(phase);
  const prefix = "[db:backfill-kill-storage]";
  const sql = postgres(url, { max: 1 });

  try {
    await sql.unsafe(`SET statement_timeout = 0`);
    console.log(
      `${prefix} Starting${dryRun ? " (dry-run)" : ""} — phase=${phase}, batch=${batch}`
    );

    let participantCols = 0;
    if (shouldRun(phase, "cols")) {
      for (;;) {
        if (dryRun) {
          const [{ count }] = await sql<{ count: number }[]>`
            SELECT COUNT(*)::int AS count
            FROM kill_participants
            WHERE raw_payload IS NOT NULL
              AND (
                (
                  guild_albion_id IS NULL
                  AND NULLIF(BTRIM(raw_payload->>'GuildId'), '') IS NOT NULL
                )
                OR (
                  alliance_id IS NULL
                  AND NULLIF(BTRIM(raw_payload->>'AllianceId'), '') IS NOT NULL
                )
                OR (
                  alliance_tag IS NULL
                  AND NULLIF(BTRIM(raw_payload->>'AllianceTag'), '') IS NOT NULL
                )
              )
          `;
          participantCols = count;
          console.log(
            `${prefix} would backfill participant cols for ${count} row(s)`
          );
          break;
        }

        const updated = await sql`
          WITH batch AS (
            SELECT id
            FROM kill_participants
            WHERE raw_payload IS NOT NULL
              AND (
                (
                  guild_albion_id IS NULL
                  AND NULLIF(BTRIM(raw_payload->>'GuildId'), '') IS NOT NULL
                )
                OR (
                  alliance_id IS NULL
                  AND NULLIF(BTRIM(raw_payload->>'AllianceId'), '') IS NOT NULL
                )
                OR (
                  alliance_tag IS NULL
                  AND NULLIF(BTRIM(raw_payload->>'AllianceTag'), '') IS NOT NULL
                )
              )
            LIMIT ${batch}
          )
          UPDATE kill_participants kp
          SET
            guild_albion_id = COALESCE(
              kp.guild_albion_id,
              NULLIF(BTRIM(kp.raw_payload->>'GuildId'), '')
            ),
            alliance_id = COALESCE(
              kp.alliance_id,
              NULLIF(BTRIM(kp.raw_payload->>'AllianceId'), '')
            ),
            alliance_tag = COALESCE(
              kp.alliance_tag,
              NULLIF(BTRIM(kp.raw_payload->>'AllianceTag'), '')
            )
          FROM batch
          WHERE kp.id = batch.id
          RETURNING kp.id
        `;
        if (updated.count === 0) break;
        participantCols += updated.count;
        console.log(
          `${prefix} participant cols batch: ${updated.count} (total ${participantCols})`
        );
      }
    } else {
      console.log(`${prefix} Skipping cols phase`);
    }

    let nulledParticipantPayload = 0;
    if (shouldRun(phase, "null-payload")) {
      // No EXISTS join — that was ~1 batch/min on prod. Builds prefer kill_items;
      // dual-source fallback only matters until this phase finishes.
      for (;;) {
        if (dryRun) {
          const [{ count }] = await sql<{ count: number }[]>`
            SELECT COUNT(*)::int AS count
            FROM kill_participants
            WHERE raw_payload IS NOT NULL
          `;
          nulledParticipantPayload = count;
          console.log(
            `${prefix} would null participant raw_payload for ${count} row(s)`
          );
          break;
        }

        const updated = await sql`
          WITH batch AS (
            SELECT id
            FROM kill_participants
            WHERE raw_payload IS NOT NULL
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
    } else {
      console.log(`${prefix} Skipping null-payload phase`);
    }

    let slimmedEvents = 0;
    if (shouldRun(phase, "slim-events")) {
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
    } else {
      console.log(`${prefix} Skipping slim-events phase`);
    }

    console.log(
      dryRun
        ? `${prefix} Dry run complete — would backfill participant cols (${participantCols}), null participant JSONB (${nulledParticipantPayload}), slim events (${slimmedEvents}). Re-run without --dry-run to apply.`
        : `${prefix} Done — participant cols ${participantCols}, nulled participant JSONB (${nulledParticipantPayload}), slim events (${slimmedEvents}). Run VACUUM ANALYZE on kill_events, kill_participants, kill_items when convenient.`
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[db:backfill-kill-storage] Failed:", err);
  process.exit(1);
});
