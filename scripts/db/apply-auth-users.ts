/**
 * Create Better Auth + user prefs tables (user, session, account, verification,
 * user_watchlist_entries, user_recent_searches).
 * Usage: npm run db:apply-auth-users (from ingest/, OVH VM or local dev)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "user" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "email" text NOT NULL,
        "email_verified" boolean DEFAULT false NOT NULL,
        "image" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        "is_admin" boolean DEFAULT false NOT NULL,
        CONSTRAINT "user_email_unique" UNIQUE("email")
      );
      CREATE TABLE IF NOT EXISTS "session" (
        "id" text PRIMARY KEY NOT NULL,
        "expires_at" timestamp with time zone NOT NULL,
        "token" text NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        "ip_address" text,
        "user_agent" text,
        "user_id" text NOT NULL,
        CONSTRAINT "session_token_unique" UNIQUE("token")
      );
      CREATE TABLE IF NOT EXISTS "account" (
        "id" text PRIMARY KEY NOT NULL,
        "issuer" text NOT NULL,
        "account_id" text NOT NULL,
        "provider_id" text NOT NULL,
        "user_id" text NOT NULL,
        "access_token" text,
        "refresh_token" text,
        "id_token" text,
        "access_token_expires_at" timestamp with time zone,
        "refresh_token_expires_at" timestamp with time zone,
        "scope" text,
        "password" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      -- Existing installs created account without issuer (pre Better Auth 1.7).
      ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text;
      UPDATE "account"
        SET "issuer" = 'local:oauth:' || "provider_id"
        WHERE "issuer" IS NULL OR "issuer" = '';
      ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_account_id_uidx"
        ON "account" ("issuer","account_id");
      CREATE TABLE IF NOT EXISTS "verification" (
        "id" text PRIMARY KEY NOT NULL,
        "identifier" text NOT NULL,
        "value" text NOT NULL,
        "expires_at" timestamp with time zone NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "user_watchlist_entries" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" text NOT NULL,
        "type" text NOT NULL,
        "region" "region" NOT NULL,
        "albion_id" text NOT NULL,
        "name" text NOT NULL,
        "added_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "user_recent_searches" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" text NOT NULL,
        "q" text DEFAULT '' NOT NULL,
        "region" text NOT NULL,
        "type" text,
        "path" text,
        "searched_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      DO $$ BEGIN
        ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk"
          FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
      DO $$ BEGIN
        ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk"
          FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
      DO $$ BEGIN
        ALTER TABLE "user_watchlist_entries" ADD CONSTRAINT "user_watchlist_entries_user_id_user_id_fk"
          FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
      DO $$ BEGIN
        ALTER TABLE "user_recent_searches" ADD CONSTRAINT "user_recent_searches_user_id_user_id_fk"
          FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS "user_watchlist_entries_unique_idx"
        ON "user_watchlist_entries" ("user_id","type","region","albion_id");
      CREATE INDEX IF NOT EXISTS "user_watchlist_entries_user_idx"
        ON "user_watchlist_entries" ("user_id");
      CREATE INDEX IF NOT EXISTS "user_recent_searches_user_searched_idx"
        ON "user_recent_searches" ("user_id","searched_at");
    `);
    console.log(
      "user / session / account / verification / user_watchlist_entries / user_recent_searches ready."
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
