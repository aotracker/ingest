export const FEED_GUILD_KILLS = "guild_kills";
export const FEED_GUILD_DEATHS = "guild_deaths";

export type DiscordFeedType = typeof FEED_GUILD_KILLS | typeof FEED_GUILD_DEATHS;

export type DiscordTargetType = "guild" | "player" | "alliance";

export interface DiscordFeedFilters {
  minFame?: number;
  minSilver?: number;
  contentTypes?: string[];
  pingRoleId?: string;
  paused?: boolean;
  /** ISO timestamp: do not Discord-notify events that occurred before this. */
  notifyAfter?: string;
}

export function parseFilters(value: unknown): DiscordFeedFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as DiscordFeedFilters;
}

export function killEventKey(region: string, eventId: number): string {
  return `kill:${region}:${eventId}`;
}

export function skippedFilterMessageId(reason: string): string {
  return `skipped:${reason}`;
}
