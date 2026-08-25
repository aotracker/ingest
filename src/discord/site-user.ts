import { and, eq } from "drizzle-orm";
import type { AlbionRegion } from "@aotracker/core/albion/types";
import { db, schema } from "@aotracker/core/db";
import { appPublicUrl } from "./enabled";

const WATCHLIST_LIMIT = 10;
const WATCHLIST_WINDOW_MS = 10 * 60 * 1000;
const watchlistBuckets = new Map<string, { count: number; resetAt: number }>();

export function consumeWatchlistRateLimit(discordUserId: string): boolean {
  const now = Date.now();
  const current = watchlistBuckets.get(discordUserId);
  if (!current || current.resetAt <= now) {
    watchlistBuckets.set(discordUserId, {
      count: 1,
      resetAt: now + WATCHLIST_WINDOW_MS,
    });
    return true;
  }
  if (current.count >= WATCHLIST_LIMIT) return false;
  current.count += 1;
  return true;
}

export async function findUserIdByDiscordAccountId(
  discordId: string
): Promise<string | null> {
  const [row] = await db
    .select({ userId: schema.account.userId })
    .from(schema.account)
    .where(
      and(
        eq(schema.account.providerId, "discord"),
        eq(schema.account.accountId, discordId)
      )
    )
    .limit(1);
  return row?.userId ?? null;
}

export async function listClaimedCharactersForUser(userId: string): Promise<
  Array<{ region: AlbionRegion; albionId: string; name: string }>
> {
  const rows = await db
    .select({
      region: schema.userClaimedCharacters.region,
      albionId: schema.userClaimedCharacters.albionId,
      name: schema.players.name,
    })
    .from(schema.userClaimedCharacters)
    .leftJoin(
      schema.players,
      and(
        eq(schema.players.region, schema.userClaimedCharacters.region),
        eq(schema.players.albionId, schema.userClaimedCharacters.albionId)
      )
    )
    .where(eq(schema.userClaimedCharacters.userId, userId));

  return rows.map((row) => ({
    region: row.region,
    albionId: row.albionId,
    name: row.name ?? row.albionId,
  }));
}

export function playerProfileUrl(region: AlbionRegion, name: string): string {
  return `${appPublicUrl()}/player/${region}/${encodeURIComponent(name)}`;
}

export function guildProfileUrl(region: AlbionRegion, name: string): string {
  return `${appPublicUrl()}/guild/${region}/${encodeURIComponent(name)}`;
}

export function feudPageUrl(
  region: AlbionRegion,
  guildA: string,
  guildB: string
): string {
  return `${appPublicUrl()}/feud/${region}/${encodeURIComponent(guildA)}/${encodeURIComponent(guildB)}`;
}

export async function addWatchlistEntry(input: {
  userId: string;
  type: "player" | "guild" | "alliance";
  region: AlbionRegion;
  albionId: string;
  name: string;
}): Promise<"added" | "exists"> {
  const inserted = await db
    .insert(schema.userWatchlistEntries)
    .values({
      userId: input.userId,
      type: input.type,
      region: input.region,
      albionId: input.albionId,
      name: input.name,
      addedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        schema.userWatchlistEntries.userId,
        schema.userWatchlistEntries.type,
        schema.userWatchlistEntries.region,
        schema.userWatchlistEntries.albionId,
      ],
    })
    .returning({ id: schema.userWatchlistEntries.id });
  return inserted.length > 0 ? "added" : "exists";
}
