/**
 * Player/guild Twitch and YouTube links, live state, and stream sessions.
 * Usage: npm run db:apply-player-media (from ingest/)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      DO $$ BEGIN
        CREATE TYPE "media_platform" AS ENUM ('twitch', 'youtube');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      CREATE TABLE IF NOT EXISTS "player_media_links" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "region" "region" NOT NULL,
        "player_albion_id" text NOT NULL,
        "player_name" text NOT NULL,
        "platform" "media_platform" NOT NULL,
        "channel_id" text NOT NULL,
        "login" text NOT NULL,
        "display_name" text NOT NULL,
        "avatar_url" text,
        "created_by_user_id" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      DO $$ BEGIN
        ALTER TABLE "player_media_links"
          ADD CONSTRAINT "player_media_links_created_by_user_id_user_id_fk"
          FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id")
          ON DELETE set null ON UPDATE no action;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS "player_media_links_player_platform_idx"
        ON "player_media_links" ("region", "player_albion_id", "platform");
      CREATE UNIQUE INDEX IF NOT EXISTS "player_media_links_channel_idx"
        ON "player_media_links" ("platform", "channel_id");
      CREATE INDEX IF NOT EXISTS "player_media_links_player_idx"
        ON "player_media_links" ("region", "player_albion_id");

      CREATE TABLE IF NOT EXISTS "media_live_state" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "platform" "media_platform" NOT NULL,
        "channel_id" text NOT NULL,
        "is_live" boolean DEFAULT false NOT NULL,
        "title" text,
        "viewer_count" integer,
        "started_at" timestamp with time zone,
        "thumbnail_url" text,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "media_live_state_channel_idx"
        ON "media_live_state" ("platform", "channel_id");

      CREATE TABLE IF NOT EXISTS "media_stream_sessions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "platform" "media_platform" NOT NULL,
        "channel_id" text NOT NULL,
        "started_at" timestamp with time zone NOT NULL,
        "ended_at" timestamp with time zone,
        "vod_id" text,
        "vod_duration_seconds" integer,
        "title" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "media_stream_sessions_channel_started_idx"
        ON "media_stream_sessions" ("platform", "channel_id", "started_at");
      CREATE INDEX IF NOT EXISTS "media_stream_sessions_open_idx"
        ON "media_stream_sessions" ("platform", "channel_id");

      CREATE TABLE IF NOT EXISTS "guild_media_pins" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "region" "region" NOT NULL,
        "guild_albion_id" text NOT NULL,
        "guild_name" text NOT NULL,
        "platform" "media_platform" NOT NULL,
        "channel_id" text NOT NULL,
        "login" text NOT NULL,
        "display_name" text NOT NULL,
        "avatar_url" text,
        "created_by_user_id" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      DO $$ BEGIN
        ALTER TABLE "guild_media_pins"
          ADD CONSTRAINT "guild_media_pins_created_by_user_id_user_id_fk"
          FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id")
          ON DELETE set null ON UPDATE no action;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS "guild_media_pins_guild_platform_idx"
        ON "guild_media_pins" ("region", "guild_albion_id", "platform");
    `);
    console.log("player media tables ready.");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
