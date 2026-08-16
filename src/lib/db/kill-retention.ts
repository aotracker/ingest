import { and, inArray, isNull, lt } from "drizzle-orm";
import {
  KILL_STUB_TTL_DAYS,
  RETAIN_FULL_DAYS,
  killStubTtlCutoff,
} from "./retention";
import { db, schema } from "./index";

const EVICT_CHUNK_SIZE = 200;

export async function evictStaleKillDetails(options?: {
  olderThanDays?: number;
  limit?: number;
  dryRun?: boolean;
}): Promise<{ candidates: number; compacted: number }> {
  const olderThanDays = options?.olderThanDays ?? RETAIN_FULL_DAYS;
  const limit = options?.limit ?? 2_000;
  const dryRun = options?.dryRun === true;
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const now = new Date();

  const rows = await db
    .select({ id: schema.killEvents.id })
    .from(schema.killEvents)
    .where(
      and(
        isNull(schema.killEvents.detailEvictedAt),
        lt(schema.killEvents.occurredAt, cutoff)
      )
    )
    .limit(limit);

  if (rows.length === 0) {
    return { candidates: 0, compacted: 0 };
  }

  if (dryRun) {
    return { candidates: rows.length, compacted: 0 };
  }

  const ids = rows.map((row) => row.id);
  let compacted = 0;
  for (let i = 0; i < ids.length; i += EVICT_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + EVICT_CHUNK_SIZE);
    await db
      .delete(schema.killItems)
      .where(inArray(schema.killItems.eventId, chunk));
    await db
      .delete(schema.killParticipants)
      .where(inArray(schema.killParticipants.eventId, chunk));
    await db
      .update(schema.killEvents)
      .set({
        rawPayload: null,
        detailEvictedAt: now,
      })
      .where(inArray(schema.killEvents.id, chunk));
    compacted += chunk.length;
  }

  return { candidates: rows.length, compacted };
}

export async function deleteExpiredKillStubs(options?: {
  stubTtlDays?: number;
  limit?: number;
  dryRun?: boolean;
}): Promise<{ candidates: number; deleted: number }> {
  const stubTtlDays = options?.stubTtlDays ?? KILL_STUB_TTL_DAYS;
  const limit = options?.limit ?? 2_000;
  const dryRun = options?.dryRun === true;
  const cutoff =
    options?.stubTtlDays != null
      ? new Date(Date.now() - stubTtlDays * 24 * 60 * 60 * 1000)
      : killStubTtlCutoff();

  const rows = await db
    .select({ id: schema.killEvents.id })
    .from(schema.killEvents)
    .where(lt(schema.killEvents.occurredAt, cutoff))
    .limit(limit);

  if (rows.length === 0) {
    return { candidates: 0, deleted: 0 };
  }

  if (dryRun) {
    return { candidates: rows.length, deleted: 0 };
  }

  const ids = rows.map((row) => row.id);
  let deleted = 0;
  for (let i = 0; i < ids.length; i += EVICT_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + EVICT_CHUNK_SIZE);
    await db
      .delete(schema.killEvents)
      .where(inArray(schema.killEvents.id, chunk));
    deleted += chunk.length;
  }

  return { candidates: rows.length, deleted };
}
