import { and, eq, isNull, lte, or } from "drizzle-orm";
import { db, schema } from "./index";
import type { AlbionRegion } from "../albion/types";

/** How long the circuit stays open before a probe request is allowed. */
export const CIRCUIT_RESET_MS = 60_000;
/** Final failed requests (after retries) required to open the circuit. */
const CIRCUIT_FAILURE_THRESHOLD = 5;
/** Default job re-queue delay when a worker hits an open circuit. */
export const CIRCUIT_JOB_DEFER_MS = 30_000;
/** Soft circuit defers before a job is marked failed instead of looping forever. */
export const CIRCUIT_MAX_JOB_DEFERS = 10;

export class CircuitOpenError extends Error {
  readonly region: AlbionRegion;

  constructor(region: AlbionRegion) {
    super(`Circuit breaker open for region: ${region}`);
    this.name = "CircuitOpenError";
    this.region = region;
  }
}

export function isCircuitOpenError(error: unknown): error is CircuitOpenError {
  return error instanceof CircuitOpenError ||
    (error instanceof Error && error.name === "CircuitOpenError");
}

async function ensureRegionState(region: AlbionRegion) {
  const existing = await db.query.apiSyncState.findFirst({
    where: eq(schema.apiSyncState.region, region),
  });
  if (existing) return existing;

  const [inserted] = await db
    .insert(schema.apiSyncState)
    .values({ region })
    .returning();
  return inserted;
}

export async function getRegionHealthMetrics(region: AlbionRegion) {
  const state = await ensureRegionState(region);
  return {
    circuitOpen: (state.circuitOpen ?? 0) === 1,
    consecutiveFailures: state.consecutiveFailures ?? 0,
    lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
    lastErrorAt: state.lastErrorAt?.toISOString() ?? null,
    lastErrorMessage: state.lastErrorMessage ?? null,
    avgLatencyMs: state.avgLatencyMs ?? 0,
  };
}

export async function ensureCircuitAllows(region: AlbionRegion): Promise<void> {
  const state = await ensureRegionState(region);
  if ((state.circuitOpen ?? 0) !== 1 || !state.circuitOpenedAt) return;

  const elapsed = Date.now() - state.circuitOpenedAt.getTime();
  if (elapsed < CIRCUIT_RESET_MS) {
    throw new CircuitOpenError(region);
  }

  await db
    .update(schema.apiSyncState)
    .set({
      circuitOpen: 0,
      consecutiveFailures: 0,
      circuitOpenedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.apiSyncState.region, region));
}

export async function enforceSharedRateLimit(
  region: AlbionRegion,
  minIntervalMs: number
): Promise<void> {
  await ensureRegionState(region);

  // Atomic claim of the next request slot so ingest + process workers cannot
  // race past the shared interval with a non-atomic read/sleep/write.
  for (;;) {
    const now = new Date();
    const nextAllowed = new Date(now.getTime() + minIntervalMs);

    const claimed = await db
      .update(schema.apiSyncState)
      .set({ rateLimitUntil: nextAllowed, updatedAt: now })
      .where(
        and(
          eq(schema.apiSyncState.region, region),
          or(
            isNull(schema.apiSyncState.rateLimitUntil),
            lte(schema.apiSyncState.rateLimitUntil, now)
          )
        )
      )
      .returning({ id: schema.apiSyncState.id });

    if (claimed.length > 0) return;

    const state = await ensureRegionState(region);
    const waitMs = state.rateLimitUntil
      ? state.rateLimitUntil.getTime() - Date.now()
      : 50;
    await sleep(Math.max(25, waitMs));
  }
}

export async function recordHealthCheck(
  region: AlbionRegion,
  result: { ok: boolean; latencyMs: number; note?: string }
): Promise<void> {
  await ensureRegionState(region);
  const now = new Date();

  await db
    .update(schema.apiSyncState)
    .set({
      lastHealthCheckAt: now,
      lastHealthCheckOk: result.ok ? 1 : 0,
      updatedAt: now,
    })
    .where(eq(schema.apiSyncState.region, region));

  await db.insert(schema.apiRequestLogs).values({
    region,
    endpoint: "health-check",
    latencyMs: result.latencyMs,
    status: result.ok ? "success" : "error",
    errorType: result.ok ? undefined : "health_check",
    errorMessage: result.ok ? undefined : result.note ?? "Health check failed",
  });
}

export async function recordApiSuccess(
  region: AlbionRegion,
  endpoint: string,
  latencyMs: number
): Promise<void> {
  const state = await ensureRegionState(region);
  const now = new Date();
  const prevAvg = state.avgLatencyMs ?? 0;
  const newAvg = prevAvg ? Math.round(prevAvg * 0.8 + latencyMs * 0.2) : latencyMs;

  await db
    .update(schema.apiSyncState)
    .set({
      lastSuccessAt: now,
      consecutiveFailures: 0,
      circuitOpen: 0,
      circuitOpenedAt: null,
      avgLatencyMs: newAvg,
      updatedAt: now,
    })
    .where(eq(schema.apiSyncState.region, region));

  await db.insert(schema.apiRequestLogs).values({
    region,
    endpoint,
    latencyMs,
    status: "success",
  });
}

/** Log a soft miss (e.g. 404 not published yet) without opening the region circuit. */
export async function recordApiSoftMiss(
  region: AlbionRegion,
  endpoint: string,
  latencyMs: number,
  errorMessage: string
): Promise<void> {
  await ensureRegionState(region);
  await db.insert(schema.apiRequestLogs).values({
    region,
    endpoint,
    latencyMs,
    status: "miss",
    errorType: "not_found",
    errorMessage,
  });
}

export async function recordApiFailure(
  region: AlbionRegion,
  endpoint: string,
  latencyMs: number,
  errorType: string,
  errorMessage: string
): Promise<void> {
  const state = await ensureRegionState(region);
  const now = new Date();
  const failures = (state.consecutiveFailures ?? 0) + 1;

  const updates: Partial<typeof schema.apiSyncState.$inferInsert> = {
    lastErrorAt: now,
    lastErrorMessage: errorMessage,
    consecutiveFailures: failures,
    updatedAt: now,
  };

  if (failures >= CIRCUIT_FAILURE_THRESHOLD) {
    updates.circuitOpen = 1;
    updates.circuitOpenedAt = now;
  }

  await db
    .update(schema.apiSyncState)
    .set(updates)
    .where(eq(schema.apiSyncState.region, region));

  await db.insert(schema.apiRequestLogs).values({
    region,
    endpoint,
    latencyMs,
    status: "error",
    errorType,
    errorMessage,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
