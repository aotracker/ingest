/**
 * Claimed Albion characters for signed-in site users.
 * Usage: npm run db:apply-user-claimed-characters (from ingest/)
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "user_claimed_characters" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" text NOT NULL,
        "region" "region" NOT NULL,
        "albion_id" text NOT NULL,
        "claimed_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      DO $$ BEGIN
        ALTER TABLE "user_claimed_characters"
          ADD CONSTRAINT "user_claimed_characters_user_id_user_id_fk"
          FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
          ON DELETE cascade ON UPDATE no action;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS "user_claimed_characters_region_albion_idx"
        ON "user_claimed_characters" ("region", "albion_id");
      CREATE UNIQUE INDEX IF NOT EXISTS "user_claimed_characters_user_region_idx"
        ON "user_claimed_characters" ("user_id", "region");
      CREATE INDEX IF NOT EXISTS "user_claimed_characters_user_idx"
        ON "user_claimed_characters" ("user_id");
    `);
    console.log("user_claimed_characters ready.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
