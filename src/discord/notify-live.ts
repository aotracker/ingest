import { and, eq } from "drizzle-orm";
import { REST } from "@discordjs/rest";
import {
  ButtonStyle,
  ComponentType,
  Routes,
  type APIEmbed,
} from "discord-api-types/v10";
import { db, schema } from "@aotracker/core/db";
import { twitchChannelUrl } from "@aotracker/core/media/urls";
import type { JobPayload } from "../jobs/types";
import { isDiscordEnabled, discordBotToken, appPublicUrl } from "./enabled";
import {
  feedFilters,
  tryClaimPost,
  recordPostedMessage,
  clearPostClaim,
} from "./db";
import { FEED_GUILD_LIVE } from "./types";
import { regionLabel } from "./format";
import { enqueueChannelSend } from "./send";

const COLOR_LIVE = 0x9146ff;

function restClient(): REST {
  const token = discordBotToken();
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
  return new REST({ version: "10" }).setToken(token);
}

export function liveEventKey(channelId: string, startedAt: string): string {
  return `live:twitch:${channelId}:${startedAt}`;
}

export async function handleNotifyDiscordLive(
  payload: JobPayload
): Promise<void> {
  if (!isDiscordEnabled()) return;
  const channelId = payload.twitchChannelId?.trim();
  const startedAt = payload.streamStartedAt?.trim();
  if (!channelId || !startedAt) {
    throw new Error("notify-discord-live requires twitchChannelId and streamStartedAt");
  }

  const [link] = await db
    .select()
    .from(schema.playerMediaLinks)
    .where(
      and(
        eq(schema.playerMediaLinks.platform, "twitch"),
        eq(schema.playerMediaLinks.channelId, channelId)
      )
    )
    .limit(1);
  if (!link) return;

  const [player] = await db
    .select({
      guildAlbionId: schema.guilds.albionId,
      guildName: schema.guilds.name,
    })
    .from(schema.players)
    .leftJoin(schema.guilds, eq(schema.guilds.id, schema.players.guildId))
    .where(
      and(
        eq(schema.players.region, link.region),
        eq(schema.players.albionId, link.playerAlbionId)
      )
    )
    .limit(1);

  const guildAlbionId = player?.guildAlbionId;
  if (!guildAlbionId) return;

  const [liveState] = await db
    .select()
    .from(schema.mediaLiveState)
    .where(
      and(
        eq(schema.mediaLiveState.platform, "twitch"),
        eq(schema.mediaLiveState.channelId, channelId)
      )
    )
    .limit(1);

  const feeds = await db
    .select()
    .from(schema.discordFeeds)
    .where(
      and(
        eq(schema.discordFeeds.feedType, FEED_GUILD_LIVE),
        eq(schema.discordFeeds.region, link.region),
        eq(schema.discordFeeds.targetAlbionId, guildAlbionId),
        eq(schema.discordFeeds.enabled, 1)
      )
    );

  const eventKey = liveEventKey(channelId, startedAt);
  const rest = restClient();
  const profileUrl = `${appPublicUrl()}/player/${link.region}/${encodeURIComponent(link.playerName)}`;
  const twitchUrl = twitchChannelUrl(link.login);
  const title = liveState?.title?.trim() || "Albion Online";

  for (const feed of feeds) {
    if (!feed.channelId) continue;
    const filters = feedFilters(feed);
    if (filters.paused) continue;

    const claimed = await tryClaimPost(feed.id, eventKey);
    if (!claimed) continue;

    try {
      const pingRoleId = filters.pingRoleId?.trim() || "";
      const embed: APIEmbed = {
        color: COLOR_LIVE,
        title: `${link.playerName} is live`,
        url: twitchUrl,
        description: title,
        thumbnail: liveState?.thumbnailUrl
          ? { url: liveState.thumbnailUrl }
          : undefined,
        fields: [
          {
            name: "Region",
            value: regionLabel(link.region),
            inline: true,
          },
          ...(player?.guildName
            ? [
                {
                  name: "Guild",
                  value: player.guildName,
                  inline: true,
                },
              ]
            : []),
        ],
      };

      const message = (await enqueueChannelSend(feed.channelId, () =>
        rest.post(Routes.channelMessages(feed.channelId!), {
          body: {
            content: pingRoleId ? `<@&${pingRoleId}>` : undefined,
            allowed_mentions: pingRoleId
              ? { parse: [], roles: [pingRoleId] }
              : { parse: [] },
            embeds: [embed],
            components: [
              {
                type: ComponentType.ActionRow,
                components: [
                  {
                    type: ComponentType.Button,
                    style: ButtonStyle.Link,
                    label: "Watch on Twitch",
                    url: twitchUrl,
                  },
                  {
                    type: ComponentType.Button,
                    style: ButtonStyle.Link,
                    label: "Player",
                    url: profileUrl,
                  },
                ],
              },
            ],
          },
        })
      )) as { id?: string };

      await recordPostedMessage(feed.id, eventKey, message.id ?? null);
    } catch (err) {
      await clearPostClaim(feed.id, eventKey).catch(() => undefined);
      throw err;
    }
  }
}
