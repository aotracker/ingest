/**
 * Watched client/ingest lib copies. Keep this list identical in:
 *   scripts/lib-drift-pairs.mjs
 *   client/scripts/lib-drift-pairs.mjs
 *   ingest/scripts/lib-drift-pairs.mjs
 *
 * Ingest owns write-path helpers; client owns drizzle migrations.
 *
 * Allowed to differ (not watched):
 *   src/lib/db/index.ts          — pool max 10 (client) vs 3 (ingest)
 *   src/lib/db/api-state.ts      — ingest samples success logs
 *   src/lib/albion/types.ts      — ingest-only REGION_BASE_URLS
 *   src/lib/ops/events.ts        — import alias @/ vs @aotracker/core/
 *   src/lib/utils.ts             — client has extra UI helpers
 */
export const PAIRS = [
  "src/lib/db/schema.ts",
  "src/lib/albion/classify.ts",
  "src/lib/albion/kills.ts",
  "src/lib/db/battle-cache.ts",
  "src/lib/db/battles-feed-preview.ts",
  "src/lib/db/sync.ts",
  "src/lib/db/retention.ts",
  "src/lib/db/queries-ingest.ts",
  "src/lib/db/kill-cache.ts",
  "src/lib/market/aggregate-unit-prices.ts",
  "src/lib/discord-feed-shared.ts",
  "src/lib/item-icon-keys.ts",
  "src/lib/media/urls.ts",
  "src/lib/twitch/helix.ts",
];
