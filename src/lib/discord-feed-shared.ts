export const FEED_GUILD_KILLS = "guild_kills";
export const FEED_GUILD_DEATHS = "guild_deaths";
export const FEED_GUILD_BATTLES = "guild_battles";

export const GUILD_FEED_TYPES = [
  FEED_GUILD_KILLS,
  FEED_GUILD_DEATHS,
  FEED_GUILD_BATTLES,
] as const;

export type DiscordFeedType = (typeof GUILD_FEED_TYPES)[number];

/** Default tracked-guild player floor when minPlayers is unset. */
export const DEFAULT_BATTLE_FEED_MIN_PLAYERS = 20;
export const MAX_BATTLE_FEED_MIN_PLAYERS = 500;

export type DiscordFeedFilters = {
  minFame?: number;
  minSilver?: number;
  contentTypes?: string[];
  pingRoleId?: string;
  paused?: boolean;
  /** ISO timestamp: do not Discord-notify events that occurred before this. */
  notifyAfter?: string;
  /** Post guild battle recaps only when the tracked guild has this many players in the fight. */
  minPlayers?: number;
  /** Start a Discord thread on the first battle summary message. */
  createThread?: boolean;
};

export type FeedFilterPatch = {
  minFame?: number | null;
  minSilver?: number | null;
  contentTypes?: string[] | null;
  paused?: boolean | null;
  pingRoleId?: string | null;
  minPlayers?: number | null;
  createThread?: boolean | null;
};

export function parseFeedFilters(value: unknown): DiscordFeedFilters {
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

export function battlePreviewEventKey(feedId: string): string {
  return `battle-preview:${feedId}`;
}

export function applyFeedFilterPatch(
  current: DiscordFeedFilters,
  patch: FeedFilterPatch
): DiscordFeedFilters {
  const next = { ...current };
  if ("minFame" in patch) {
    if (patch.minFame && patch.minFame > 0) next.minFame = patch.minFame;
    else delete next.minFame;
  }
  if ("minSilver" in patch) {
    if (patch.minSilver && patch.minSilver > 0) next.minSilver = patch.minSilver;
    else delete next.minSilver;
  }
  if ("contentTypes" in patch) {
    const types = (patch.contentTypes ?? []).filter(
      (type) => type === "SOLO" || type === "GROUP" || type === "ZVZ"
    );
    if (types.length > 0) next.contentTypes = types;
    else delete next.contentTypes;
  }
  if ("paused" in patch) {
    if (patch.paused) next.paused = true;
    else delete next.paused;
  }
  if ("pingRoleId" in patch) {
    if (patch.pingRoleId) next.pingRoleId = patch.pingRoleId;
    else delete next.pingRoleId;
  }
  if ("minPlayers" in patch) {
    if (patch.minPlayers && patch.minPlayers > 0) {
      next.minPlayers = clampBattleMinPlayers(patch.minPlayers);
    } else delete next.minPlayers;
  }
  if ("createThread" in patch) {
    if (patch.createThread) next.createThread = true;
    else delete next.createThread;
  }
  return next;
}
