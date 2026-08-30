import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@aotracker/core/db";
import {
  getAlbionTwitchGameId,
  getTwitchArchiveVideos,
  getTwitchStreamsByUserIds,
  matchVodToSession,
  twitchCredentials,
  type TwitchStream,
} from "@aotracker/core/twitch/helix";
import { enqueueNotifyDiscordLive } from "../discord/jobs";
import { recordOpsEvent } from "@aotracker/core/ops/events";

const BATCH = 100;

function unique(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function runMediaLivePoll(): Promise<{
  channels: number;
  live: number;
  wentLive: number;
  wentOffline: number;
}> {
  if (!twitchCredentials()) {
    return { channels: 0, live: 0, wentLive: 0, wentOffline: 0 };
  }

  const [playerLinks, guildPins] = await Promise.all([
    db
      .select({ channelId: schema.playerMediaLinks.channelId })
      .from(schema.playerMediaLinks)
      .where(eq(schema.playerMediaLinks.platform, "twitch")),
    db
      .select({ channelId: schema.guildMediaPins.channelId })
      .from(schema.guildMediaPins)
      .where(eq(schema.guildMediaPins.platform, "twitch")),
  ]);

  const channelIds = unique([
    ...playerLinks.map((row) => row.channelId),
    ...guildPins.map((row) => row.channelId),
  ]);
  if (channelIds.length === 0) {
    return { channels: 0, live: 0, wentLive: 0, wentOffline: 0 };
  }

  const albionGameId = await getAlbionTwitchGameId();
  const streams: TwitchStream[] = [];
  for (const batch of chunks(channelIds, BATCH)) {
    streams.push(...(await getTwitchStreamsByUserIds(batch)));
  }

  const albionLive = new Map<string, TwitchStream>();
  for (const stream of streams) {
    if (stream.gameId === albionGameId) {
      albionLive.set(stream.userId, stream);
    }
  }

  const existing = await db
    .select()
    .from(schema.mediaLiveState)
    .where(
      and(
        eq(schema.mediaLiveState.platform, "twitch"),
        inArray(schema.mediaLiveState.channelId, channelIds)
      )
    );
  const existingByChannel = new Map(
    existing.map((row) => [row.channelId, row] as const)
  );

  let wentLive = 0;
  let wentOffline = 0;
  const now = new Date();

  for (const channelId of channelIds) {
    const stream = albionLive.get(channelId);
    const prev = existingByChannel.get(channelId);
    const wasLive = Boolean(prev?.isLive);

    if (stream) {
      const startedAt = new Date(stream.startedAt);
      await db
        .insert(schema.mediaLiveState)
        .values({
          platform: "twitch",
          channelId,
          isLive: true,
          title: stream.title,
          viewerCount: stream.viewerCount,
          startedAt,
          thumbnailUrl: stream.thumbnailUrl
            .replace("{width}", "440")
            .replace("{height}", "248"),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.mediaLiveState.platform,
            schema.mediaLiveState.channelId,
          ],
          set: {
            isLive: true,
            title: stream.title,
            viewerCount: stream.viewerCount,
            startedAt,
            thumbnailUrl: stream.thumbnailUrl
              .replace("{width}", "440")
              .replace("{height}", "248"),
            updatedAt: now,
          },
        });

      if (!wasLive) {
        wentLive += 1;
        await openSession(channelId, startedAt, stream.title);
        await enqueueNotifyDiscordLive({
          channelId,
          startedAt: startedAt.toISOString(),
        }).catch((err) => {
          console.warn(
            `[media-live] Discord enqueue failed for ${channelId}:`,
            err instanceof Error ? err.message : err
          );
        });
      }
      continue;
    }

    if (wasLive) {
      wentOffline += 1;
      await db
        .update(schema.mediaLiveState)
        .set({
          isLive: false,
          viewerCount: 0,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.mediaLiveState.platform, "twitch"),
            eq(schema.mediaLiveState.channelId, channelId)
          )
        );
      await closeSession(channelId);
    } else if (!prev) {
      await db
        .insert(schema.mediaLiveState)
        .values({
          platform: "twitch",
          channelId,
          isLive: false,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
  }

  return {
    channels: channelIds.length,
    live: albionLive.size,
    wentLive,
    wentOffline,
  };
}

async function openSession(
  channelId: string,
  startedAt: Date,
  title: string | null
): Promise<void> {
  const open = await db
    .select({ id: schema.mediaStreamSessions.id })
    .from(schema.mediaStreamSessions)
    .where(
      and(
        eq(schema.mediaStreamSessions.platform, "twitch"),
        eq(schema.mediaStreamSessions.channelId, channelId),
        isNull(schema.mediaStreamSessions.endedAt)
      )
    )
    .limit(1);
  if (open.length > 0) return;

  await db.insert(schema.mediaStreamSessions).values({
    platform: "twitch",
    channelId,
    startedAt,
    title,
  });
}

async function closeSession(channelId: string): Promise<void> {
  const [open] = await db
    .select()
    .from(schema.mediaStreamSessions)
    .where(
      and(
        eq(schema.mediaStreamSessions.platform, "twitch"),
        eq(schema.mediaStreamSessions.channelId, channelId),
        isNull(schema.mediaStreamSessions.endedAt)
      )
    )
    .limit(1);
  if (!open) return;

  const endedAt = new Date();
  let vodId: string | null = null;
  let vodDurationSeconds: number | null = null;
  try {
    const videos = await getTwitchArchiveVideos(channelId, 8);
    const match = matchVodToSession(videos, open.startedAt);
    if (match) {
      vodId = match.id;
      vodDurationSeconds = match.durationSeconds;
    }
  } catch (err) {
    await recordOpsEvent({
      source: "ingest",
      severity: "warning",
      category: "media-live",
      message: `VOD lookup failed for ${channelId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }).catch(() => undefined);
  }

  await db
    .update(schema.mediaStreamSessions)
    .set({ endedAt, vodId, vodDurationSeconds })
    .where(eq(schema.mediaStreamSessions.id, open.id));
}
