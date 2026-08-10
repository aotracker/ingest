import IORedis from "ioredis";

const globalForRedis = globalThis as unknown as {
  redis: IORedis | undefined;
};

function resolveRedisUrl(): string {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    throw new Error(
      "REDIS_URL is required for BullMQ job queues (e.g. redis://localhost:6379)"
    );
  }
  return url;
}

const REDIS_CLIENT_OPTIONS: IORedis.RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  reconnectOnError(err) {
    const message = err.message;
    if (message.includes("READONLY")) {
      console.warn("[redis] READONLY — reconnecting after role change");
      return true;
    }
    return false;
  },
};

export async function assertRedisWritable(): Promise<void> {
  const redis = new IORedis(resolveRedisUrl(), REDIS_CLIENT_OPTIONS);
  const key = `ingest:write-check:${Date.now()}`;
  try {
    await redis.set(key, "1", "EX", 30);
    await redis.del(key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("READONLY")) {
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

export function getRedisConnection(): IORedis {
  if (!globalForRedis.redis) {
    globalForRedis.redis = new IORedis(resolveRedisUrl(), REDIS_CLIENT_OPTIONS);
  }
  return globalForRedis.redis;
}

export function createRedisConnection(): IORedis {
  return new IORedis(resolveRedisUrl(), REDIS_CLIENT_OPTIONS);
}
