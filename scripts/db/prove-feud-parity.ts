/**
 * Compare legacy participant-join feud queries vs denormalized column queries.
 * Usage (from ingest/, OVH VM):
 *   FEUD_REGION=americas FEUD_GUILD_A="Guild A" FEUD_GUILD_B="Guild B" \
 *     FEUD_GUILD_A_ID=... FEUD_GUILD_B_ID=... npm run db:prove-feud-parity
 *
 * Optional alliance pair:
 *   FEUD_ALLIANCE_A=... FEUD_ALLIANCE_B=...
 */
import postgres from "postgres";

type GuildPair = {
  region: string;
  nameA: string;
  nameB: string;
  idA: string | null;
  idB: string | null;
};

type AlliancePair = {
  region: string;
  idA: string;
  idB: string;
};

function parseGuildPairs(): GuildPair[] {
  const region = process.env.FEUD_REGION?.trim();
  const nameA = process.env.FEUD_GUILD_A?.trim();
  const nameB = process.env.FEUD_GUILD_B?.trim();
  if (region && nameA && nameB) {
    return [
      {
        region,
        nameA,
        nameB,
        idA: process.env.FEUD_GUILD_A_ID?.trim() || null,
        idB: process.env.FEUD_GUILD_B_ID?.trim() || null,
      },
    ];
  }
  return [];
}

function parseAlliancePairs(): AlliancePair[] {
  const region = process.env.FEUD_REGION?.trim() || "americas";
  const idA = process.env.FEUD_ALLIANCE_A?.trim();
  const idB = process.env.FEUD_ALLIANCE_B?.trim();
  if (idA && idB) return [{ region, idA, idB }];
  return [];
}

async function discoverGuildPair(sql: postgres.Sql): Promise<GuildPair | null> {
  const rows = await sql<
    {
      region: string;
      killer_guild_albion_id: string;
      victim_guild_albion_id: string;
      killer_guild_name: string;
      victim_guild_name: string;
    }[]
  >`
    SELECT region,
           killer_guild_albion_id,
           victim_guild_albion_id,
           killer_guild_name,
           victim_guild_name
    FROM kill_events
    WHERE total_victim_kill_fame > 0
      AND killer_guild_albion_id IS NOT NULL
      AND victim_guild_albion_id IS NOT NULL
      AND killer_guild_name IS NOT NULL
      AND victim_guild_name IS NOT NULL
      AND killer_guild_albion_id <> victim_guild_albion_id
    ORDER BY occurred_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    region: row.region,
    nameA: row.killer_guild_name,
    nameB: row.victim_guild_name,
    idA: row.killer_guild_albion_id,
    idB: row.victim_guild_albion_id,
  };
}

async function oldGuildKillIds(
  sql: postgres.Sql,
  pair: GuildPair,
  limit: number
): Promise<number[]> {
  const nameA = pair.nameA.trim().toLowerCase();
  const nameB = pair.nameB.trim().toLowerCase();
  const rows = await sql<{ event_id: number }[]>`
    SELECT ke.event_id
    FROM kill_events ke
    INNER JOIN kill_participants fk
      ON fk.event_id = ke.id AND fk.role = 'killer'
    INNER JOIN kill_participants fv
      ON fv.event_id = ke.id AND fv.role = 'victim'
    WHERE ke.region = ${pair.region}
      AND ke.total_victim_kill_fame > 0
      AND (
        (lower(trim(fk.guild_name)) = ${nameA} AND lower(trim(fv.guild_name)) = ${nameB})
        OR
        (lower(trim(fk.guild_name)) = ${nameB} AND lower(trim(fv.guild_name)) = ${nameA})
      )
    ORDER BY ke.occurred_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.event_id).sort((a, b) => a - b);
}

async function newGuildKillIds(
  sql: postgres.Sql,
  pair: GuildPair,
  limit: number
): Promise<number[]> {
  const nameA = pair.nameA.trim().toLowerCase();
  const nameB = pair.nameB.trim().toLowerCase();
  const rows =
    pair.idA && pair.idB
      ? await sql<{ event_id: number }[]>`
          SELECT event_id
          FROM kill_events
          WHERE region = ${pair.region}
            AND total_victim_kill_fame > 0
            AND (
              (killer_guild_albion_id = ${pair.idA} AND victim_guild_albion_id = ${pair.idB})
              OR
              (killer_guild_albion_id = ${pair.idB} AND victim_guild_albion_id = ${pair.idA})
            )
          ORDER BY occurred_at DESC
          LIMIT ${limit}
        `
      : await sql<{ event_id: number }[]>`
          SELECT event_id
          FROM kill_events
          WHERE region = ${pair.region}
            AND total_victim_kill_fame > 0
            AND (
              (lower(trim(killer_guild_name)) = ${nameA} AND lower(trim(victim_guild_name)) = ${nameB})
              OR
              (lower(trim(killer_guild_name)) = ${nameB} AND lower(trim(victim_guild_name)) = ${nameA})
            )
          ORDER BY occurred_at DESC
          LIMIT ${limit}
        `;
  return rows.map((r) => r.event_id).sort((a, b) => a - b);
}

async function oldGuildStats(sql: postgres.Sql, pair: GuildPair) {
  const nameA = pair.nameA.trim().toLowerCase();
  const nameB = pair.nameB.trim().toLowerCase();
  const [aKillsB] = await sql<{ count: string; fame: string | null }[]>`
    SELECT count(*)::text AS count, sum(ke.total_victim_kill_fame)::text AS fame
    FROM kill_events ke
    INNER JOIN kill_participants fk ON fk.event_id = ke.id AND fk.role = 'killer'
    INNER JOIN kill_participants fv ON fv.event_id = ke.id AND fv.role = 'victim'
    WHERE ke.region = ${pair.region}
      AND ke.total_victim_kill_fame > 0
      AND lower(trim(fk.guild_name)) = ${nameA}
      AND lower(trim(fv.guild_name)) = ${nameB}
  `;
  const [bKillsA] = await sql<{ count: string; fame: string | null }[]>`
    SELECT count(*)::text AS count, sum(ke.total_victim_kill_fame)::text AS fame
    FROM kill_events ke
    INNER JOIN kill_participants fk ON fk.event_id = ke.id AND fk.role = 'killer'
    INNER JOIN kill_participants fv ON fv.event_id = ke.id AND fv.role = 'victim'
    WHERE ke.region = ${pair.region}
      AND ke.total_victim_kill_fame > 0
      AND lower(trim(fk.guild_name)) = ${nameB}
      AND lower(trim(fv.guild_name)) = ${nameA}
  `;
  return {
    aKillsB: Number(aKillsB?.count ?? 0),
    bKillsA: Number(bKillsA?.count ?? 0),
    aFameOnB: Number(aKillsB?.fame ?? 0),
    bFameOnA: Number(bKillsA?.fame ?? 0),
  };
}

async function newGuildStats(sql: postgres.Sql, pair: GuildPair) {
  const nameA = pair.nameA.trim().toLowerCase();
  const nameB = pair.nameB.trim().toLowerCase();
  const [aKillsB] =
    pair.idA && pair.idB
      ? await sql<{ count: string; fame: string | null }[]>`
          SELECT count(*)::text AS count, sum(total_victim_kill_fame)::text AS fame
          FROM kill_events
          WHERE region = ${pair.region}
            AND total_victim_kill_fame > 0
            AND killer_guild_albion_id = ${pair.idA}
            AND victim_guild_albion_id = ${pair.idB}
        `
      : await sql<{ count: string; fame: string | null }[]>`
          SELECT count(*)::text AS count, sum(total_victim_kill_fame)::text AS fame
          FROM kill_events
          WHERE region = ${pair.region}
            AND total_victim_kill_fame > 0
            AND lower(trim(killer_guild_name)) = ${nameA}
            AND lower(trim(victim_guild_name)) = ${nameB}
        `;
  const [bKillsA] =
    pair.idA && pair.idB
      ? await sql<{ count: string; fame: string | null }[]>`
          SELECT count(*)::text AS count, sum(total_victim_kill_fame)::text AS fame
          FROM kill_events
          WHERE region = ${pair.region}
            AND total_victim_kill_fame > 0
            AND killer_guild_albion_id = ${pair.idB}
            AND victim_guild_albion_id = ${pair.idA}
        `
      : await sql<{ count: string; fame: string | null }[]>`
          SELECT count(*)::text AS count, sum(total_victim_kill_fame)::text AS fame
          FROM kill_events
          WHERE region = ${pair.region}
            AND total_victim_kill_fame > 0
            AND lower(trim(killer_guild_name)) = ${nameB}
            AND lower(trim(victim_guild_name)) = ${nameA}
        `;
  return {
    aKillsB: Number(aKillsB?.count ?? 0),
    bKillsA: Number(bKillsA?.count ?? 0),
    aFameOnB: Number(aKillsB?.fame ?? 0),
    bFameOnA: Number(bKillsA?.fame ?? 0),
  };
}

async function oldAllianceKillIds(
  sql: postgres.Sql,
  pair: AlliancePair,
  limit: number
): Promise<number[]> {
  const rows = await sql<{ event_id: number }[]>`
    SELECT event_id
    FROM kill_events
    WHERE region = ${pair.region}
      AND total_victim_kill_fame > 0
      AND (
        (killer_alliance_albion_id = ${pair.idA} AND raw_payload->'Victim'->>'AllianceId' = ${pair.idB})
        OR
        (killer_alliance_albion_id = ${pair.idB} AND raw_payload->'Victim'->>'AllianceId' = ${pair.idA})
      )
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.event_id).sort((a, b) => a - b);
}

async function newAllianceKillIds(
  sql: postgres.Sql,
  pair: AlliancePair,
  limit: number
): Promise<number[]> {
  const rows = await sql<{ event_id: number }[]>`
    SELECT event_id
    FROM kill_events
    WHERE region = ${pair.region}
      AND total_victim_kill_fame > 0
      AND (
        (killer_alliance_albion_id = ${pair.idA} AND victim_alliance_albion_id = ${pair.idB})
        OR
        (killer_alliance_albion_id = ${pair.idB} AND victim_alliance_albion_id = ${pair.idA})
      )
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.event_id).sort((a, b) => a - b);
}

function sameArray(a: number[], b: number[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  let failed = false;

  try {
    const guildPairs = parseGuildPairs();
    if (guildPairs.length === 0) {
      const discovered = await discoverGuildPair(sql);
      if (!discovered) {
        throw new Error("No guild pair configured and none discovered in DB");
      }
      guildPairs.push(discovered);
      console.log(
        `Using discovered guild pair: ${discovered.nameA} vs ${discovered.nameB} (${discovered.region})`
      );
    }

    for (const pair of guildPairs) {
      console.log(`\nGuild parity: ${pair.nameA} vs ${pair.nameB} (${pair.region})`);
      const limit = 25;
      const [oldIds, newIds] = await Promise.all([
        oldGuildKillIds(sql, pair, limit),
        newGuildKillIds(sql, pair, limit),
      ]);
      if (!sameArray(oldIds, newIds)) {
        console.error("  FAIL kill list mismatch");
        console.error("  old:", oldIds.join(","));
        console.error("  new:", newIds.join(","));
        failed = true;
      } else {
        console.log(`  OK kill list (${oldIds.length} events)`);
      }

      const [oldStats, newStats] = await Promise.all([
        oldGuildStats(sql, pair),
        newGuildStats(sql, pair),
      ]);
      if (
        oldStats.aKillsB !== newStats.aKillsB ||
        oldStats.bKillsA !== newStats.bKillsA ||
        oldStats.aFameOnB !== newStats.aFameOnB ||
        oldStats.bFameOnA !== newStats.bFameOnA
      ) {
        console.error("  FAIL stats mismatch");
        console.error("  old:", oldStats);
        console.error("  new:", newStats);
        failed = true;
      } else {
        console.log("  OK stats", newStats);
      }
    }

    const alliancePairs = parseAlliancePairs();
    for (const pair of alliancePairs) {
      console.log(`\nAlliance parity: ${pair.idA} vs ${pair.idB} (${pair.region})`);
      const limit = 25;
      const [oldIds, newIds] = await Promise.all([
        oldAllianceKillIds(sql, pair, limit),
        newAllianceKillIds(sql, pair, limit),
      ]);
      if (!sameArray(oldIds, newIds)) {
        console.error("  FAIL kill list mismatch");
        console.error("  old:", oldIds.join(","));
        console.error("  new:", newIds.join(","));
        failed = true;
      } else {
        console.log(`  OK kill list (${oldIds.length} events)`);
      }
    }

    if (failed) process.exit(1);
    console.log("\nAll parity checks passed.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
