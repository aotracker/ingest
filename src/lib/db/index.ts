import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://albion:albion@localhost:5432/albion_kills";

const usePooler = process.env.DATABASE_USE_POOLER === "true";

function resolvePoolMax(): number {
  const configured = process.env.DATABASE_POOL_MAX;
  if (configured !== undefined && configured !== "") {
    const parsed = parseInt(configured, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return process.env.VERCEL === "1" ? 1 : 3;
}

const globalForDb = globalThis as unknown as {
  conn: ReturnType<typeof postgres> | undefined;
};

const conn =
  globalForDb.conn ??
  postgres(connectionString, {
    max: resolvePoolMax(),
    prepare: !usePooler,
  });

globalForDb.conn = conn;

export const db = drizzle(conn, { schema });
export { schema };
