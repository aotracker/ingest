import postgres from "postgres";

export async function withDatabaseUrl<T>(
  work: (sql: postgres.Sql) => Promise<T>,
  options?: { endTimeout?: number }
): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const sql = postgres(url, { max: 1 });
  try {
    return await work(sql);
  } finally {
    await sql.end(
      options?.endTimeout != null ? { timeout: options.endTimeout } : undefined
    );
  }
}
