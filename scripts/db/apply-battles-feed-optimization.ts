/**
 * Battles feed: slim feed_preview column + partial start_time index.
 * Backfills preview JSON from existing payloads so list queries can skip TOAST.
 * Usage: npm run db:apply-battles-feed-optimization (from ingest/, OVH VM or local)
 */
import postgres from "postgres";

const BACKFILL_BATCH = 200;

type NamedStat = { id?: string; name?: string; killFame?: number; kills?: number };

function sortByFame(items: NamedStat[]): NamedStat[] {
  return [...items].sort(
    (a, b) => (b.killFame ?? 0) - (a.killFame ?? 0) || (b.kills ?? 0) - (a.kills ?? 0)
  );
}

function buildPreview(rawPayload: unknown, detailPayload: unknown) {
  const limit = 24;
  const detail =
    detailPayload && typeof detailPayload === "object"
      ? (detailPayload as { alliances?: NamedStat[]; guilds?: NamedStat[] })
      : null;

  let alliances: NamedStat[] = [];
  let guilds: NamedStat[] = [];

  if (Array.isArray(detail?.alliances) && Array.isArray(detail?.guilds)) {
    alliances = detail.alliances;
    guilds = detail.guilds;
  } else if (rawPayload && typeof rawPayload === "object") {
    const battle = rawPayload as {
      alliances?: Record<string, NamedStat>;
      guilds?: Record<string, NamedStat>;
    };
    alliances = battle.alliances ? Object.values(battle.alliances) : [];
    guilds = battle.guilds ? Object.values(battle.guilds) : [];
  }

  const sortedAlliances = sortByFame(alliances);
  const sortedGuilds = sortByFame(guilds);
  return {
    alliances: sortedAlliances
      .slice(0, limit)
      .map((a) => ({ id: String(a.id ?? ""), name: a.name ?? "" }))
      .filter((a) => a.id && a.name),
    guilds: sortedGuilds
      .slice(0, limit)
      .map((g) => ({ id: String(g.id ?? ""), name: g.name ?? "" }))
      .filter((g) => g.id && g.name),
    allianceCount: sortedAlliances.length,
    guildCount: sortedGuilds.length,
  };
}

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

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`
      ALTER TABLE "battles" ADD COLUMN IF NOT EXISTS "feed_preview" jsonb
    `);
    console.log("battles.feed_preview column ready.");

    let backfilled = 0;
    for (;;) {
      const rows = await sql<
        { id: string; raw_payload: unknown; detail_payload: unknown }[]
      >`
        SELECT id, raw_payload, detail_payload
        FROM battles
        WHERE feed_preview IS NULL
          AND (raw_payload IS NOT NULL OR detail_payload IS NOT NULL)
        LIMIT ${BACKFILL_BATCH}
      `;
      if (rows.length === 0) break;

      for (const row of rows) {
        const preview = buildPreview(row.raw_payload, row.detail_payload);
        await sql`
          UPDATE battles
          SET feed_preview = ${preview as never}
          WHERE id = ${row.id}
        `;
      }
      backfilled += rows.length;
      console.log(`feed_preview backfill: ${backfilled} rows`);
    }

    await createIndex(
      sql,
      `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "battles_feed_start_time_idx"
        ON "battles" ("start_time" DESC NULLS LAST, "created_at" DESC)
        WHERE "total_fame" IS NOT NULL
          AND "total_kills" IS NOT NULL
          AND "total_players" >= 10
      `
    );
    console.log("battles_feed_start_time_idx applied.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
