export {
  FEED_GUILD_BATTLES,
  FEED_GUILD_DEATHS,
  FEED_GUILD_KILLS,
  FEED_GUILD_LIVE,
  GUILD_FEED_TYPES,
  DEFAULT_BATTLE_FEED_MIN_PLAYERS,
  MAX_BATTLE_FEED_MIN_PLAYERS,
  applyFeedFilterPatch,
  battlePreviewEventKey,
  clampBattleMinPlayers,
  isDiscordFeedType,
  parseFeedFilters,
  parseFeedFilters as parseFilters,
  type DiscordFeedFilters,
  type DiscordFeedType,
  type FeedFilterPatch,
} from "@aotracker/core/discord-feed-shared";

export type DiscordTargetType = "guild" | "player" | "alliance";

export function killEventKey(region: string, eventId: number): string {
  return `kill:${region}:${eventId}`;
}

export function battleEventKey(region: string, battleId: number): string {
  return `battle:${region}:${battleId}`;
}

export function battleFingerprintKey(region: string, battleId: number): string {
  return `battle-fp:${region}:${battleId}`;
}

export function battleSeenKey(region: string, battleId: number): string {
  return `battle-seen:${region}:${battleId}`;
}

/** Wait until our view of a battle stops changing before posting a recap. */
export const BATTLE_SETTLE_MS = 18 * 60 * 1000;

export function battleThreadKey(region: string, battleId: number): string {
  return `battle-thread:${region}:${battleId}`;
}

export function skippedFilterMessageId(reason: string): string {
  return `skipped:${reason}`;
}

export function isPostedDiscordMessageId(
  value: string | null | undefined
): value is string {
  return Boolean(value) && !value!.startsWith("skipped:");
}
