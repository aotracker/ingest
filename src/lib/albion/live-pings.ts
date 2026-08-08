import { getAlbionClient } from "./client";
import { ENABLED_REGIONS, type AlbionRegion } from "./types";

export type RegionLivePing = {
  ok: boolean;
  latencyMs: number;
  note?: string;
};

/** Live gameinfo probes for enabled regions (short timeout, no retries). */
export async function pingEnabledRegions(): Promise<
  Record<AlbionRegion, RegionLivePing>
> {
  const client = getAlbionClient();
  return Object.fromEntries(
    await Promise.all(
      ENABLED_REGIONS.map(
        async (region) => [region, await client.ping(region)] as const
      )
    )
  ) as Record<AlbionRegion, RegionLivePing>;
}
