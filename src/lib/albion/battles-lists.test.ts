import { describe, expect, it } from "vitest";
import type {
  AlbionBattle,
  AlbionBattleGuildStats,
  AlbionBattlePlayer,
} from "./types";
import {
  countGuildMembersInBattle,
  filterRecentGuildBattles,
  isMultiMemberGuildBattle,
  summarizeAllianceBattles,
  summarizeGuildBattles,
  toAllianceBattleSummary,
  toGuildBattleSummary,
} from "./battles";

const GUILD_ID = "g1";
const ALLIANCE_ID = "a1";

function player(
  id: string,
  extras: Partial<AlbionBattlePlayer> = {}
): AlbionBattlePlayer {
  return {
    id,
    name: id,
    kills: 0,
    deaths: 0,
    killFame: 0,
    ...extras,
  };
}

function guildStats(
  extras: Partial<AlbionBattleGuildStats> = {}
): AlbionBattleGuildStats {
  return {
    id: GUILD_ID,
    name: "Elevate",
    kills: 4,
    deaths: 2,
    killFame: 80_000,
    ...extras,
  };
}

function battle(overrides: Partial<AlbionBattle> = {}): AlbionBattle {
  return {
    id: 1,
    totalFame: 100_000,
    totalKills: 8,
    totalPlayers: 20,
    ...overrides,
  };
}

describe("countGuildMembersInBattle", () => {
  it("counts matching players when the player list is present", () => {
    expect(
      countGuildMembersInBattle(
        battle({
          players: {
            p1: player("p1", { guildId: GUILD_ID }),
            p2: player("p2", { guildId: GUILD_ID }),
            p3: player("p3", { guildId: "other" }),
          },
          guilds: { [GUILD_ID]: guildStats({ players: 99 }) },
        }),
        GUILD_ID
      )
    ).toBe(2);
  });

  it("falls back to guild stats when the player list is empty", () => {
    expect(
      countGuildMembersInBattle(
        battle({
          players: {},
          guilds: { [GUILD_ID]: guildStats({ players: 7 }) },
        }),
        GUILD_ID
      )
    ).toBe(7);
  });

  it("finds guild stats by id when the record key differs", () => {
    expect(
      countGuildMembersInBattle(
        battle({
          guilds: { "not-the-id": guildStats({ players: 5 }) },
        }),
        GUILD_ID
      )
    ).toBe(5);
  });
});

describe("isMultiMemberGuildBattle", () => {
  it("drops solo cameos and unknown-zero counts", () => {
    expect(isMultiMemberGuildBattle({ guildMembers: 0 })).toBe(false);
    expect(isMultiMemberGuildBattle({ guildMembers: 1 })).toBe(false);
    expect(isMultiMemberGuildBattle({ guildMembers: 2 })).toBe(true);
  });
});

describe("guild and alliance list summaries", () => {
  it("keeps 2+ guild members and drops a 1-player cameo", () => {
    const kept = battle({
      id: 10,
      players: {
        a: player("a", { guildId: GUILD_ID }),
        b: player("b", { guildId: GUILD_ID }),
      },
    });
    const cameo = battle({
      id: 11,
      players: { a: player("a", { guildId: GUILD_ID }) },
    });
    const summaries = filterRecentGuildBattles(
      summarizeGuildBattles([kept, cameo], GUILD_ID)
    );
    expect(summaries.map((row) => row.id)).toEqual([10]);
    expect(toGuildBattleSummary(kept, GUILD_ID).guildMembers).toBe(2);
  });

  it("drops alliance fights with fewer than 2 members", () => {
    const kept = battle({
      id: 20,
      alliances: {
        [ALLIANCE_ID]: {
          id: ALLIANCE_ID,
          name: "POE",
          kills: 10,
          deaths: 4,
          killFame: 200_000,
          players: 12,
        },
      },
    });
    const cameo = battle({
      id: 21,
      alliances: {
        [ALLIANCE_ID]: {
          id: ALLIANCE_ID,
          name: "POE",
          kills: 1,
          deaths: 1,
          killFame: 5_000,
          players: 1,
        },
      },
    });
    const summaries = filterRecentGuildBattles(
      summarizeAllianceBattles([kept, cameo], ALLIANCE_ID)
    );
    expect(summaries.map((row) => row.id)).toEqual([20]);
    expect(toAllianceBattleSummary(cameo, ALLIANCE_ID).guildMembers).toBe(1);
  });

  it("still requires kill fame on entity lists", () => {
    const noFame = battle({
      id: 30,
      totalFame: 0,
      players: {
        a: player("a", { guildId: GUILD_ID }),
        b: player("b", { guildId: GUILD_ID }),
      },
    });
    expect(summarizeGuildBattles([noFame], GUILD_ID)).toEqual([]);
  });
});
