import { createHash } from "crypto";

export const HISTORY_SYNC_STALE_MS = 15 * 60 * 1000;

export function hashPayload(value: unknown): string {
  const normalized = stableStringify(value);
  return createHash("sha256").update(normalized).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

export function normalizeScalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return hashPayload(value);
  return String(value);
}

export function profileFieldsChanged(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  fields: string[]
): boolean {
  for (const field of fields) {
    if (normalizeScalar(existing[field]) !== normalizeScalar(incoming[field])) {
      return true;
    }
  }
  return false;
}

export function shouldUpdateEntity(
  existing: { rawPayload?: unknown } | null | undefined,
  incomingRaw: unknown,
  scalarExisting: Record<string, unknown>,
  scalarIncoming: Record<string, unknown>,
  scalarFields: string[]
): { changed: boolean; reason?: string } {
  if (!existing) {
    return { changed: true, reason: "new_entity" };
  }

  if (profileFieldsChanged(scalarExisting, scalarIncoming, scalarFields)) {
    return { changed: true, reason: "scalar_fields" };
  }

  const existingHash = hashPayload(existing.rawPayload ?? null);
  const incomingHash = hashPayload(incomingRaw);
  if (existingHash !== incomingHash) {
    return { changed: true, reason: "raw_payload" };
  }

  return { changed: false };
}

export function isSyncStale(
  lastSyncedAt: Date | null | undefined,
  thresholdMs = HISTORY_SYNC_STALE_MS
): boolean {
  if (!lastSyncedAt) return true;
  return Date.now() - lastSyncedAt.getTime() > thresholdMs;
}
