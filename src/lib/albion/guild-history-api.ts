import type { AlbionGuildInfo, AlbionRegion } from "./types";

/** Worker-only: fetch guild info and top kills from Albion API. */
export async function fetchGuildDataFromApi(
  region: AlbionRegion,
  guildId: string,
  limit = 10
) {
  const { getAlbionClient } = await import("./client");
  const client = getAlbionClient();

  const [info, topKills] = await Promise.all([
    client.getGuildInfo(region, guildId).catch(() => null as AlbionGuildInfo | null),
    client
      .getGuildTopKills(region, guildId, { limit })
      .catch(() => []),
  ]);

  return { info, topKills };
}
