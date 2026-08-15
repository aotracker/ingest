/**
 * Post an existing Postgres kill to Discord feeds (local testing).
 *
 *   npm run discord:notify-once
 *   npm run discord:notify-once -- --region europe --event 417638879
 *   npm run discord:notify-once -- --region europe --event 417638879 --force
 *   npm run discord:notify-once -- --list
 */
import {
  ALL_REGIONS,
  isRegionEnabled,
  type AlbionRegion,
} from "@aotracker/core/albion/types";
import {
  findLatestKillForFeeds,
  listPostableFeeds,
} from "../src/discord/db";
import { postKillToMatchingFeeds } from "../src/discord/replay";
import { FEED_GUILD_DEATHS, FEED_GUILD_KILLS } from "../src/discord/types";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const eq = process.argv.find((arg) => arg.startsWith(prefix));
  if (eq) return eq.slice(prefix.length).trim() || undefined;
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) return undefined;
  return next.trim();
}

function parseRegion(raw: string | undefined): AlbionRegion | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (!(ALL_REGIONS as string[]).includes(value)) {
    console.error(
      `[discord:notify-once] Invalid --region="${raw}". Expected ${ALL_REGIONS.join(", ")}`
    );
    process.exit(1);
  }
  if (!isRegionEnabled(value)) {
    console.error(`[discord:notify-once] Region "${value}" is disabled`);
    process.exit(1);
  }
  return value as AlbionRegion;
}

function parseEventId(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const eventId = Number.parseInt(raw, 10);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    console.error(`[discord:notify-once] Invalid --event="${raw}"`);
    process.exit(1);
  }
  return eventId;
}

function parseFeedType(raw: string | undefined) {
  if (!raw) return undefined;
  if (raw === "kills" || raw === FEED_GUILD_KILLS) return FEED_GUILD_KILLS;
  if (raw === "deaths" || raw === FEED_GUILD_DEATHS) return FEED_GUILD_DEATHS;
  console.error(
    `[discord:notify-once] Invalid --feed="${raw}". Use kills or deaths`
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const feeds = await listPostableFeeds();
  if (flag("list")) {
    if (feeds.length === 0) {
      console.log("No Discord feeds with a channel set. Run /track and the channel commands first.");
      return;
    }
    for (const feed of feeds) {
      console.log(
        `${feed.region}  ${feed.feedType.padEnd(12)}  ${feed.targetName ?? feed.targetAlbionId}  #${feed.channelId}`
      );
    }
    return;
  }

  if (feeds.length === 0) {
    throw new Error(
      "No Discord feeds with a channel set. Invite the bot, then /track, /kills-channel, and /deaths-channel."
    );
  }

  const regionFlag = parseRegion(option("region"));
  const eventFlag = parseEventId(option("event"));
  const feedType = parseFeedType(option("feed"));
  const force = flag("force");

  let region = regionFlag;
  let eventId = eventFlag;

  if (eventId != null && !region) {
    throw new Error("Pass --region with --event");
  }

  if (eventId == null) {
    const scoped = region
      ? feeds.filter((feed) => feed.region === region)
      : feeds;
    const latest = await findLatestKillForFeeds(
      feedType ? scoped.filter((feed) => feed.feedType === feedType) : scoped
    );
    if (!latest) {
      throw new Error(
        "No matching kill in Postgres for the tracked guild(s). Ingest a kill first, or pass --region and --event."
      );
    }
    region = latest.region;
    eventId = latest.eventId;
    console.log(
      `[discord:notify-once] Using latest matching kill ${region}/${eventId}`
    );
  }

  const result = await postKillToMatchingFeeds({
    region: region!,
    eventId: eventId!,
    feedType,
    force,
  });

  if (result.posted.length === 0 && result.skipped.length === 0) {
    throw new Error(
      `No feeds matched ${region}/${eventId}. Check /track region + guild, and that this kill involves that guild.`
    );
  }

  for (const skip of result.skipped) {
    console.log(`[discord:notify-once] skipped ${skip}`);
  }
  for (const post of result.posted) {
    console.log(
      `[discord:notify-once] posted ${post.feedType} to channel ${post.channelId}`
    );
  }

  if (result.posted.length === 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(
      "[discord:notify-once]",
      err instanceof Error ? err.message : err
    );
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
