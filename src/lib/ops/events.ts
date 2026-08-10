import type { AlbionRegion } from "@aotracker/core/albion/types";
import { db, schema } from "@aotracker/core/db";

export const OPS_EVENTS_RETENTION_DAYS = 30;
export const OPS_EVENTS_RETENTION_MS =
  OPS_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type OpsEventSource =
  | "worker"
  | "ingest"
  | "api"
  | "job"
  | "scheduler";

export type OpsEventSeverity = "error" | "warning" | "info";

export interface RecordOpsEventInput {
  source: OpsEventSource;
  severity: OpsEventSeverity;
  category?: string;
  region?: AlbionRegion;
  message: string;
  details?: Record<string, unknown>;
}

export async function recordOpsEvent(
  input: RecordOpsEventInput
): Promise<void> {
  try {
    await db.insert(schema.opsEvents).values({
      source: input.source,
      severity: input.severity,
      category: input.category ?? null,
      region: input.region ?? null,
      message: input.message,
      details: input.details ?? {},
    });
  } catch (err) {
    console.warn("[ops-events] failed to record event:", err);
  }
}

export async function purgeOldOpsEvents(): Promise<void> {
  const { lte } = await import("drizzle-orm");
  const cutoff = new Date(Date.now() - OPS_EVENTS_RETENTION_MS);
  await db
    .delete(schema.opsEvents)
    .where(lte(schema.opsEvents.createdAt, cutoff));
}
