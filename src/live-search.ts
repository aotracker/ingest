import { getAlbionClient } from "@aotracker/core/albion/client";
import {
  ENABLED_REGIONS,
  isRegionEnabled,
  type AlbionRegion,
} from "@aotracker/core/albion/types";
import { upsertGuildFromInfo, upsertPlayer } from "./ingest";

export type LiveSearchResult = {
  playersFound: number;
  guildsFound: number;
  regionsSearched: AlbionRegion[];
  regionsFailed: AlbionRegion[];
};

/** Albion search can be slow; allow extra time before aborting. */
const LIVE_SEARCH_TIMEOUT_MS = 20_000;
const LIVE_SEARCH_MAX_RETRIES = 2;

export function normalizeLiveSearchQuery(query: string): string {
  return query.trim();
}

export function normalizeLiveSearchRegions(
  regions?: AlbionRegion[]
): AlbionRegion[] {
  if (!regions || regions.length === 0) return [...ENABLED_REGIONS];
  const unique = new Set<AlbionRegion>();
  for (const region of regions) {
    if (isRegionEnabled(region)) unique.add(region);
  }
  return [...unique].sort();
}

export function liveSearchDedupeKey(
  query: string,
  regions: AlbionRegion[]
): string {
  const normalized = normalizeLiveSearchQuery(query).toLowerCase();
  const regionKey = normalizeLiveSearchRegions(regions).join("+");
  return `live-search-${regionKey}-${encodeURIComponent(normalized)}`;
}

function formatLiveSearchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return `request timed out after ${LIVE_SEARCH_TIMEOUT_MS}ms`;
    }
    return err.message;
  }
  return String(err);
}

async function searchRegion(
  region: AlbionRegion,
  query: string
): Promise<{ playersFound: number; guildsFound: number }> {
  const client = getAlbionClient();
  const result = await client.search(region, query, {
    timeout: LIVE_SEARCH_TIMEOUT_MS,
    maxRetries: LIVE_SEARCH_MAX_RETRIES,
  });

  let playersFound = 0;
  let guildsFound = 0;

  for (const player of result.players ?? []) {
    if (player?.Id && player?.Name) {
      await upsertPlayer(region, player);
      playersFound++;
    }
  }

  for (const guild of result.guilds ?? []) {
    if (guild?.Id && guild?.Name) {
      await upsertGuildFromInfo(region, guild);
      guildsFound++;
    }
  }

  return { playersFound, guildsFound };
}

export async function runLiveSearch(
  query: string,
  regions?: AlbionRegion[]
): Promise<LiveSearchResult> {
  const trimmed = normalizeLiveSearchQuery(query);
  const toSearch = normalizeLiveSearchRegions(regions);

  if (!trimmed || toSearch.length === 0) {
    return {
      playersFound: 0,
      guildsFound: 0,
      regionsSearched: [],
      regionsFailed: [],
    };
  }

  const settled = await Promise.allSettled(
    toSearch.map(async (region) => ({
      region,
      ...(await searchRegion(region, trimmed)),
    }))
  );

  let playersFound = 0;
  let guildsFound = 0;
  const regionsFailed: AlbionRegion[] = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const region = toSearch[i];
    if (outcome.status === "fulfilled") {
      playersFound += outcome.value.playersFound;
      guildsFound += outcome.value.guildsFound;
      continue;
    }

    regionsFailed.push(region);
    console.warn(
      `[live-search] ${region} skipped:`,
      formatLiveSearchError(outcome.reason)
    );
  }

  return {
    playersFound,
    guildsFound,
    regionsSearched: toSearch,
    regionsFailed,
  };
}
