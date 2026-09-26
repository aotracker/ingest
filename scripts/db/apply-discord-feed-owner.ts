/**
 * Require a site user on Discord guild feeds.
 * Usage: npm run db:apply-discord-feed-owner (from ingest/)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      ALTER TABLE "discord_feeds"
        ADD COLUMN IF NOT EXISTS "created_by_discord_user_id" text;

      UPDATE "discord_feeds" AS f
      SET "created_by_discord_user_id" = a.account_id
      FROM "account" AS a
      WHERE f.created_by_user_id = a.user_id
        AND a.provider_id = 'discord'
        AND f.created_by_discord_user_id IS NULL;

      UPDATE "discord_feeds" AS f
      SET
        "created_by_discord_user_id" = f.created_by_user_id,
        "created_by_user_id" = a.user_id
      FROM "account" AS a
      WHERE a.provider_id = 'discord'
        AND a.account_id = f.created_by_user_id
        AND f.created_by_user_id IS DISTINCT FROM a.user_id;

      UPDATE "discord_feeds" AS f
      SET "enabled" = 0, "created_by_user_id" = NULL
      WHERE f.created_by_user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "user" AS u WHERE u.id = f.created_by_user_id
        );

      DO $$ BEGIN
        ALTER TABLE "discord_feeds"
          ADD CONSTRAINT "discord_feeds_created_by_user_id_user_id_fk"
          FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id")
          ON DELETE set null ON UPDATE no action;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    console.log("discord_feeds owner columns ready.");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
