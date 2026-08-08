import type { AlbionEvent, ContentType } from "./types";

interface PlayerRef {
  Id?: string;
}

interface ClassifyInput {
  killer?: PlayerRef | null;
  victim?: PlayerRef | null;
  participantCount?: number | null;
  groupMemberCount?: number | null;
  groupMembers?: PlayerRef[];
  participants?: PlayerRef[];
  battleTotalPlayers?: number | null;
}

function countInvolvedPlayers(input: ClassifyInput): number {
  const ids = new Set<string>();

  if (input.killer?.Id) ids.add(input.killer.Id);
  if (input.victim?.Id) ids.add(input.victim.Id);

  for (const player of input.participants ?? []) {
    if (player.Id) ids.add(player.Id);
  }

  for (const player of input.groupMembers ?? []) {
    if (player.Id) ids.add(player.Id);
  }

  if (ids.size > 0) return ids.size;

  const assistCount =
    input.participantCount ?? input.participants?.length ?? 0;
  const hasKiller = Boolean(input.killer);
  const hasVictim = Boolean(input.victim);
  const baseCount = (hasKiller ? 1 : 0) + (hasVictim ? 1 : 0) + assistCount;

  const groupSize =
    input.groupMemberCount ?? input.groupMembers?.length ?? 0;
  if (groupSize > 0) {
    return Math.max(baseCount, groupSize + (hasVictim ? 1 : 0));
  }

  return baseCount;
}

export function resolvePlayerCountForClassification(input: ClassifyInput): number {
  const involvedCount = countInvolvedPlayers(input);
  const battleTotal = input.battleTotalPlayers;

  if (battleTotal != null && battleTotal > 0) {
    return battleTotal;
  }

  return involvedCount;
}

/** ZvZ starts at this many players (inclusive). Below is small-scale / group. */
export const ZVZ_MIN_PLAYERS = 15;

export function classifyContentType(input: ClassifyInput): ContentType {
  const playerCount = resolvePlayerCountForClassification(input);

  if (playerCount >= ZVZ_MIN_PLAYERS) return "ZVZ";
  if (playerCount === 2) return "SOLO";
  if (playerCount >= 3 && playerCount < ZVZ_MIN_PLAYERS) return "GROUP";

  // Edge cases (0–1 players)
  return "GROUP";
}

export function extractEventCounts(event: AlbionEvent): {
  participantCount: number;
  groupMemberCount: number;
  involvedPlayerCount: number;
} {
  const participantCount =
    event.numberOfParticipants ?? event.Participants?.length ?? 0;
  const groupMemberCount =
    event.groupMemberCount ??
    event.GroupMemberCount ??
    event.GroupMembers?.length ??
    0;

  return {
    participantCount,
    groupMemberCount,
    involvedPlayerCount: countInvolvedPlayers({
      killer: event.Killer,
      victim: event.Victim,
      participantCount,
      groupMemberCount,
      groupMembers: event.GroupMembers,
      participants: event.Participants,
    }),
  };
}

export { countInvolvedPlayers };
