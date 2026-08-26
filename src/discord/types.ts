export const FEED_GUILD_KILLS = "guild_kills";
export const FEED_GUILD_DEATHS = "guild_deaths";
export const FEED_GUILD_BATTLES = "guild_battles";

export const GUILD_FEED_TYPES = [
  FEED_GUILD_KILLS,
  FEED_GUILD_DEATHS,
  FEED_GUILD_BATTLES,
] as const;

export type DiscordFeedType = (typeof GUILD_FEED_TYPES)[number];

export type DiscordTargetType = "guild" | "player" | "alliance";

/** Default battle size floor when minPlayers is unset. */
export const DEFAULT_BATTLE_FEED_MIN_PLAYERS = 20;
export const MAX_BATTLE_FEED_MIN_PLAYERS = 500;

export interface DiscordFeedFilters {
  minFame?: number;
  minSilver?: number;
  contentTypes?: string[];
  pingRoleId?: string;
  paused?: boolean;
  /** ISO timestamp: do not Discord-notify events that occurred before this. */
  notifyAfter?: string;
  /** Post guild battle summaries only when totalPlayers >= this. */
  minPlayers?: number;
  /** Start a Discord thread on the first battle summary message. */
  createThread?: boolean;
}

export function parseFilters(value: unknown): DiscordFeedFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as DiscordFeedFilters;
}

export function isDiscordFeedType(value: string): value is DiscordFeedType {
  return (GUILD_FEED_TYPES as readonly string[]).includes(value);
}

export function clampBattleMinPlayers(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BATTLE_FEED_MIN_PLAYERS;
  return Math.min(
    MAX_BATTLE_FEED_MIN_PLAYERS,
    Math.max(1, Math.floor(value))
  );
}

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

export function battlePreviewEventKey(feedId: string): string {
  return `battle-preview:${feedId}`;
}

export function skippedFilterMessageId(reason: string): string {
  return `skipped:${reason}`;
}

export function isPostedDiscordMessageId(
  value: string | null | undefined
): value is string {
  return Boolean(value) && !value!.startsWith("skipped:");
}
