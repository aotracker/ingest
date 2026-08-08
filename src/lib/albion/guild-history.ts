import type { AlbionBattleSummary, AlbionGuildInfo, AlbionRegion } from "./types";
import { getGuildTopBattles } from "./battles";
import { PAGE_LOAD_REQUEST_OPTIONS } from "./client";
import { albionEventToKillCard, type KillCardEvent } from "./player-history";

export async function getGuildRecentBattles(
  region: AlbionRegion,
  guildId: string,
  limit = 10
) {
  return getGuildTopBattles(region, guildId, limit);
}

export async function getGuildLiveData(
  region: AlbionRegion,
  guildId: string,
  limit = 10
) {
  const { getAlbionClient } = await import("./client");

  const client = getAlbionClient();
  let topKillsError: string | null = null;
  let infoError: string | null = null;
  let battlesError: string | null = null;

  const [infoResult, topKillsResult, battlesResult] = await Promise.all([
    client
      .getGuildInfo(region, guildId, PAGE_LOAD_REQUEST_OPTIONS)
      .catch((err) => {
        infoError = err instanceof Error ? err.message : "Failed to load guild info";
        return null as AlbionGuildInfo | null;
      }),
    client
      .getGuildTopKills(region, guildId, {
        limit,
        requestOptions: PAGE_LOAD_REQUEST_OPTIONS,
      })
      .catch((err) => {
        topKillsError = err instanceof Error ? err.message : "Failed to load top kills";
        return [];
      }),
    getGuildTopBattles(region, guildId, limit).catch((err) => {
      battlesError =
        err instanceof Error ? err.message : "Failed to load top battles";
      return { battles: [], battlesError: battlesError };
    }),
  ]);

  const topKillEvents = topKillsResult.slice(0, limit);

  return {
    info: infoResult,
    infoError,
    topKills: topKillEvents.map((event) => albionEventToKillCard(region, event)),
    topKillsError,
    battles: battlesResult.battles,
    battlesError: battlesResult.battlesError ?? battlesError,
  };
}

export type GuildLiveData = {
  info: AlbionGuildInfo | null;
  infoError: string | null;
  topKills: KillCardEvent[];
  topKillsError: string | null;
  battles: AlbionBattleSummary[];
  battlesError: string | null;
};
