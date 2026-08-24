import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  numeric,
  jsonb,
  timestamp,
  date,
  boolean,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

export const regionEnum = pgEnum("region", ["americas", "europe", "asia"]);
export const contentTypeEnum = pgEnum("content_type", [
  "ZVZ",
  "SOLO",
  "GROUP",
]);
export const ownerRoleEnum = pgEnum("owner_role", [
  "killer",
  "victim",
  "group_member",
  "participant",
]);
export const itemCategoryEnum = pgEnum("item_category", ["equipment", "inventory"]);

export const guilds = pgTable(
  "guilds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    albionId: text("albion_id").notNull(),
    region: regionEnum("region").notNull(),
    name: text("name").notNull(),
    allianceId: text("alliance_id"),
    allianceName: text("alliance_name"),
    allianceTag: text("alliance_tag"),
    killFame: bigint("kill_fame", { mode: "number" }).default(0),
    deathFame: bigint("death_fame", { mode: "number" }).default(0),
    memberCount: integer("member_count"),
    rawPayload: jsonb("raw_payload"),
    topBattlesPayload: jsonb("top_battles_payload"),
    recentBattlesPayload: jsonb("recent_battles_payload"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    historyLastSyncedAt: timestamp("history_last_synced_at", { withTimezone: true }),
    battlesLastSyncedAt: timestamp("battles_last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("guilds_albion_region_idx").on(t.albionId, t.region),
    index("guilds_name_idx").on(t.name),
    index("guilds_alliance_idx").on(t.region, t.allianceId),
  ]
);

export const alliances = pgTable(
  "alliances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    albionId: text("albion_id").notNull(),
    region: regionEnum("region").notNull(),
    name: text("name").notNull(),
    tag: text("tag"),
    memberCount: integer("member_count"),
    founderId: text("founder_id"),
    founderName: text("founder_name"),
    founded: text("founded"),
    killFame: bigint("kill_fame", { mode: "number" }).default(0),
    deathFame: bigint("death_fame", { mode: "number" }).default(0),
    guildsJson: jsonb("guilds_json"),
    rawPayload: jsonb("raw_payload"),
    topBattlesPayload: jsonb("top_battles_payload"),
    recentBattlesPayload: jsonb("recent_battles_payload"),
    battlesLastSyncedAt: timestamp("battles_last_synced_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("alliances_albion_region_idx").on(t.albionId, t.region),
    index("alliances_name_idx").on(t.name),
  ]
);

export const players = pgTable(
  "players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    albionId: text("albion_id").notNull(),
    region: regionEnum("region").notNull(),
    name: text("name").notNull(),
    guildId: uuid("guild_id").references(() => guilds.id),
    allianceId: text("alliance_id"),
    allianceName: text("alliance_name"),
    avatar: text("avatar"),
    avatarRing: text("avatar_ring"),
    killFame: bigint("kill_fame", { mode: "number" }).default(0),
    deathFame: bigint("death_fame", { mode: "number" }).default(0),
    fameRatio: numeric("fame_ratio", { precision: 10, scale: 4 }),
    lifetimeStats: jsonb("lifetime_stats"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    historyLastSyncedAt: timestamp("history_last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("players_albion_region_idx").on(t.albionId, t.region),
    index("players_name_idx").on(t.name),
    index("players_guild_idx").on(t.guildId),
    index("players_alliance_idx").on(t.allianceId),
  ]
);

export const battles = pgTable(
  "battles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    albionBattleId: bigint("albion_battle_id", { mode: "number" }).notNull(),
    region: regionEnum("region").notNull(),
    startTime: timestamp("start_time", { withTimezone: true }),
    endTime: timestamp("end_time", { withTimezone: true }),
    totalFame: bigint("total_fame", { mode: "number" }),
    totalKills: integer("total_kills"),
    totalPlayers: integer("total_players"),
    rawPayload: jsonb("raw_payload"),
    eventsPayload: jsonb("events_payload"),
    detailPayload: jsonb("detail_payload"),
    /** Slim alliance/guild names for the battles list; avoids TOAST on feed reads. */
    feedPreview: jsonb("feed_preview"),
    detailSyncedAt: timestamp("detail_synced_at", { withTimezone: true }),
    /**
     * When set, heavy JSON was cleared for storage; stub columns remain so a visit
     * can re-queue sync-battle. Distinct from detail_sync_unavailable (Albion give-up).
     */
    detailEvictedAt: timestamp("detail_evicted_at", { withTimezone: true }),
    /** 1 when Albion never published detail after soft-defer give-up — stop re-queueing. */
    detailSyncUnavailable: integer("detail_sync_unavailable").default(0),
    detailSyncGiveUpAt: timestamp("detail_sync_give_up_at", { withTimezone: true }),
    detailSyncLastError: text("detail_sync_last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("battles_albion_region_idx").on(t.albionBattleId, t.region),
    index("battles_detail_evict_idx").on(t.endTime, t.detailEvictedAt),
    index("battles_region_start_time_idx").on(t.region, t.startTime),
    index("battles_detail_sync_unavailable_idx")
      .on(t.detailSyncUnavailable)
      .where(sql`${t.detailSyncUnavailable} = 1`),
    index("battles_feed_start_time_idx")
      .on(t.startTime, t.createdAt)
      .where(
        sql`${t.totalFame} is not null and ${t.totalKills} is not null and ${t.totalPlayers} >= 10`
      ),
  ]
);

export const killEvents = pgTable(
  "kill_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: bigint("event_id", { mode: "number" }).notNull(),
    region: regionEnum("region").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    contentType: contentTypeEnum("content_type").default("GROUP").notNull(),
    battleId: uuid("battle_id").references(() => battles.id),
    albionBattleId: bigint("albion_battle_id", { mode: "number" }),
    killerId: uuid("killer_id").references(() => players.id),
    victimId: uuid("victim_id").references(() => players.id),
    totalVictimKillFame: bigint("total_victim_kill_fame", { mode: "number" }),
    participantCount: integer("participant_count"),
    groupMemberCount: integer("group_member_count"),
    killerGuildAlbionId: text("killer_guild_albion_id"),
    killerGuildName: text("killer_guild_name"),
    killerAllianceAlbionId: text("killer_alliance_albion_id"),
    killerAllianceName: text("killer_alliance_name"),
    victimGuildAlbionId: text("victim_guild_albion_id"),
    victimGuildName: text("victim_guild_name"),
    victimAllianceAlbionId: text("victim_alliance_albion_id"),
    victimAllianceName: text("victim_alliance_name"),
    rawPayload: jsonb("raw_payload"),
    detailSyncedAt: timestamp("detail_synced_at", { withTimezone: true }),
    /**
     * When set, participants/items/JSON were cleared for storage; stub columns remain.
     * Distinct from missing rows — do not re-ingest this event.
     */
    detailEvictedAt: timestamp("detail_evicted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("kill_events_event_region_idx").on(t.eventId, t.region),
    index("kill_events_occurred_idx").on(t.region, t.occurredAt),
    index("kill_events_killer_idx").on(t.killerId, t.occurredAt),
    index("kill_events_victim_idx").on(t.victimId, t.occurredAt),
    index("kill_events_content_idx").on(t.contentType, t.occurredAt),
    /** Speeds public kill lists that exclude zero-fame (empty drop) events. */
    index("kill_events_region_occurred_fame_idx")
      .on(t.region, t.occurredAt)
      .where(sql`${t.totalVictimKillFame} > 0`),
    index("kill_events_battle_id_idx").on(t.battleId),
    index("kill_events_region_albion_battle_idx")
      .on(t.region, t.albionBattleId)
      .where(sql`${t.albionBattleId} is not null`),
    index("kill_events_detail_evict_idx").on(t.occurredAt, t.detailEvictedAt),
    index("kill_events_lb_killer_idx")
      .on(t.occurredAt, t.killerId)
      .where(
        sql`${t.totalVictimKillFame} > 0 AND ${t.killerId} IS NOT NULL`
      ),
    index("kill_events_lb_fame_idx")
      .on(t.totalVictimKillFame, t.occurredAt)
      .where(sql`${t.totalVictimKillFame} > 0`),
    index("kill_events_lb_guild_idx")
      .on(t.occurredAt, t.killerGuildAlbionId, t.region)
      .where(
        sql`${t.totalVictimKillFame} > 0 AND ${t.killerGuildAlbionId} IS NOT NULL`
      ),
    index("kill_events_lb_alliance_idx")
      .on(t.occurredAt, t.killerAllianceAlbionId, t.region)
      .where(
        sql`${t.totalVictimKillFame} > 0 AND ${t.killerAllianceAlbionId} IS NOT NULL`
      ),
    index("kill_events_feud_guild_idx")
      .on(
        t.region,
        t.killerGuildAlbionId,
        t.victimGuildAlbionId,
        t.occurredAt
      )
      .where(
        sql`${t.totalVictimKillFame} > 0 AND ${t.killerGuildAlbionId} IS NOT NULL AND ${t.victimGuildAlbionId} IS NOT NULL`
      ),
    index("kill_events_feud_alliance_idx")
      .on(
        t.region,
        t.killerAllianceAlbionId,
        t.victimAllianceAlbionId,
        t.occurredAt
      )
      .where(
        sql`${t.totalVictimKillFame} > 0 AND ${t.killerAllianceAlbionId} IS NOT NULL AND ${t.victimAllianceAlbionId} IS NOT NULL`
      ),
    index("kill_events_rivals_killer_guild_idx")
      .on(t.region, t.killerGuildAlbionId, t.occurredAt)
      .where(
        sql`${t.totalVictimKillFame} > 0 AND ${t.killerGuildAlbionId} IS NOT NULL`
      ),
    index("kill_events_rivals_victim_guild_idx")
      .on(t.region, t.victimGuildAlbionId, t.occurredAt)
      .where(
        sql`${t.totalVictimKillFame} > 0 AND ${t.victimGuildAlbionId} IS NOT NULL`
      ),
  ]
);

export const killParticipants = pgTable(
  "kill_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .references(() => killEvents.id, { onDelete: "cascade" })
      .notNull(),
    playerId: uuid("player_id").references(() => players.id),
    role: ownerRoleEnum("role").notNull(),
    name: text("name"),
    guildName: text("guild_name"),
    guildAlbionId: text("guild_albion_id"),
    allianceId: text("alliance_id"),
    allianceTag: text("alliance_tag"),
    averageItemPower: numeric("average_item_power", { precision: 10, scale: 2 }),
    killFame: bigint("kill_fame", { mode: "number" }),
    deathFame: bigint("death_fame", { mode: "number" }),
    supportHealingDone: bigint("support_healing_done", { mode: "number" }),
    rawPayload: jsonb("raw_payload"),
  },
  (t) => [
    index("kill_participants_event_idx").on(t.eventId),
    index("kill_participants_guild_role_idx").on(t.guildName, t.role),
    index("kill_participants_player_idx").on(t.playerId),
    index("kill_participants_guild_albion_id_idx").on(t.guildAlbionId),
  ]
);

/**
 * Per-guild UTC hour rollup of PvP activity (unique members, kills, deaths, fame).
 * Live ingest captures ~50 events / 25 min / region; peak ZvZ can exceed that,
 * so hour ranks are directional for large guilds and noisy for small ones.
 */
export const guildHourStats = pgTable(
  "guild_hour_stats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    region: regionEnum("region").notNull(),
    guildAlbionId: text("guild_albion_id").notNull(),
    guildName: text("guild_name").notNull(),
    utcDate: date("utc_date", { mode: "string" }).notNull(),
    utcHour: integer("utc_hour").notNull(),
    contentType: contentTypeEnum("content_type").notNull(),
    uniquePlayers: integer("unique_players").notNull().default(0),
    kills: integer("kills").notNull().default(0),
    deaths: integer("deaths").notNull().default(0),
    fame: bigint("fame", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    uniqueIndex("guild_hour_stats_bucket_idx").on(
      t.region,
      t.guildAlbionId,
      t.utcDate,
      t.utcHour,
      t.contentType
    ),
    index("guild_hour_stats_hour_idx").on(t.region, t.utcHour, t.utcDate),
    index("guild_hour_stats_guild_idx").on(t.region, t.guildAlbionId, t.utcDate),
  ]
);

export const guildHourPlayers = pgTable(
  "guild_hour_players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    region: regionEnum("region").notNull(),
    guildAlbionId: text("guild_albion_id").notNull(),
    utcDate: date("utc_date", { mode: "string" }).notNull(),
    utcHour: integer("utc_hour").notNull(),
    contentType: contentTypeEnum("content_type").notNull(),
    playerAlbionId: text("player_albion_id").notNull(),
  },
  (t) => [
    uniqueIndex("guild_hour_players_bucket_idx").on(
      t.region,
      t.guildAlbionId,
      t.utcDate,
      t.utcHour,
      t.contentType,
      t.playerAlbionId
    ),
    index("guild_hour_players_hour_idx").on(t.region, t.utcHour, t.utcDate),
    index("guild_hour_players_guild_idx").on(
      t.region,
      t.guildAlbionId,
      t.utcDate
    ),
  ]
);

export const killItems = pgTable(
  "kill_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .references(() => killEvents.id, { onDelete: "cascade" })
      .notNull(),
    participantId: uuid("participant_id"),
    ownerRole: ownerRoleEnum("owner_role").notNull(),
    category: itemCategoryEnum("category").notNull(),
    slot: text("slot"),
    itemType: text("item_type").notNull(),
    quality: integer("quality").default(0),
    count: integer("count").default(1),
    spells: jsonb("spells"),
  },
  (t) => [index("kill_items_event_idx").on(t.eventId)]
);

export const apiSyncState = pgTable(
  "api_sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    region: regionEnum("region").notNull().unique(),
    lastSeenEventId: bigint("last_seen_event_id", { mode: "number" }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastIngestAt: timestamp("last_ingest_at", { withTimezone: true }),
    lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
    lastHealthCheckOk: integer("last_health_check_ok").default(0),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorMessage: text("last_error_message"),
    consecutiveFailures: integer("consecutive_failures").default(0),
    circuitOpen: integer("circuit_open").default(0),
    circuitOpenedAt: timestamp("circuit_opened_at", { withTimezone: true }),
    rateLimitUntil: timestamp("rate_limit_until", { withTimezone: true }),
    avgLatencyMs: integer("avg_latency_ms").default(0),
    eventsIngestedLastHour: integer("events_ingested_last_hour").default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  }
);

export const apiRequestLogs = pgTable(
  "api_request_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    region: regionEnum("region").notNull(),
    endpoint: text("endpoint").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    status: text("status").notNull(),
    errorType: text("error_type"),
    errorMessage: text("error_message"),
    details: jsonb("details").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("api_request_logs_region_created_idx").on(t.region, t.createdAt)]
);

export const cronJobState = pgTable("cron_job_state", {
  jobKey: text("job_key").primaryKey(),
  label: text("label").notNull(),
  path: text("path").notNull(),
  schedule: text("schedule").notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  lastErrorMessage: text("last_error_message"),
  lastStatus: text("last_status"),
  lastResult: jsonb("last_result"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const opsEvents = pgTable(
  "ops_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    severity: text("severity").notNull(),
    category: text("category"),
    region: regionEnum("region"),
    message: text("message").notNull(),
    details: jsonb("details").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("ops_events_created_idx").on(t.createdAt),
    index("ops_events_source_severity_idx").on(
      t.source,
      t.severity,
      t.createdAt
    ),
  ]
);

export const itemMarketPrices = pgTable(
  "item_market_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    region: regionEnum("region").notNull(),
    itemId: text("item_id").notNull(),
    quality: integer("quality").notNull(),
    unitPrice: bigint("unit_price", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("item_market_prices_region_item_quality_idx").on(
      t.region,
      t.itemId,
      t.quality
    ),
    index("item_market_prices_updated_at_idx").on(t.updatedAt),
  ]
);

export const discordServers = pgTable("discord_servers", {
  discordGuildId: text("discord_guild_id").primaryKey(),
  name: text("name"),
  installedAt: timestamp("installed_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  leftAt: timestamp("left_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const discordFeeds = pgTable(
  "discord_feeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discordGuildId: text("discord_guild_id")
      .references(() => discordServers.discordGuildId, { onDelete: "cascade" })
      .notNull(),
    feedType: text("feed_type").notNull(),
    targetType: text("target_type").notNull(),
    targetAlbionId: text("target_albion_id").notNull(),
    region: regionEnum("region").notNull(),
    targetName: text("target_name"),
    channelId: text("channel_id"),
    filters: jsonb("filters").notNull().default({}),
    enabled: integer("enabled").notNull().default(1),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("discord_feeds_unique_idx").on(
      t.discordGuildId,
      t.feedType,
      t.targetAlbionId,
      t.region
    ),
    index("discord_feeds_target_idx").on(
      t.targetType,
      t.targetAlbionId,
      t.region,
      t.feedType
    ),
    index("discord_feeds_guild_idx").on(t.discordGuildId),
  ]
);

export const discordPostLog = pgTable(
  "discord_post_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    feedId: uuid("feed_id")
      .references(() => discordFeeds.id, { onDelete: "cascade" })
      .notNull(),
    eventKey: text("event_key").notNull(),
    discordMessageId: text("discord_message_id"),
    postedAt: timestamp("posted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("discord_post_log_feed_event_idx").on(t.feedId, t.eventKey),
  ]
);

/** Better Auth: website users (Discord OAuth). */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  preferredRegion: text("preferred_region"),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    /** Better Auth 1.7+ scopes identity by (issuer, accountId). */
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("account_issuer_account_id_uidx").on(t.issuer, t.accountId),
  ]
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/** Server-persisted watchlist for signed-in users. */
export const userWatchlistEntries = pgTable(
  "user_watchlist_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    region: regionEnum("region").notNull(),
    albionId: text("albion_id").notNull(),
    name: text("name").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("user_watchlist_entries_unique_idx").on(
      t.userId,
      t.type,
      t.region,
      t.albionId
    ),
    index("user_watchlist_entries_user_idx").on(t.userId),
  ]
);

/** Server-persisted recent searches for signed-in users. */
export const userRecentSearches = pgTable(
  "user_recent_searches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    q: text("q").notNull().default(""),
    region: text("region").notNull(),
    type: text("type"),
    path: text("path"),
    searchedAt: timestamp("searched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("user_recent_searches_user_searched_idx").on(t.userId, t.searchedAt)]
);

export const guildsRelations = relations(guilds, ({ many }) => ({
  players: many(players),
}));

export const playersRelations = relations(players, ({ one, many }) => ({
  guild: one(guilds, { fields: [players.guildId], references: [guilds.id] }),
  killsAsKiller: many(killEvents, { relationName: "killer" }),
  killsAsVictim: many(killEvents, { relationName: "victim" }),
}));

export const killEventsRelations = relations(killEvents, ({ one, many }) => ({
  killer: one(players, {
    fields: [killEvents.killerId],
    references: [players.id],
    relationName: "killer",
  }),
  victim: one(players, {
    fields: [killEvents.victimId],
    references: [players.id],
    relationName: "victim",
  }),
  battle: one(battles, {
    fields: [killEvents.battleId],
    references: [battles.id],
  }),
  participants: many(killParticipants),
  items: many(killItems),
}));

export const killParticipantsRelations = relations(killParticipants, ({ one, many }) => ({
  event: one(killEvents, {
    fields: [killParticipants.eventId],
    references: [killEvents.id],
  }),
  player: one(players, {
    fields: [killParticipants.playerId],
    references: [players.id],
  }),
  items: many(killItems),
}));

export const killItemsRelations = relations(killItems, ({ one }) => ({
  event: one(killEvents, {
    fields: [killItems.eventId],
    references: [killEvents.id],
  }),
  participant: one(killParticipants, {
    fields: [killItems.participantId],
    references: [killParticipants.id],
  }),
}));
