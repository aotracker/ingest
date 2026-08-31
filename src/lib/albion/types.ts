export type AlbionRegion = "americas" | "europe" | "asia";

export type ContentType = "ZVZ" | "SOLO" | "GROUP";

export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  ZVZ: "ZvZ",
  SOLO: "1v1",
  GROUP: "Group",
};

export function contentTypeLabel(type: string): string {
  if (type in CONTENT_TYPE_LABELS) {
    return CONTENT_TYPE_LABELS[type as ContentType];
  }
  return CONTENT_TYPE_LABELS.GROUP;
}

export type RangeType = "week" | "lastWeek" | "month" | "lastMonth";

export interface AlbionLegendaryTrait {
  trait?: string;
  value?: number;
}

export interface AlbionItem {
  Type: string;
  Quality: number;
  Count: number;
  ActiveSpells?: string[];
  PassiveSpells?: string[];
  LegendarySoul?: { traits?: AlbionLegendaryTrait[] } | null;
}

export interface AlbionEquipment {
  MainHand?: AlbionItem | null;
  OffHand?: AlbionItem | null;
  Head?: AlbionItem | null;
  Armor?: AlbionItem | null;
  Shoes?: AlbionItem | null;
  Bag?: AlbionItem | null;
  Cape?: AlbionItem | null;
  Mount?: AlbionItem | null;
  Food?: AlbionItem | null;
  Potion?: AlbionItem | null;
}

export interface AlbionPlayerRef {
  Id?: string;
  Name?: string;
  GuildId?: string;
  GuildName?: string;
  AllianceId?: string;
  AllianceName?: string;
  AllianceTag?: string;
  Avatar?: string;
  AvatarRing?: string;
  KillFame?: number;
  DeathFame?: number;
  FameRatio?: number;
  AverageItemPower?: number;
  SupportHealingDone?: number;
  Equipment?: AlbionEquipment;
  Inventory?: (AlbionItem | null)[];
}

export interface AlbionEvent {
  EventId: number;
  TimeStamp: string;
  Type?: string;
  BattleId?: number;
  TotalVictimKillFame?: number;
  numberOfParticipants?: number;
  groupMemberCount?: number;
  GroupMemberCount?: number;
  Killer?: AlbionPlayerRef;
  Victim?: AlbionPlayerRef;
  GroupMembers?: AlbionPlayerRef[];
  Participants?: AlbionPlayerRef[];
}

export interface AlbionPlayerInfo extends AlbionPlayerRef {
  LifetimeStatistics?: {
    PvE?: {
      Total: number;
      Royal?: number;
      Outlands?: number;
      Avalon?: number;
      Hellgate?: number;
    };
    Gathering?: {
      Fiber?: number;
      Hide?: number;
      Ore?: number;
      Rock?: number;
      Wood?: number;
      All?: number;
    };
    Crafting?: { Total?: number };
    FishingFame?: number;
    FarmingFame?: number;
  };
}

export interface AlbionGuildInfo {
  Id: string;
  Name: string;
  FounderId?: string;
  FounderName?: string;
  Founded?: string;
  AllianceId?: string;
  AllianceName?: string;
  AllianceTag?: string;
  /** `/guilds/{id}` uses camelCase; search results use PascalCase. */
  killFame?: number;
  KillFame?: number;
  DeathFame?: number;
  AttacksWon?: number;
  DefensesWon?: number;
  MemberCount?: number;
}

export interface AlbionAllianceInfo {
  Id?: string;
  Name?: string;
  Tag?: string;
  AllianceId?: string;
  AllianceName?: string;
  AllianceTag?: string;
  FounderId?: string;
  FounderName?: string;
  Founded?: string;
  MemberCount?: number;
  NumPlayers?: number;
  Guilds?: Record<string, unknown> | unknown[];
}

export interface NormalizedAllianceInfo {
  id: string;
  name: string;
  tag: string | null;
  founderId: string | null;
  founderName: string | null;
  founded: string | null;
  memberCount: number | null;
  guilds: Record<string, unknown> | unknown[] | undefined;
}

export interface AlbionSearchResult {
  players: AlbionPlayerRef[];
  guilds: AlbionGuildInfo[];
}

export type BattleSortType = "recent" | "topfame";

export interface AlbionBattle {
  id?: number;
  albionId?: number;
  startTime?: string;
  endTime?: string;
  totalFame?: number;
  totalKills?: number;
  totalPlayers?: number;
  players?: Record<string, AlbionBattlePlayer>;
  guilds?: Record<string, AlbionBattleGuildStats>;
  alliances?: Record<string, AlbionBattleAllianceStats>;
}

export interface AlbionBattlePlayer {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  killFame: number;
  guildId?: string;
  guildName?: string;
  allianceId?: string;
  allianceName?: string;
  weaponType?: string | null;
  weaponQuality?: number | null;
  averageIp?: number | null;
}

export interface AlbionBattleAllianceStats {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  killFame: number;
  players?: number;
  averageIp?: number | null;
}

export interface AlbionBattleGuildStats {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  killFame: number;
  alliance?: string;
  allianceId?: string;
  players?: number;
  averageIp?: number | null;
}

export interface AlbionBattleSummary {
  id: number;
  startTime: string | null;
  totalFame: number | null;
  totalKills: number | null;
  totalPlayers: number | null;
}

export interface GuildBattleSummary extends AlbionBattleSummary {
  guildKillFame: number | null;
  guildKills: number | null;
  guildDeaths: number | null;
  guildMembers: number;
  /** Guilds in the fight (preview for card title). */
  guilds: { id: string; name: string }[];
  guildCount: number;
  /** Alliances in the fight (preview above guilds on alliance profile cards). */
  alliances?: { id: string; name: string }[];
  allianceCount?: number;
}

export interface ApiHealthMetrics {
  region: AlbionRegion;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
  circuitOpen: boolean;
  avgLatencyMs: number;
  lastEventId: number | null;
  eventsIngestedLastHour: number;
}

export const REGION_BASE_URLS: Record<AlbionRegion, string> = {
  americas: "https://gameinfo.albiononline.com/api/gameinfo",
  europe: "https://gameinfo-ams.albiononline.com/api/gameinfo",
  asia: "https://gameinfo-sgp.albiononline.com/api/gameinfo",
};

export const ALL_REGIONS: AlbionRegion[] = ["americas", "europe", "asia"];

function parseDisabledRegions(): Set<AlbionRegion> {
  const raw = process.env.DISABLED_REGIONS ?? "";
  const disabled = new Set<AlbionRegion>();
  for (const part of raw.split(",")) {
    const slug = part.trim().toLowerCase();
    if (!slug) continue;
    if ((ALL_REGIONS as string[]).includes(slug)) {
      disabled.add(slug as AlbionRegion);
    }
  }
  return disabled;
}

/** Regions that are active for API calls and site display. */
export const ENABLED_REGIONS: AlbionRegion[] = ALL_REGIONS.filter(
  (region) => !parseDisabledRegions().has(region)
);

export function isRegionEnabled(region: string): region is AlbionRegion {
  return (ENABLED_REGIONS as string[]).includes(region);
}

/** First enabled region, used as the default for live search. */
export function getDefaultRegion(): AlbionRegion {
  return ENABLED_REGIONS[0] ?? "americas";
}

export const EQUIPMENT_SLOTS = [
  "MainHand",
  "OffHand",
  "Head",
  "Armor",
  "Shoes",
  "Bag",
  "Cape",
  "Mount",
  "Food",
  "Potion",
] as const;

/** Combat slots used for player top-build fingerprinting and display. */
export const TOP_BUILD_SLOTS = [
  "MainHand",
  "OffHand",
  "Head",
  "Armor",
  "Shoes",
] as const;

export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];
export type TopBuildSlot = (typeof TOP_BUILD_SLOTS)[number];
