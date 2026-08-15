import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import type { APIEmbed } from "discord-api-types/v10";
import { appPublicUrl, discordBotToken } from "./enabled";
import { recordPostedMessage } from "./db";
import { regionLabel, formatUtcStamp } from "./format";
import type { KillSnapshot } from "./kill-data";
import { uploadSnapshotPng, isR2Configured } from "./r2";
import { enqueueChannelSend } from "./send";
import { renderKillSnapshotPng } from "./snapshot";
import { FEED_GUILD_DEATHS } from "./types";
import { recordOpsEvent } from "@aotracker/core/ops/events";

const COLOR_KILL = 0x3dd68c;
const COLOR_DEATH = 0xe85d5d;

function restClient(): REST {
  const token = discordBotToken();
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
  return new REST({ version: "10" }).setToken(token);
}

export async function postKillToFeed(input: {
  feedId: string;
  feedType: string;
  channelId: string;
  eventKey: string;
  snapshot: KillSnapshot;
}): Promise<void> {
  const { snapshot } = input;
  const isDeath = input.feedType === FEED_GUILD_DEATHS;
  const killer = snapshot.killer?.name?.trim() || "Unknown";
  const victim = snapshot.victim?.name?.trim() || "Unknown";
  const killUrl = `${appPublicUrl()}/kill/${snapshot.region}/${snapshot.eventId}`;

  const embed: APIEmbed = {
    color: isDeath ? COLOR_DEATH : COLOR_KILL,
    title: `${killer} killed ${victim}`,
    url: killUrl,
    description: `${regionLabel(snapshot.region)} · ${formatUtcStamp(snapshot.occurredAt)}`,
  };

  let attachment: { name: string; data: Buffer; contentType: string } | null =
    null;
  try {
    const png = await renderKillSnapshotPng(snapshot);
    if (isR2Configured()) {
      try {
        const imageUrl = await uploadSnapshotPng(
          snapshot.region,
          snapshot.eventId,
          png
        );
        embed.image = { url: imageUrl };
      } catch (err) {
        console.warn(
          `[discord] R2 upload failed for ${snapshot.region}/${snapshot.eventId}, attaching file:`,
          err instanceof Error ? err.message : err
        );
        attachment = {
          name: "snapshot.png",
          data: png,
          contentType: "image/png",
        };
        embed.image = { url: "attachment://snapshot.png" };
      }
    } else {
      attachment = {
        name: "snapshot.png",
        data: png,
        contentType: "image/png",
      };
      embed.image = { url: "attachment://snapshot.png" };
    }
  } catch (err) {
    console.warn(
      `[discord] snapshot skipped for ${snapshot.region}/${snapshot.eventId}:`,
      err instanceof Error ? err.message : err
    );
  }

  const rest = restClient();
  try {
    const message = (await enqueueChannelSend(input.channelId, () =>
      rest.post(Routes.channelMessages(input.channelId), {
        body: { embeds: [embed] },
        files: attachment ? [attachment] : undefined,
      })
    )) as { id?: string };

    await recordPostedMessage(
      input.feedId,
      input.eventKey,
      typeof message?.id === "string" ? message.id : null
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordOpsEvent({
      source: "discord",
      severity: "error",
      category: "notify",
      region: snapshot.region,
      message: `Failed to post ${input.feedType} ${snapshot.region}/${snapshot.eventId}: ${message}`,
      details: {
        feedId: input.feedId,
        channelId: input.channelId,
        eventId: snapshot.eventId,
        feedType: input.feedType,
      },
    });
    throw err;
  }
}
