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

export function getRedisConnection(): IORedis {
  if (!globalForRedis.redis) {
    globalForRedis.redis = new IORedis(resolveRedisUrl(), {
      maxRetriesPerRequest: null,
    });
  }
  return globalForRedis.redis;
}

export function createRedisConnection(): IORedis {
  return new IORedis(resolveRedisUrl(), {
    maxRetriesPerRequest: null,
  });
}
