import { and, eq } from "drizzle-orm";
import type { AlbionRegion } from "@aotracker/core/albion/types";
import { db, schema } from "@aotracker/core/db";

export interface KillSnapshotItem {
  ownerRole: string;
  category: string;
  slot: string | null;
  itemType: string;
  quality: number | null;
  count: number | null;
}

export interface KillSnapshotParticipant {
  role: string;
  name: string | null;
  guildName: string | null;
  averageItemPower: string | null;
  allianceTag: string | null;
  guildAlbionId: string | null;
}

export interface KillSnapshot {
  eventId: number;
  region: AlbionRegion;
  occurredAt: Date;
  contentType: string;
  totalVictimKillFame: number | null;
  participantCount: number | null;
  assistCount: number;
  detailSyncedAt: Date | null;
  killer: KillSnapshotParticipant | null;
  victim: KillSnapshotParticipant | null;
  items: KillSnapshotItem[];
}

function allianceTagFromPayload(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const tag = (raw as { AllianceTag?: unknown }).AllianceTag;
  return typeof tag === "string" && tag.trim() ? tag.trim() : null;
}

function guildIdFromPayload(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const id = (raw as { GuildId?: unknown }).GuildId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export async function loadKillSnapshot(
  region: AlbionRegion,
  eventId: number
): Promise<KillSnapshot | null> {
  const event = await db.query.killEvents.findFirst({
    where: and(
      eq(schema.killEvents.region, region),
      eq(schema.killEvents.eventId, eventId)
    ),
    with: {
      participants: true,
      items: true,
    },
  });
  if (!event) return null;

  const mapParticipant = (
    row: (typeof event.participants)[number]
  ): KillSnapshotParticipant => ({
    role: row.role,
    name: row.name,
    guildName: row.guildName,
    averageItemPower: row.averageItemPower,
    allianceTag: allianceTagFromPayload(row.rawPayload),
    guildAlbionId: guildIdFromPayload(row.rawPayload),
  });

  const killerRow = event.participants.find((p) => p.role === "killer");
  const victimRow = event.participants.find((p) => p.role === "victim");
  const excludePlayerIds = new Set(
    [killerRow?.playerId, victimRow?.playerId].filter(
      (id): id is string => Boolean(id)
    )
  );
  const seenAssists = new Set<string>();
  let assistCount = 0;
  for (const participant of event.participants) {
    if (
      participant.role !== "participant" &&
      participant.role !== "group_member"
    ) {
      continue;
    }
    if (participant.playerId && excludePlayerIds.has(participant.playerId)) {
      continue;
    }
    const key = participant.playerId ?? participant.name ?? participant.id;
    if (seenAssists.has(key)) continue;
    seenAssists.add(key);
    assistCount += 1;
  }

  return {
    eventId: event.eventId,
    region: event.region,
    occurredAt: event.occurredAt,
    contentType: event.contentType,
    totalVictimKillFame: event.totalVictimKillFame,
    participantCount: event.participantCount,
    assistCount,
    detailSyncedAt: event.detailSyncedAt,
    killer: killerRow ? mapParticipant(killerRow) : null,
    victim: victimRow ? mapParticipant(victimRow) : null,
    items: event.items.map((item) => ({
      ownerRole: item.ownerRole,
      category: item.category,
      slot: item.slot,
      itemType: item.itemType,
      quality: item.quality,
      count: item.count,
    })),
  };
}

export function itemsFor(
  snapshot: KillSnapshot,
  ownerRole: "killer" | "victim",
  category: "equipment" | "inventory"
): KillSnapshotItem[] {
  return snapshot.items.filter(
    (item) => item.ownerRole === ownerRole && item.category === category
  );
}
