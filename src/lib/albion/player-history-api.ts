import type { AlbionEvent, AlbionRegion } from "./types";
import { albionEventToKillCard, type KillCardEvent } from "./player-history";

/** Worker-only: fetch player kill/death history from Albion API. */
export async function fetchPlayerHistoryFromApi(
  region: AlbionRegion,
  playerId: string
): Promise<{ kills: AlbionEvent[]; deaths: AlbionEvent[] }> {
  const { getAlbionClient } = await import("./client");
  const client = getAlbionClient();

  const [kills, deaths] = await Promise.all([
    client.getPlayerKills(region, playerId).catch(() => [] as AlbionEvent[]),
    client.getPlayerDeaths(region, playerId).catch(() => [] as AlbionEvent[]),
  ]);

  return { kills, deaths };
}

export type { KillCardEvent };

export { albionEventToKillCard };
