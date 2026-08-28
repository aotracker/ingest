import { describe, expect, it } from "vitest";
import {
  battleFingerprint,
  battleMeetsMinGuildPlayers,
  battleScoreboardRows,
  guildInBattle,
  parseBattleGuildScores,
  sampleBattleSnapshot,
  type BattleSnapshot,
} from "./battle-data";
import { battleThreadName, buildBattleEmbed } from "./battle-format";
import { isBattleSettled, remainingBattleSettleMs } from "./battle-settle";
import { BATTLE_SETTLE_MS, DEFAULT_BATTLE_FEED_MIN_PLAYERS } from "./types";

function snapshot(overrides: Partial<BattleSnapshot> = {}): BattleSnapshot {
  return {
    region: "americas",
    albionBattleId: 99,
    startTime: new Date("2026-08-25T12:00:00Z"),
    endTime: null,
    totalPlayers: 80,
    totalKills: 40,
    totalFame: 1_250_000,
    guilds: [
      {
        id: "g1",
        name: "Elevate",
        alliance: "POE",
        kills: 12,
        deaths: 8,
        killFame: 500_000,
        players: 20,
        averageIp: 1400,
      },
      {
        id: "g2",
        name: "Rivals",
        kills: 10,
        deaths: 9,
        killFame: 400_000,
        players: 18,
      },
    ],
    ...overrides,
  };
}

describe("parseBattleGuildScores", () => {
  it("reads Albion dict payloads", () => {
    const guilds = parseBattleGuildScores({
      abc: {
        name: "Elevate",
        alliance: "POE",
        kills: 3,
        deaths: 1,
        killFame: 100,
        players: 5,
        averageIp: 1320,
      },
    });
    expect(guilds).toEqual([
      {
        id: "abc",
        name: "Elevate",
        alliance: "POE",
        kills: 3,
        deaths: 1,
        killFame: 100,
        players: 5,
        averageIp: 1320,
      },
    ]);
  });

  it("reads cached detail arrays", () => {
    const guilds = parseBattleGuildScores([
      { id: "xyz", name: "Rivals", Kills: 2, Deaths: 4, KillFame: 50 },
    ]);
    expect(guilds[0]).toMatchObject({
      id: "xyz",
      name: "Rivals",
      kills: 2,
      deaths: 4,
      killFame: 50,
    });
  });
});

describe("guildInBattle", () => {
  it("matches by albion id", () => {
    expect(guildInBattle(snapshot(), "g1")?.name).toBe("Elevate");
  });

  it("falls back to name", () => {
    expect(guildInBattle(snapshot(), "missing", "rivals")?.id).toBe("g2");
  });
});

describe("battleMeetsMinGuildPlayers", () => {
  it("uses the tracked guild player count, not the battle total", () => {
    const fight = snapshot({ totalPlayers: 80 });
    expect(battleMeetsMinGuildPlayers(fight, "g1", 20, "Elevate")).toBe(true);
    expect(battleMeetsMinGuildPlayers(fight, "g1", 21, "Elevate")).toBe(false);
    expect(battleMeetsMinGuildPlayers(fight, "missing", 1)).toBe(false);
  });
});

describe("battleFingerprint", () => {
  it("changes when scoreboard stats change", () => {
    const a = battleFingerprint(snapshot());
    const b = battleFingerprint(
      snapshot({
        guilds: [
          {
            id: "g1",
            name: "Elevate",
            kills: 13,
            deaths: 8,
            killFame: 500_000,
            players: 20,
          },
        ],
      })
    );
    expect(a).not.toBe(b);
  });
});

describe("battleScoreboardRows", () => {
  it("keeps the tracked guild when it is outside the top rows", () => {
    const rows = battleScoreboardRows(
      snapshot({
        guilds: [
          {
            id: "a",
            name: "Alpha",
            kills: 20,
            deaths: 1,
            killFame: 900_000,
            players: 30,
          },
          {
            id: "b",
            name: "Bravo",
            kills: 18,
            deaths: 2,
            killFame: 800_000,
            players: 28,
          },
          {
            id: "c",
            name: "Charlie",
            kills: 16,
            deaths: 3,
            killFame: 700_000,
            players: 26,
          },
          {
            id: "d",
            name: "Delta",
            kills: 14,
            deaths: 4,
            killFame: 600_000,
            players: 24,
          },
          {
            id: "g1",
            name: "Elevate",
            kills: 2,
            deaths: 9,
            killFame: 50_000,
            players: 8,
          },
        ],
      }),
      "g1",
      "Elevate"
    );
    expect(rows).toHaveLength(4);
    expect(rows.some((row) => row.name === "Elevate")).toBe(true);
  });
});

describe("battle settle", () => {
  it("waits the full window when first seen", () => {
    expect(remainingBattleSettleMs(null)).toBe(BATTLE_SETTLE_MS);
    expect(isBattleSettled(null)).toBe(false);
  });

  it("is settled after the window", () => {
    const seen = new Date(Date.now() - BATTLE_SETTLE_MS - 1_000).toISOString();
    expect(isBattleSettled(seen)).toBe(true);
    expect(remainingBattleSettleMs(seen)).toBe(0);
  });
});

describe("battleThreadName", () => {
  it("stays within Discord's 100 character limit", () => {
    const name = battleThreadName(
      snapshot(),
      "A very long guild name that should be truncated if needed for discord threads"
    );
    expect(name.length).toBeLessThanOrEqual(100);
  });
});

describe("DEFAULT_BATTLE_FEED_MIN_PLAYERS", () => {
  it("is a positive threshold", () => {
    expect(DEFAULT_BATTLE_FEED_MIN_PLAYERS).toBeGreaterThan(0);
  });
});

describe("sampleBattleSnapshot", () => {
  it("puts the tracked guild on the recap embed", () => {
    const sample = sampleBattleSnapshot({
      region: "europe",
      trackedGuildId: "abc",
      trackedGuildName: "Elevate",
    });
    expect(guildInBattle(sample, "abc")?.name).toBe("Elevate");
    const embed = buildBattleEmbed({
      snapshot: sample,
      trackedGuildId: "abc",
      trackedGuildName: "Elevate",
      preview: true,
    });
    expect(embed.footer?.text).toContain("preview");
    expect(embed.description).toContain("Preview");
    expect(embed.title).toContain("recap");
    expect(embed.fields).toBeUndefined();
  });
});

describe("renderBattleSnapshotPng", () => {
  it("renders a png recap", async () => {
    const { renderBattleSnapshotPng } = await import("./battle-snapshot");
    const png = await renderBattleSnapshotPng({
      snapshot: sampleBattleSnapshot({
        region: "americas",
        trackedGuildId: "abc",
        trackedGuildName: "Elevate",
      }),
      trackedGuildId: "abc",
      trackedGuildName: "Elevate",
      preview: true,
    });
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});
