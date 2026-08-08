import { cache } from "../cache";
import { classifyContentType } from "./classify";
import type { AlbionEvent, AlbionPlayerRef, AlbionRegion } from "./types";

export interface KillCardEvent {
  eventId: number;
  region: string;
  occurredAt: Date;
  contentType: string;
  totalVictimKillFame: number | null;
  killer?: {
    albionId: string;
    name: string;
    guild?: { name: string; albionId?: string } | null;
  } | null;
  victim?: {
    albionId: string;
    name: string;
    guild?: { name: string; albionId?: string } | null;
  } | null;
  items?: {
    ownerRole: string;
    slot: string | null;
    itemType: string;
    quality: number | null;
    category: string;
  }[];
  participants?: {
    role: string;
    averageItemPower: string | null;
  }[];
}

function extractDisplayItems(
  player: AlbionPlayerRef | undefined,
  ownerRole: "killer" | "victim"
) {
  if (!player) return [];

  const items: KillCardEvent["items"] = [];

  if (player.Equipment?.MainHand?.Type) {
    items.push({
      ownerRole,
      slot: "MainHand",
      itemType: player.Equipment.MainHand.Type,
      quality: player.Equipment.MainHand.Quality ?? 0,
      category: "equipment",
    });
  }

  for (const item of player.Inventory ?? []) {
    if (item?.Type) {
      items.push({
        ownerRole,
        slot: null,
        itemType: item.Type,
        quality: item.Quality ?? 0,
        category: "inventory",
      });
    }
  }

  return items;
}

/** Guild membership captured on the kill event payload (not the player's current guild). */
export function guildAtKillFromRef(
  ref: AlbionPlayerRef | undefined
): { name: string; albionId?: string } | null {
  if (!ref) return null;
  const name = ref.GuildName?.trim();
  if (!name) return null;
  return {
    name,
    ...(ref.GuildId ? { albionId: ref.GuildId } : {}),
  };
}

/** Prefer guild from kill payload, then participant row, then player's current guild. */
export function resolveGuildAtKill(
  ref: AlbionPlayerRef | undefined,
  participantGuildName?: string | null,
  currentGuild?: { name: string; albionId: string } | null
): { name: string; albionId?: string } | null {
  const fromPayload = guildAtKillFromRef(ref);
  if (fromPayload) return fromPayload;

  const name = participantGuildName?.trim();
  if (name) return { name };

  if (currentGuild) {
    return { name: currentGuild.name, albionId: currentGuild.albionId };
  }

  return null;
}

export function albionEventToKillCard(
  region: AlbionRegion,
  event: AlbionEvent
): KillCardEvent {
  const contentType = classifyContentType({
    killer: event.Killer,
    victim: event.Victim,
    participantCount: event.numberOfParticipants,
    groupMemberCount: event.groupMemberCount ?? event.GroupMemberCount,
    groupMembers: event.GroupMembers,
    participants: event.Participants,
  });

  return {
    eventId: event.EventId,
    region,
    occurredAt: new Date(event.TimeStamp),
    contentType,
    totalVictimKillFame: event.TotalVictimKillFame ?? null,
    killer: event.Killer?.Id
      ? {
          albionId: event.Killer.Id,
          name: event.Killer.Name ?? "Unknown",
          guild: guildAtKillFromRef(event.Killer),
        }
      : null,
    victim: event.Victim?.Id
      ? {
          albionId: event.Victim.Id,
          name: event.Victim.Name ?? "Unknown",
          guild: guildAtKillFromRef(event.Victim),
        }
      : null,
    items: [
      ...extractDisplayItems(event.Killer, "killer"),
      ...extractDisplayItems(event.Victim, "victim"),
    ],
    participants: [
      ...(event.Killer?.AverageItemPower != null
        ? [
            {
              role: "killer",
              averageItemPower: String(event.Killer.AverageItemPower),
            },
          ]
        : []),
      ...(event.Victim?.AverageItemPower != null
        ? [
            {
              role: "victim",
              averageItemPower: String(event.Victim.AverageItemPower),
            },
          ]
        : []),
    ],
  };
}

export const getPlayerLiveHistory = cache(async function getPlayerLiveHistory(
  region: AlbionRegion,
  playerId: string,
  limit = 10
) {
  const { getAlbionClient } = await import("./client");

  const client = getAlbionClient();
  let killsError: string | null = null;
  let deathsError: string | null = null;

  const [killsResult, deathsResult] = await Promise.all([
    client.getPlayerKills(region, playerId).catch((err) => {
      killsError = err instanceof Error ? err.message : "Failed to load kills";
      return [] as AlbionEvent[];
    }),
    client.getPlayerDeaths(region, playerId).catch((err) => {
      deathsError = err instanceof Error ? err.message : "Failed to load deaths";
      return [] as AlbionEvent[];
    }),
  ]);

  const kills = killsResult.slice(0, limit);
  const deaths = deathsResult.slice(0, limit);

  return {
    kills: kills.map((event) => albionEventToKillCard(region, event)),
    deaths: deaths.map((event) => albionEventToKillCard(region, event)),
    killsError,
    deathsError,
  };
});
