import { getAlbionClient } from "@aotracker/core/albion/client";
import type { AlbionRegion } from "@aotracker/core/albion/types";
import {
  ensureGuildSyncQueued,
  ensurePlayerSyncQueued,
} from "./jobs/enqueue";
import { upsertGuildFromInfo, upsertPlayer } from "./ingest";

export type EntityResolveType = "player" | "guild";

export type EntityResolveResult = {
  albionId: string;
};

export function entityResolveDedupeKey(
  region: AlbionRegion,
  entityType: EntityResolveType,
  name: string
): string {
  return `entity-resolve-${region}-${entityType}-${encodeURIComponent(name)}`;
}

export async function resolveEntityByName(
  region: AlbionRegion,
  entityType: EntityResolveType,
  name: string
): Promise<EntityResolveResult | null> {
  const client = getAlbionClient();
  const result = await client.search(region, name, {
    timeout: 8_000,
    maxRetries: 1,
  });

  if (entityType === "player") {
    const match = result.players.find((player) => player.Name === name);
    const albionId = match?.Id?.trim();
    if (!albionId || !match) return null;

    await upsertPlayer(region, match);
    await ensurePlayerSyncQueued(region, albionId, { immediate: true });
    return { albionId };
  }

  const match = result.guilds.find((guild) => guild.Name === name);
  const albionId = match?.Id?.trim();
  if (!albionId || !match) return null;

  await upsertGuildFromInfo(region, match);
  await ensureGuildSyncQueued(region, albionId, { immediate: true });
  return { albionId };
}
