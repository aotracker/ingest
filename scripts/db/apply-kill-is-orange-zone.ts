/**
 * Add is_orange_zone on kill_events, backfill unlabeled rows from stored
 * loadouts, then add the public-feed partial index (fame > 0 AND not orange).
 * Safe to re-run after classifier changes — only sets currently-false rows.
 *
 * Usage (from ingest/, OVH VM or local):
 *   npm run db:apply-kill-is-orange-zone
 */
import postgres from "postgres";
import {
  isOrangeZoneKill,
  playerRefFromLoadout,
} from "../../src/lib/albion/orange-zone";
import { withDatabaseUrl } from "./with-database-url";

const BATCH_SIZE = 200;

async function createIndex(sql: postgres.Sql, statement: string) {
  try {
    await sql.unsafe(statement);
  } catch (err) {
    const msg = String(err);
    if (/concurrently/i.test(msg) && /transaction/i.test(msg)) {
      await sql.unsafe(statement.replace(/CONCURRENTLY\s+/i, ""));
      return;
    }
    throw err;
  }
}

type EventRow = {
  id: string;
  total_victim_kill_fame: number | null;
  loot_est_silver: number | null;
  gear_est_silver: number | null;
};

type ItemRow = {
  event_id: string;
  owner_role: string;
  category: string;
  slot: string | null;
  item_type: string | null;
  quality: number | null;
};

type ParticipantRow = {
  event_id: string;
  role: string;
  average_item_power: string | null;
};

function classifyRow(
  event: EventRow,
  items: ItemRow[],
  participants: ParticipantRow[]
): boolean {
  const loadoutItems = items.map((item) => ({
    ownerRole: item.owner_role,
    category: item.category,
    slot: item.slot,
    itemType: item.item_type,
    quality: item.quality,
  }));
  const killerIp = participants.find((row) => row.role === "killer");
  const victimIp = participants.find((row) => row.role === "victim");
  return isOrangeZoneKill({
    totalVictimKillFame: event.total_victim_kill_fame,
    lootEstSilver: event.loot_est_silver,
    gearEstSilver: event.gear_est_silver,
    killer: playerRefFromLoadout({
      averageItemPower: killerIp?.average_item_power,
      items: loadoutItems,
      ownerRole: "killer",
    }),
    victim: playerRefFromLoadout({
      averageItemPower: victimIp?.average_item_power,
      items: loadoutItems,
      ownerRole: "victim",
    }),
  });
}

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`SET statement_timeout = 0`);
    await sql.unsafe(`
      ALTER TABLE "kill_events"
        ADD COLUMN IF NOT EXISTS "is_orange_zone" boolean DEFAULT false NOT NULL
    `);
    console.log("kill_events.is_orange_zone ready. Backfilling…");

    let scanned = 0;
    let updated = 0;
    let lastId: string | null = null;

    for (;;) {
      const events: EventRow[] = lastId
        ? await sql<EventRow[]>`
            SELECT id, total_victim_kill_fame, loot_est_silver, gear_est_silver
            FROM kill_events
            WHERE is_orange_zone = false
              AND id > ${lastId}::uuid
            ORDER BY id
            LIMIT ${BATCH_SIZE}
          `
        : await sql<EventRow[]>`
            SELECT id, total_victim_kill_fame, loot_est_silver, gear_est_silver
            FROM kill_events
            WHERE is_orange_zone = false
            ORDER BY id
            LIMIT ${BATCH_SIZE}
          `;
      if (events.length === 0) break;

      const ids = events.map((row) => row.id);
      const items = await sql<ItemRow[]>`
        SELECT event_id, owner_role, category, slot, item_type, quality
        FROM kill_items
        WHERE event_id = ANY(${ids}::uuid[])
          AND category = 'equipment'
          AND owner_role IN ('killer', 'victim')
      `;
      const participants = await sql<ParticipantRow[]>`
        SELECT event_id, role, average_item_power
        FROM kill_participants
        WHERE event_id = ANY(${ids}::uuid[])
          AND role IN ('killer', 'victim')
      `;

      const itemsByEvent = new Map<string, ItemRow[]>();
      for (const item of items) {
        const list = itemsByEvent.get(item.event_id) ?? [];
        list.push(item);
        itemsByEvent.set(item.event_id, list);
      }
      const partsByEvent = new Map<string, ParticipantRow[]>();
      for (const part of participants) {
        const list = partsByEvent.get(part.event_id) ?? [];
        list.push(part);
        partsByEvent.set(part.event_id, list);
      }

      const orangeIds: string[] = [];
      for (const event of events) {
        if (
          classifyRow(
            event,
            itemsByEvent.get(event.id) ?? [],
            partsByEvent.get(event.id) ?? []
          )
        ) {
          orangeIds.push(event.id);
        }
      }

      if (orangeIds.length > 0) {
        await sql`
          UPDATE kill_events
          SET is_orange_zone = true
          WHERE id = ANY(${orangeIds}::uuid[])
        `;
        updated += orangeIds.length;
      }

      lastId = events[events.length - 1]!.id;
      scanned += events.length;
      if (scanned % 2000 === 0 || events.length < BATCH_SIZE) {
        console.log(
          `orange-zone backfill: scanned=${scanned} labeled=${updated}`
        );
      }
    }

    console.log(`orange-zone backfill done: labeled ${updated} / ${scanned}`);

    await createIndex(
      sql,
      `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "kill_events_region_occurred_lethal_idx"
        ON "kill_events" ("region", "occurred_at")
        WHERE "total_victim_kill_fame" > 0 AND "is_orange_zone" = false
      `
    );
    console.log("kill_events_region_occurred_lethal_idx applied.");
  }, { endTimeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
