import { and, eq } from "drizzle-orm";
import type { AlbionRegion } from "../albion/types";
import { db, schema } from "./index";

export async function isKillEventCached(
  region: AlbionRegion,
  eventId: number
): Promise<boolean> {
  const row = await db.query.killEvents.findFirst({
    where: and(
      eq(schema.killEvents.eventId, eventId),
      eq(schema.killEvents.region, region)
    ),
    columns: { detailSyncedAt: true },
  });

  return Boolean(row?.detailSyncedAt);
}
