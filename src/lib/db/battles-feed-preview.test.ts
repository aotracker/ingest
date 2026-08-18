import { describe, expect, it } from "vitest";
import {
  buildBattlesFeedPreview,
  parseBattlesFeedPreview,
} from "./battles-feed-preview";

describe("buildBattlesFeedPreview", () => {
  it("uses Albion list-payload dict keys as ids when guild objects omit id", () => {
    const preview = buildBattlesFeedPreview(
      {
        guilds: {
          "guild-1": { name: "Mute", killFame: 200, kills: 8 },
          "guild-2": { name: "Arch", killFame: 400, kills: 12 },
        },
        alliances: {
          "ally-1": { name: "POE", killFame: 600, kills: 20 },
        },
      },
      null
    );

    expect(preview.guilds.map((g) => g.name)).toEqual(["Arch", "Mute"]);
    expect(preview.guilds[0]).toEqual({ id: "guild-2", name: "Arch" });
    expect(preview.alliances).toEqual([{ id: "ally-1", name: "POE" }]);
  });

  it("does not let empty detail arrays hide names on the list payload", () => {
    const preview = buildBattlesFeedPreview(
      {
        guilds: {
          "guild-1": { name: "Mute", killFame: 10, kills: 1 },
        },
      },
      { alliances: [], guilds: [], players: [] }
    );

    expect(preview.guilds).toEqual([{ id: "guild-1", name: "Mute" }]);
  });

  it("keeps named guilds when ids are numeric and falls back to players", () => {
    const fromNumericIds = buildBattlesFeedPreview(null, {
      guilds: [{ id: 42, name: "Numeric" }],
    });
    expect(fromNumericIds.guilds).toEqual([{ id: "42", name: "Numeric" }]);

    const fromPlayers = buildBattlesFeedPreview(
      {
        players: {
          p1: { name: "A", guildId: "g1", guildName: "FromPlayers", killFame: 5 },
        },
      },
      { alliances: [], guilds: [] }
    );
    expect(fromPlayers.guilds).toEqual([{ id: "g1", name: "FromPlayers" }]);
  });
});

describe("parseBattlesFeedPreview", () => {
  it("accepts numeric ids and name-only entries already stored in jsonb", () => {
    expect(
      parseBattlesFeedPreview({
        alliances: [{ id: 7, name: "POE" }],
        guilds: [{ name: "Mute" }],
        allianceCount: 1,
        guildCount: 1,
      })
    ).toEqual({
      alliances: [{ id: "7", name: "POE" }],
      guilds: [{ id: "Mute", name: "Mute" }],
      allianceCount: 1,
      guildCount: 1,
    });
  });
});
