/**
 * Add user.preferred_region for synced feed region preference.
 * Usage: npm run db:apply-user-preferred-region (from ingest/)
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`
      ALTER TABLE "user"
        ADD COLUMN IF NOT EXISTS "preferred_region" text;
    `);
    console.log('user.preferred_region ready.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
