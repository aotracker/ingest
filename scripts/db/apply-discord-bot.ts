/**
 * Create Discord bot tables (servers, feeds, post log).
 * Usage: npm run db:apply-discord-bot (from ingest/, OVH VM or local dev)
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "discord_servers" (
        "discord_guild_id" text PRIMARY KEY NOT NULL,
        "name" text,
        "installed_at" timestamp with time zone DEFAULT now() NOT NULL,
        "left_at" timestamp with time zone,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "discord_feeds" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "discord_guild_id" text NOT NULL,
        "feed_type" text NOT NULL,
        "target_type" text NOT NULL,
        "target_albion_id" text NOT NULL,
        "region" "region" NOT NULL,
        "target_name" text,
        "channel_id" text,
        "filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "enabled" integer DEFAULT 1 NOT NULL,
        "created_by_user_id" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "discord_post_log" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "feed_id" uuid NOT NULL,
        "event_key" text NOT NULL,
        "discord_message_id" text,
        "posted_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      DO $$ BEGIN
        ALTER TABLE "discord_feeds" ADD CONSTRAINT "discord_feeds_discord_guild_id_discord_servers_discord_guild_id_fk"
          FOREIGN KEY ("discord_guild_id") REFERENCES "public"."discord_servers"("discord_guild_id") ON DELETE cascade ON UPDATE no action;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
      DO $$ BEGIN
        ALTER TABLE "discord_post_log" ADD CONSTRAINT "discord_post_log_feed_id_discord_feeds_id_fk"
          FOREIGN KEY ("feed_id") REFERENCES "public"."discord_feeds"("id") ON DELETE cascade ON UPDATE no action;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS "discord_feeds_unique_idx"
        ON "discord_feeds" ("discord_guild_id","feed_type","target_albion_id","region");
      CREATE INDEX IF NOT EXISTS "discord_feeds_target_idx"
        ON "discord_feeds" ("target_type","target_albion_id","region","feed_type");
      CREATE INDEX IF NOT EXISTS "discord_feeds_guild_idx"
        ON "discord_feeds" ("discord_guild_id");
      CREATE UNIQUE INDEX IF NOT EXISTS "discord_post_log_feed_event_idx"
        ON "discord_post_log" ("feed_id","event_key");
    `);
    console.log("discord_servers / discord_feeds / discord_post_log ready.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
