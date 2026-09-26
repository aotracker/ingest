/**
 * One-time channel notice for guild feeds paused because they had no signed-in owner.
 * Not started by the bot or PM2. Run by hand on the VM after db:apply-discord-feed-owner.
 *
 *   npm run discord:announce-paused-feeds
 *   npm run discord:announce-paused-feeds -- --send
 *
 * Default is a dry run. --send posts once per channel. A second --send skips channels
 * already recorded in discord_post_log.
 */
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "@aotracker/core/db";
import {
  recordPostedMessage,
  tryClaimPost,
} from "../src/discord/db";
import { appPublicUrl, discordBotToken } from "../src/discord/enabled";

const EVENT_KEY = "notice:paused-feed-signin";

type Target = {
  channelId: string;
  feedId: string;
  guildName: string;
};

function notice(guildNames: string[]): string {
  const url = `${appPublicUrl()}/account/discord`;
  const guilds =
    guildNames.filter((name) => name.trim()).join(", ") || "your guild";
  return [
    `AOTracker kill feeds are paused. A server manager needs to sign in with Discord at ${url}, run /track for ${guilds}, then set the channel commands again.`,
    "",
    "Discord auth does not collect email addresses.",
  ].join("\n");
}

async function loadTargets(): Promise<Map<string, Target[]>> {
  const rows = await db
    .select({
      feedId: schema.discordFeeds.id,
      channelId: schema.discordFeeds.channelId,
      guildName: schema.discordFeeds.targetName,
    })
    .from(schema.discordFeeds)
    .where(
      and(
        eq(schema.discordFeeds.enabled, 0),
        isNotNull(schema.discordFeeds.channelId)
      )
    );

  const byChannel = new Map<string, Target[]>();
  for (const row of rows) {
    if (!row.channelId) continue;
    const list = byChannel.get(row.channelId) ?? [];
    list.push({
      channelId: row.channelId,
      feedId: row.feedId,
      guildName: row.guildName?.trim() || "your guild",
    });
    byChannel.set(row.channelId, list);
  }
  return byChannel;
}

async function alreadySent(feedIds: string[]): Promise<boolean> {
  if (feedIds.length === 0) return false;
  const rows = await db
    .select({ feedId: schema.discordPostLog.feedId })
    .from(schema.discordPostLog)
    .where(
      and(
        eq(schema.discordPostLog.eventKey, EVENT_KEY),
        inArray(schema.discordPostLog.feedId, feedIds)
      )
    )
    .limit(1);
  return rows.length > 0;
}

async function releaseClaim(feedId: string): Promise<void> {
  await db
    .delete(schema.discordPostLog)
    .where(
      and(
        eq(schema.discordPostLog.feedId, feedId),
        eq(schema.discordPostLog.eventKey, EVENT_KEY)
      )
    );
}

async function postNotice(
  rest: REST,
  channelId: string,
  content: string
): Promise<string | null> {
  const data = (await rest.post(Routes.channelMessages(channelId), {
    body: { content },
  })) as { id?: string };
  return typeof data.id === "string" ? data.id : null;
}

async function main(): Promise<void> {
  const send = process.argv.includes("--send");
  const targets = await loadTargets();
  if (targets.size === 0) {
    console.log("[discord:announce-paused-feeds] No paused feeds with a channel.");
    return;
  }

  const token = discordBotToken();
  if (send && !token) {
    throw new Error("DISCORD_BOT_TOKEN is required to send");
  }
  const rest = send && token ? new REST({ version: "10" }).setToken(token) : null;

  let posted = 0;
  let skipped = 0;
  let failed = 0;

  for (const [channelId, feeds] of targets) {
    const guildNames = [...new Set(feeds.map((feed) => feed.guildName))];
    const content = notice(guildNames);
    const claimFeedId = feeds[0]!.feedId;

    if (await alreadySent(feeds.map((feed) => feed.feedId))) {
      skipped += 1;
      console.log(
        `[discord:announce-paused-feeds] skip ${channelId} (${guildNames.join(", ")}): already sent`
      );
      continue;
    }

    if (!send || !rest) {
      console.log(
        `[discord:announce-paused-feeds] dry-run ${channelId} (${guildNames.join(", ")})\n${content}\n`
      );
      continue;
    }

    const claimed = await tryClaimPost(claimFeedId, EVENT_KEY);
    if (!claimed) {
      skipped += 1;
      console.log(
        `[discord:announce-paused-feeds] skip ${channelId}: another run already claimed it`
      );
      continue;
    }

    try {
      const messageId = await postNotice(rest, channelId, content);
      await recordPostedMessage(claimFeedId, EVENT_KEY, messageId);
      posted += 1;
      console.log(
        `[discord:announce-paused-feeds] sent ${channelId} (${guildNames.join(", ")})`
      );
    } catch (err) {
      failed += 1;
      await releaseClaim(claimFeedId).catch(() => undefined);
      console.error(
        `[discord:announce-paused-feeds] failed ${channelId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  console.log(
    `[discord:announce-paused-feeds] ${send ? "send" : "dry-run"} done: ${posted} sent, ${skipped} skipped, ${failed} failed, ${targets.size} channel(s)`
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
