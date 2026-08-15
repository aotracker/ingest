import Redis, { type RedisOptions } from "ioredis";

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

/** Consecutive READONLY errors before the process exits (PM2 restarts). */
const READONLY_FAIL_THRESHOLD = 3;

/** Background write probe interval for long-running worker/API processes. */
export const REDIS_HEARTBEAT_MS = 60_000;

let consecutiveReadonlyErrors = 0;
let healthMonitorTimer: ReturnType<typeof setInterval> | null = null;

function resolveRedisUrl(): string {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    throw new Error(
      "REDIS_URL is required for BullMQ job queues (e.g. redis://localhost:6379)"
    );
  }
  return url;
}

export function isRedisReadonlyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("READONLY");
}

function fatalRedisReadonly(reason: string): never {
  console.error(`[redis] ${reason} — exiting so PM2 can restart`);
  process.exit(1);
}

export function noteRedisWritableSuccess(): void {
  consecutiveReadonlyErrors = 0;
}

export function noteRedisReadonlyFailure(source: string): void {
  consecutiveReadonlyErrors += 1;
  console.warn(
    `[redis] READONLY from ${source} (${consecutiveReadonlyErrors}/${READONLY_FAIL_THRESHOLD})`
  );
  if (consecutiveReadonlyErrors >= READONLY_FAIL_THRESHOLD) {
    fatalRedisReadonly(
      `Redis still read-only after ${READONLY_FAIL_THRESHOLD} attempts`
    );
  }
}

const REDIS_CLIENT_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  reconnectOnError(err: Error) {
    if (isRedisReadonlyError(err)) {
      noteRedisReadonlyFailure("reconnectOnError");
      return true;
    }
    return false;
  },
};

export type RedisWritableStatus = {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
};

export async function checkRedisWritable(
  redis?: Redis
): Promise<RedisWritableStatus> {
  const start = Date.now();
  const client = redis ?? getRedisConnection();
  const key = `ingest:health:${Date.now()}`;
  try {
    await client.set(key, "1", "EX", 30);
    await client.del(key);
    noteRedisWritableSuccess();
    return { ok: true, latencyMs: Date.now() - start, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isRedisReadonlyError(err)) {
      noteRedisReadonlyFailure("write-check");
    }
    return { ok: false, latencyMs: null, error: message };
  }
}

export async function assertRedisWritable(): Promise<void> {
  const redis = new Redis(resolveRedisUrl(), REDIS_CLIENT_OPTIONS);
  const key = `ingest:write-check:${Date.now()}`;
  try {
    await redis.set(key, "1", "EX", 30);
    await redis.del(key);
    noteRedisWritableSuccess();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isRedisReadonlyError(err)) {
      noteRedisReadonlyFailure("startup");
      throw new Error(
        "Redis is read-only (replica). Check: docker exec albion-redis redis-cli INFO replication. " +
          "If role:slave, promote: docker exec albion-redis redis-cli REPLICAOF NO ONE"
      );
    }
    throw err;
  } finally {
    redis.disconnect();
  }
}

/** Periodic write probe — exits the process when Redis stays read-only. */
export function startRedisHealthMonitor(): () => void {
  if (healthMonitorTimer) {
    return () => {
      clearInterval(healthMonitorTimer!);
      healthMonitorTimer = null;
    };
  }

  healthMonitorTimer = setInterval(() => {
    void checkRedisWritable().then((result) => {
      if (!result.ok) {
        console.error(`[redis] Heartbeat write failed: ${result.error}`);
      }
    });
  }, REDIS_HEARTBEAT_MS);

  healthMonitorTimer.unref?.();

  return () => {
    if (healthMonitorTimer) {
      clearInterval(healthMonitorTimer);
      healthMonitorTimer = null;
    }
  };
}

export function getRedisConnection(): Redis {
  if (!globalForRedis.redis) {
    globalForRedis.redis = new Redis(resolveRedisUrl(), REDIS_CLIENT_OPTIONS);
  }
  return globalForRedis.redis;
}

export function createRedisConnection(): Redis {
  return new Redis(resolveRedisUrl(), REDIS_CLIENT_OPTIONS);
}
