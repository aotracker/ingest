/**
 * Attach seed Twitch channels to Albion players in Postgres.
 * Run on the OVH ingest VM (DATABASE_URL + TWITCH_CLIENT_ID/SECRET).
 * Skips players that already have this Twitch login linked.
 *
 *   cd /home/ubuntu/ingest
 *   npm run media:import
 *   npm run media:import -- --apply
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTwitchUserByLogin,
  twitchCredentials,
  TwitchHelixError,
} from "../src/lib/twitch/helix";
import { withDatabaseUrl } from "./db/with-database-url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = path.join(SCRIPT_DIR, "data", "player-media-seed.csv");
const TWITCH_LOGIN_RE = /^[a-z0-9_]{3,25}$/;
const REGIONS = new Set(["americas", "europe", "asia"]);

type Region = "americas" | "europe" | "asia";

type SeedRow = {
  twitchLogin: string;
  playerName: string;
  region: Region;
  playerAlbionId: string;
  confidence: string;
};

type PlayerLink = {
  region: Region;
  playerAlbionId: string;
  playerName: string;
  channelId: string;
  login: string;
};

type Outcome =
  | "already_linked"
  | "would_attach"
  | "attached"
  | "player_missing"
  | "channel_taken"
  | "player_has_other_channel"
  | "twitch_missing"
  | "failed";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const eq = process.argv.find((arg) => arg.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function playerKey(region: string, albionId: string): string {
  return `${region}:${albionId}`;
}

function parseTwitchLogin(raw: string): string | null {
  const login = raw.trim().replace(/^@/, "").toLowerCase();
  return TWITCH_LOGIN_RE.test(login) ? login : null;
}

function parseCsv(contents: string): SeedRow[] {
  const lines = contents
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const header = lines.shift();
  if (!header) return [];
  const cols = header.split(",").map((col) => col.trim());
  const idx = (name: string) => cols.indexOf(name);

  const rows: SeedRow[] = [];
  for (const line of lines) {
    const parts = line.split(",");
    const twitchLogin = parseTwitchLogin(parts[idx("twitch_login")] ?? "");
    const region = (parts[idx("region")] ?? "").trim();
    const playerAlbionId = (parts[idx("player_albion_id")] ?? "").trim();
    const playerName = (parts[idx("player_name")] ?? "").trim();
    if (!twitchLogin || !playerAlbionId || !playerName) continue;
    if (!REGIONS.has(region)) continue;
    rows.push({
      twitchLogin,
      playerName,
      region: region as Region,
      playerAlbionId,
      confidence: (parts[idx("confidence")] ?? "").trim() || "confirmed",
    });
  }
  return rows;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const apply = flag("apply");
  const includeLikely = !flag("confirmed-only");
  const csvPath = path.resolve(option("csv") ?? DEFAULT_CSV);
  const onlyLogin = parseTwitchLogin(option("only") ?? "");

  if (!twitchCredentials()) {
    throw new Error("TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are required");
  }

  const rows = parseCsv(readFileSync(csvPath, "utf8")).filter((row) => {
    if (onlyLogin && row.twitchLogin !== onlyLogin) return false;
    if (row.confidence === "confirmed") return true;
    if (includeLikely && row.confidence === "likely") return true;
    return false;
  });

  if (rows.length === 0) {
    console.error(`No seed rows in ${csvPath}`);
    process.exit(1);
  }

  await withDatabaseUrl(async (sql) => {
    const existing = await sql<PlayerLink[]>`
      SELECT
        region,
        player_albion_id AS "playerAlbionId",
        player_name AS "playerName",
        channel_id AS "channelId",
        login
      FROM player_media_links
      WHERE platform = 'twitch'
    `;

    const byPlayer = new Map<string, PlayerLink>();
    const byLogin = new Map<string, PlayerLink>();
    const byChannelId = new Map<string, PlayerLink>();
    const remember = (link: PlayerLink) => {
      byPlayer.set(playerKey(link.region, link.playerAlbionId), link);
      byLogin.set(link.login.toLowerCase(), link);
      byChannelId.set(link.channelId, link);
    };
    for (const link of existing) remember(link);

    console.log(
      `${apply ? "APPLY" : "DRY-RUN"} ${rows.length} row(s) against local Postgres`
    );

    const counts: Record<Outcome, number> = {
      already_linked: 0,
      would_attach: 0,
      attached: 0,
      player_missing: 0,
      channel_taken: 0,
      player_has_other_channel: 0,
      twitch_missing: 0,
      failed: 0,
    };

    for (const row of rows) {
      const key = playerKey(row.region, row.playerAlbionId);
      const label = `${row.playerName} [${row.region}] ↔ ${row.twitchLogin}`;
      const playerLink = byPlayer.get(key);
      const loginLink = byLogin.get(row.twitchLogin);

      const alreadyThisChannel =
        (playerLink && playerLink.login.toLowerCase() === row.twitchLogin) ||
        (loginLink &&
          loginLink.region === row.region &&
          loginLink.playerAlbionId === row.playerAlbionId);

      if (alreadyThisChannel) {
        counts.already_linked += 1;
        console.log(`skip already linked  ${label}`);
        continue;
      }

      if (playerLink) {
        counts.player_has_other_channel += 1;
        console.log(
          `skip other channel   ${label} (already ${playerLink.login})`
        );
        continue;
      }

      if (loginLink) {
        counts.channel_taken += 1;
        console.log(
          `skip channel taken   ${label} (linked to ${loginLink.playerName} [${loginLink.region}])`
        );
        continue;
      }

      const playerRows = await sql<{ name: string }[]>`
        SELECT name
        FROM players
        WHERE region = ${row.region} AND albion_id = ${row.playerAlbionId}
        LIMIT 1
      `;
      const player = playerRows[0];
      if (!player) {
        counts.player_missing += 1;
        console.log(`skip player missing  ${label}`);
        continue;
      }

      let user;
      try {
        user = await getTwitchUserByLogin(row.twitchLogin);
      } catch (err) {
        counts.failed += 1;
        const message =
          err instanceof TwitchHelixError ? err.message : String(err);
        console.log(`fail                 ${label} (${message})`);
        continue;
      }
      if (!user) {
        counts.twitch_missing += 1;
        console.log(`skip twitch missing  ${label}`);
        continue;
      }

      const taken = byChannelId.get(user.id);
      if (
        taken &&
        (taken.region !== row.region || taken.playerAlbionId !== row.playerAlbionId)
      ) {
        counts.channel_taken += 1;
        console.log(
          `skip channel taken   ${label} (channel id already on ${taken.playerName})`
        );
        continue;
      }

      if (!apply) {
        counts.would_attach += 1;
        console.log(`would attach         ${label}`);
        await sleep(80);
        continue;
      }

      try {
        await sql`
          INSERT INTO player_media_links (
            region,
            player_albion_id,
            player_name,
            platform,
            channel_id,
            login,
            display_name,
            avatar_url,
            updated_at
          ) VALUES (
            ${row.region},
            ${row.playerAlbionId},
            ${player.name},
            'twitch',
            ${user.id},
            ${user.login},
            ${user.displayName},
            ${user.avatarUrl},
            now()
          )
        `;
      } catch (err) {
        counts.failed += 1;
        console.log(
          `fail                 ${label} (${err instanceof Error ? err.message : err})`
        );
        continue;
      }

      remember({
        region: row.region,
        playerAlbionId: row.playerAlbionId,
        playerName: player.name,
        channelId: user.id,
        login: user.login,
      });
      counts.attached += 1;
      console.log(`attached             ${label}`);
      await sleep(120);
    }

    console.log("\nSummary");
    for (const [name, count] of Object.entries(counts)) {
      if (count === 0) continue;
      console.log(`  ${name}: ${count}`);
    }
    if (!apply && counts.would_attach > 0) {
      console.log("\nRe-run with --apply to attach the remaining channels.");
    }
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
