import { describe, expect, it } from "vitest";
import { comparePlayerRow, compareStatsRow } from "./guild-hour-stats";

describe("guild hour upsert row order", () => {
  it("sorts player rows by guild then player so concurrent inserts lock in one order", () => {
    const rows = [
      { guildAlbionId: "b", playerAlbionId: "z" },
      { guildAlbionId: "a", playerAlbionId: "m" },
      { guildAlbionId: "a", playerAlbionId: "c" },
    ];
    rows.sort(comparePlayerRow);
    expect(rows.map((row) => `${row.guildAlbionId}:${row.playerAlbionId}`)).toEqual([
      "a:c",
      "a:m",
      "b:z",
    ]);
  });

  it("sorts stats rows by guild id", () => {
    const rows = [{ guildAlbionId: "m" }, { guildAlbionId: "a" }, { guildAlbionId: "k" }];
    rows.sort(compareStatsRow);
    expect(rows.map((row) => row.guildAlbionId)).toEqual(["a", "k", "m"]);
  });
});
