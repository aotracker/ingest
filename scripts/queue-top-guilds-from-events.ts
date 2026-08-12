import { getAlbionClient } from "@aotracker/core/albion/client";
import type {
  AlbionEvent,
  AlbionPlayerRef,
  AlbionRegion,
} from "@aotracker/core/albion/types";
import {
  ALL_REGIONS,
  ENABLED_REGIONS,
  isRegionEnabled,
} from "@aotracker/core/albion/types";
import { ensureGuildSyncQueued } from "../src/jobs/enqueue";
import { formatFame, regionLabel, toBigInt } from "@aotracker/core/utils";

const PAGE_SIZE = 50;
const MAX_OFFSET = 1000;
const TOP_N = 100;

type GuildScore = {
  guildId: string;
  name: string;
  killerFame: number;
  appearances: number;
};

function parseRegions(): AlbionRegion[] {
  const arg = process.argv.find((a) => a.startsWith("--region="));
  const raw = arg?.slice("--region=".length)?.trim().toLowerCase();
  if (!raw) return [...ENABLED_REGIONS];

  if (!(ALL_REGIONS as string[]).includes(raw)) {
    console.error(
      `[top-guilds] Invalid --region="${raw}". Expected one of: ${ALL_REGIONS.join(", ")}`
    );
    process.exit(1);
  }
  if (!isRegionEnabled(raw)) {
    console.error(
      `[top-guilds] Region "${raw}" is disabled (check DISABLED_REGIONS)`
    );
    process.exit(1);
  }
  return [raw as AlbionRegion];
}

function collectPlayerRefs(event: AlbionEvent): AlbionPlayerRef[] {
  const refs: AlbionPlayerRef[] = [];
  if (event.Killer) refs.push(event.Killer);
  if (event.Victim) refs.push(event.Victim);
  for (const member of event.GroupMembers ?? []) refs.push(member);
  for (const participant of event.Participants ?? []) refs.push(participant);
  return refs;
}

function scoreGuildsFromEvents(events: AlbionEvent[]): Map<string, GuildScore> {
  const scores = new Map<string, GuildScore>();

  for (const event of events) {
    const seenInEvent = new Set<string>();
    const fame = toBigInt(event.TotalVictimKillFame) ?? 0;

    for (const ref of collectPlayerRefs(event)) {
      if (!ref.GuildId || !ref.GuildName) continue;

      let entry = scores.get(ref.GuildId);
      if (!entry) {
        entry = {
          guildId: ref.GuildId,
          name: ref.GuildName,
          killerFame: 0,
          appearances: 0,
        };
        scores.set(ref.GuildId, entry);
      } else if (ref.GuildName && entry.name !== ref.GuildName) {
        entry.name = ref.GuildName;
      }

      if (!seenInEvent.has(ref.GuildId)) {
        seenInEvent.add(ref.GuildId);
        entry.appearances += 1;
      }
    }

    const killerGuildId = event.Killer?.GuildId;
    if (killerGuildId && fame > 0) {
      const entry = scores.get(killerGuildId);
      if (entry) entry.killerFame += fame;
    }
  }

  return scores;
}

function rankGuilds(scores: Map<string, GuildScore>): GuildScore[] {
  return [...scores.values()].sort(
    (a, b) =>
      b.killerFame - a.killerFame ||
      b.appearances - a.appearances ||
      a.name.localeCompare(b.name)
  );
}

async function discoverGuildsFromEvents(region: AlbionRegion): Promise<{
  ranked: GuildScore[];
  pagesFetched: number;
  eventsSeen: number;
}> {
  const client = getAlbionClient();
  const allEvents: AlbionEvent[] = [];
  let pagesFetched = 0;

  for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE_SIZE) {
    const page = await client.getRecentEvents(region, PAGE_SIZE, offset);
    pagesFetched += 1;

    if (page.length === 0) {
      console.log(
        `[top-guilds] ${region} empty page at offset=${offset}, stopping`
      );
      break;
    }

    allEvents.push(...page);
    console.log(
      `[top-guilds] ${region} fetched offset=${offset} events=${page.length} (total=${allEvents.length})`
    );

    if (page.length < PAGE_SIZE) break;
  }

  const ranked = rankGuilds(scoreGuildsFromEvents(allEvents));
  return { ranked, pagesFetched, eventsSeen: allEvents.length };
}

async function processRegion(
  region: AlbionRegion,
  dryRun: boolean
): Promise<void> {
  console.log(
    `[top-guilds] Discovering guilds from /events (${regionLabel(region)})${dryRun ? " [dry-run]" : ""}`
  );

  const { ranked, pagesFetched, eventsSeen } =
    await discoverGuildsFromEvents(region);
  const top = ranked.slice(0, TOP_N);

  console.log(
    `[top-guilds] ${region} unique guilds=${ranked.length} from ${eventsSeen} events across ${pagesFetched} pages`
  );
  console.log(
    `[top-guilds] ${region} top ${top.length} by killer kill fame:\n`
  );

  for (let i = 0; i < top.length; i++) {
    const g = top[i];
    console.log(
      `${String(i + 1).padStart(3)}. ${g.name}  fame=${formatFame(g.killerFame)}  appearances=${g.appearances}  id=${g.guildId}`
    );
  }

  const discoveryCalls = pagesFetched;
  const syncCallsEstimate = top.length * 2;
  console.log(
    `\n[top-guilds] ${region} API budget: discovery=${discoveryCalls} calls, sync≈${syncCallsEstimate} calls (${top.length} guilds × 2), total≈${discoveryCalls + syncCallsEstimate}`
  );
  console.log(
    `[top-guilds] ${region} estimated wall clock at 1 req/s: discovery≈${discoveryCalls}s, sync≈${syncCallsEstimate}s (~${Math.ceil((discoveryCalls + syncCallsEstimate) / 60)} min)`
  );

  if (dryRun) {
    console.log(
      `\n[dry-run] Would enqueue ${top.length} sync-guild jobs for ${region} (no jobs written)`
    );
    return;
  }

  let queued = 0;
  for (const guild of top) {
    await ensureGuildSyncQueued(region, guild.guildId, { immediate: true });
    queued += 1;
  }

  console.log(
    `\n[top-guilds] Enqueued ${queued} sync-guild jobs for ${region}. Keep npm run start running to drain.`
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const regions = parseRegions();

  if (regions.length === 0) {
    console.error(
      "[top-guilds] No enabled regions (check DISABLED_REGIONS)"
    );
    process.exit(1);
  }

  for (const region of regions) {
    await processRegion(region, dryRun);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[top-guilds] Failed:", err);
  process.exit(1);
});
