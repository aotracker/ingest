import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { recordOpsEvent } from "@aotracker/core/ops/events";
import { discordBotToken } from "./enabled";
import {
  getPostedMessage,
  recordPostedMessage,
  tryClaimPost,
  upsertPostedMessage,
} from "./db";
import { enqueueChannelSend } from "./send";
import {
  battleLinkButtons,
  battleThreadName,
  buildBattleEmbed,
} from "./battle-format";
import type { BattleSnapshot } from "./battle-data";
import {
  battlePreviewEventKey,
  isPostedDiscordMessageId,
} from "./types";
import { uploadBattleSnapshotPng, isR2Configured } from "./r2";
import { renderBattleSnapshotPng } from "./battle-snapshot";

function restClient(): REST {
  const token = discordBotToken();
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
  return new REST({ version: "10" }).setToken(token);
}

function isUnknownMessageError(err: unknown): boolean {
  const code =
    err && typeof err === "object" && "code" in err
      ? Number((err as { code?: number }).code)
      : NaN;
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status?: number }).status)
      : NaN;
  return code === 10008 || status === 404;
}

type BattleAttachment = {
  name: string;
  data: Buffer;
  contentType: string;
};

async function battleEmbedWithImage(input: {
  snapshot: BattleSnapshot;
  trackedGuildId: string;
  trackedGuildName?: string | null;
  preview?: boolean;
}): Promise<{
  embed: ReturnType<typeof buildBattleEmbed>;
  attachment: BattleAttachment | null;
}> {
  const embed = buildBattleEmbed(input);
  let attachment: BattleAttachment | null = null;
  try {
    const png = await renderBattleSnapshotPng(input);
    const canUpload =
      isR2Configured() && !input.preview && input.snapshot.albionBattleId > 0;
    if (canUpload) {
      try {
        const imageUrl = await uploadBattleSnapshotPng(
          input.snapshot.region,
          input.snapshot.albionBattleId,
          png
        );
        embed.image = { url: imageUrl };
      } catch (err) {
        console.warn(
          `[discord] R2 battle upload failed for ${input.snapshot.region}/${input.snapshot.albionBattleId}, attaching file:`,
          err instanceof Error ? err.message : err
        );
        attachment = {
          name: "battle.png",
          data: png,
          contentType: "image/png",
        };
        embed.image = { url: "attachment://battle.png" };
      }
    } else {
      attachment = {
        name: "battle.png",
        data: png,
        contentType: "image/png",
      };
      embed.image = { url: "attachment://battle.png" };
    }
  } catch (err) {
    console.warn(
      `[discord] battle image skipped for ${input.snapshot.region}/${input.snapshot.albionBattleId}:`,
      err instanceof Error ? err.message : err
    );
  }
  return { embed, attachment };
}

export async function postBattleToFeed(input: {
  feedId: string;
  channelId: string;
  eventKey: string;
  snapshot: BattleSnapshot;
  trackedGuildId: string;
  trackedGuildName?: string | null;
  pingRoleId?: string | null;
  createThread?: boolean;
  threadEventKey: string;
}): Promise<{ messageId: string | null; threadId: string | null }> {
  const pingRoleId = input.pingRoleId?.trim() || "";
  const { embed, attachment } = await battleEmbedWithImage({
    snapshot: input.snapshot,
    trackedGuildId: input.trackedGuildId,
    trackedGuildName: input.trackedGuildName,
  });
  const rest = restClient();

  try {
    const message = (await enqueueChannelSend(input.channelId, () =>
      rest.post(Routes.channelMessages(input.channelId), {
        body: {
          content: pingRoleId ? `<@&${pingRoleId}>` : undefined,
          allowed_mentions: pingRoleId
            ? { parse: [], roles: [pingRoleId] }
            : { parse: [] },
          embeds: [embed],
          components: battleLinkButtons(input.snapshot),
        },
        files: attachment ? [attachment] : undefined,
      })
    )) as { id?: string };

    const messageId = typeof message?.id === "string" ? message.id : null;
    await recordPostedMessage(input.feedId, input.eventKey, messageId);

    let threadId: string | null = null;
    if (input.createThread && messageId) {
      threadId = await startBattleThread({
        channelId: input.channelId,
        messageId,
        snapshot: input.snapshot,
        trackedGuildName: input.trackedGuildName,
      });
      if (threadId) {
        await upsertPostedMessage(input.feedId, input.threadEventKey, threadId);
      }
    }

    return { messageId, threadId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordOpsEvent({
      source: "discord",
      severity: "error",
      category: "notify",
      region: input.snapshot.region,
      message: `Failed to post guild_battles ${input.snapshot.region}/${input.snapshot.albionBattleId}: ${message}`,
      details: {
        feedId: input.feedId,
        channelId: input.channelId,
        battleId: input.snapshot.albionBattleId,
        feedType: "guild_battles",
      },
    });
    throw err;
  }
}

async function startBattleThread(input: {
  channelId: string;
  messageId: string;
  snapshot: BattleSnapshot;
  trackedGuildName?: string | null;
}): Promise<string | null> {
  const rest = restClient();
  try {
    const thread = (await enqueueChannelSend(input.channelId, () =>
      rest.post(Routes.threads(input.channelId, input.messageId), {
        body: {
          name: battleThreadName(input.snapshot, input.trackedGuildName),
          auto_archive_duration: 1440,
        },
      })
    )) as { id?: string };
    return typeof thread?.id === "string" ? thread.id : null;
  } catch (err) {
    console.warn(
      `[discord] battle thread skipped for ${input.snapshot.region}/${input.snapshot.albionBattleId}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export async function postOrEditBattlePreview(input: {
  feedId: string;
  channelId: string;
  snapshot: BattleSnapshot;
  trackedGuildId: string;
  trackedGuildName?: string | null;
}): Promise<{ messageId: string | null; edited: boolean }> {
  const eventKey = battlePreviewEventKey(input.feedId);
  const existing = await getPostedMessage(input.feedId, eventKey);
  const { embed, attachment } = await battleEmbedWithImage({
    snapshot: input.snapshot,
    trackedGuildId: input.trackedGuildId,
    trackedGuildName: input.trackedGuildName,
    preview: true,
  });
  const components = battleLinkButtons(input.snapshot);
  const rest = restClient();
  const files = attachment ? [attachment] : undefined;

  if (isPostedDiscordMessageId(existing)) {
    try {
      await enqueueChannelSend(input.channelId, () =>
        rest.patch(Routes.channelMessage(input.channelId, existing), {
          body: { embeds: [embed], components },
          files,
        })
      );
      await recordPostedMessage(input.feedId, eventKey, existing);
      return { messageId: existing, edited: true };
    } catch (err) {
      if (!isUnknownMessageError(err)) throw err;
    }
  }

  await tryClaimPost(input.feedId, eventKey);
  const message = (await enqueueChannelSend(input.channelId, () =>
    rest.post(Routes.channelMessages(input.channelId), {
      body: {
        allowed_mentions: { parse: [] },
        embeds: [embed],
        components,
      },
      files,
    })
  )) as { id?: string };
  const messageId = typeof message?.id === "string" ? message.id : null;
  await upsertPostedMessage(input.feedId, eventKey, messageId);
  return { messageId, edited: false };
}
