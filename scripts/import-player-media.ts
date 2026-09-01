/**
 * Attach seed Twitch or YouTube channels to Albion players in Postgres.
 * Run on the OVH ingest VM (DATABASE_URL + platform credentials).
 * Skips players that already have this login/handle linked on that platform.
 *
 *   cd /home/ubuntu/ingest
 *   npm run media:import
 *   npm run media:import -- --apply
 *   npm run media:import -- --platform=youtube
 *   npm run media:import -- --platform=youtube --apply
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYoutubeChannelInput } from "../src/lib/media/urls";
import {
  getTwitchUserByLogin,
  twitchCredentials,
  TwitchHelixError,
} from "../src/lib/twitch/helix";
import { withDatabaseUrl } from "./db/with-database-url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV: Record<MediaPlatform, string> = {
  twitch: path.join(SCRIPT_DIR, "data", "player-media-seed.csv"),
  youtube: path.join(SCRIPT_DIR, "data", "player-media-youtube-seed.csv"),
};
const TWITCH_LOGIN_RE = /^[a-z0-9_]{3,25}$/;
const REGIONS = new Set(["americas", "europe", "asia"]);

type Region = "americas" | "europe" | "asia";
type MediaPlatform = "twitch" | "youtube";

type SeedRow = {
  query: string;
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

type ResolvedChannel = {
  id: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
};

type Outcome =
  | "already_linked"
  | "would_attach"
  | "attached"
  | "player_missing"
  | "channel_taken"
  | "player_has_other_channel"
  | "channel_missing"
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

function parsePlatform(): MediaPlatform {
  const raw = (option("platform") ?? "twitch").trim().toLowerCase();
  if (raw === "twitch" || raw === "youtube") return raw;
  throw new Error(`Unknown --platform=${raw} (use twitch or youtube)`);
}

function parseTwitchLogin(raw: string): string | null {
  const login = raw.trim().replace(/^@/, "").toLowerCase();
  return TWITCH_LOGIN_RE.test(login) ? login : null;
}

function parseYoutubeQuery(raw: string): string | null {
  const parsed = parseYoutubeChannelInput(raw);
  if (!parsed) return null;
  return parsed.kind === "handle" ? parsed.value : parsed.value;
}

function parseCsv(contents: string, platform: MediaPlatform): SeedRow[] {
  const lines = contents
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const header = lines.shift();
  if (!header) return [];
  const cols = header.split(",").map((col) => col.trim());
  const idx = (name: string) => cols.indexOf(name);

  const queryCol =
    platform === "youtube"
      ? idx("youtube_handle") >= 0
        ? "youtube_handle"
        : "youtube_url"
      : "twitch_login";

  const rows: SeedRow[] = [];
  for (const line of lines) {
    const parts = line.split(",");
    const queryRaw = (parts[idx(queryCol)] ?? "").trim();
    const query =
      platform === "youtube"
        ? parseYoutubeQuery(queryRaw)
        : parseTwitchLogin(queryRaw);
    const region = (parts[idx("region")] ?? "").trim();
    const playerAlbionId = (parts[idx("player_albion_id")] ?? "").trim();
    const playerName = (parts[idx("player_name")] ?? "").trim();
    if (!query || !playerAlbionId || !playerName) continue;
    if (!REGIONS.has(region)) continue;
    rows.push({
      query,
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

function youtubeApiKey(): string | null {
  return process.env.YOUTUBE_API_KEY?.trim() || null;
}

async function resolveYoutubeChannel(
  raw: string
): Promise<ResolvedChannel | null> {
  const parsed = parseYoutubeChannelInput(raw);
  if (!parsed) return null;
  const key = youtubeApiKey();
  if (!key) {
    throw new Error("YOUTUBE_API_KEY is required");
  }
  const params = new URLSearchParams({ part: "snippet", key });
  if (parsed.kind === "id") params.set("id", parsed.value);
  else params.set("forHandle", parsed.value);

  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?${params}`
  );
  if (!res.ok) {
    throw new Error(`YouTube channels HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    items?: Array<{
      id: string;
      snippet?: {
        title?: string;
        customUrl?: string;
        thumbnails?: { default?: { url?: string } };
      };
    }>;
  };
  const item = json.items?.[0];
  if (!item?.id) return null;
  const handle = item.snippet?.customUrl?.replace(/^@/, "") ?? parsed.value;
  return {
    id: item.id,
    login: handle,
    displayName: item.snippet?.title?.trim() || handle,
    avatarUrl: item.snippet?.thumbnails?.default?.url?.trim() || null,
  };
}

async function resolveChannel(
  platform: MediaPlatform,
  query: string
): Promise<ResolvedChannel | null> {
  if (platform === "youtube") {
    return resolveYoutubeChannel(query);
  }
  const user = await getTwitchUserByLogin(query);
  if (!user) return null;
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}

function matchesOnly(query: string, only: string | null): boolean {
  if (!only) return true;
  return query.toLowerCase() === only.toLowerCase();
}

async function main() {
  const apply = flag("apply");
  const includeLikely = !flag("confirmed-only");
  const platform = parsePlatform();
  const csvPath = path.resolve(option("csv") ?? DEFAULT_CSV[platform]);
  const onlyRaw = option("only") ?? "";
  const only =
    platform === "youtube"
      ? parseYoutubeQuery(onlyRaw)
      : parseTwitchLogin(onlyRaw);

  if (platform === "twitch" && !twitchCredentials()) {
    throw new Error("TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are required");
  }
  if (platform === "youtube" && !youtubeApiKey()) {
    throw new Error("YOUTUBE_API_KEY is required");
  }

  const rows = parseCsv(readFileSync(csvPath, "utf8"), platform).filter(
    (row) => {
      if (!matchesOnly(row.query, only)) return false;
      if (row.confidence === "confirmed") return true;
      if (includeLikely && row.confidence === "likely") return true;
      return false;
    }
  );

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
      WHERE platform = ${platform}
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
      `${apply ? "APPLY" : "DRY-RUN"} ${platform} ${rows.length} row(s) against local Postgres`
    );

    const counts: Record<Outcome, number> = {
      already_linked: 0,
      would_attach: 0,
      attached: 0,
      player_missing: 0,
      channel_taken: 0,
      player_has_other_channel: 0,
      channel_missing: 0,
      failed: 0,
    };

    for (const row of rows) {
      const key = playerKey(row.region, row.playerAlbionId);
      const label = `${row.playerName} [${row.region}] ↔ ${row.query}`;
      const playerLink = byPlayer.get(key);
      const loginLink = byLogin.get(row.query.toLowerCase());

      const alreadyThisChannel =
        (playerLink && playerLink.login.toLowerCase() === row.query.toLowerCase()) ||
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

      let channel: ResolvedChannel | null;
      try {
        channel = await resolveChannel(platform, row.query);
      } catch (err) {
        counts.failed += 1;
        const message =
          err instanceof TwitchHelixError || err instanceof Error
            ? err.message
            : String(err);
        console.log(`fail                 ${label} (${message})`);
        continue;
      }
      if (!channel) {
        counts.channel_missing += 1;
        console.log(`skip channel missing ${label}`);
        continue;
      }

      const taken = byChannelId.get(channel.id);
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
            ${platform},
            ${channel.id},
            ${channel.login},
            ${channel.displayName},
            ${channel.avatarUrl},
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
        channelId: channel.id,
        login: channel.login,
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
