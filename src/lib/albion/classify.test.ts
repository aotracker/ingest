import { describe, expect, it } from "vitest";
import { classifyContentType, ZVZ_MIN_PLAYERS } from "./classify";

describe("classifyContentType", () => {
  it("classifies 1v1 as SOLO", () => {
    expect(
      classifyContentType({
        killer: { Id: "k" },
        victim: { Id: "v" },
      })
    ).toBe("SOLO");
  });

  it("classifies small groups as GROUP", () => {
    expect(
      classifyContentType({
        killer: { Id: "k" },
        victim: { Id: "v" },
        participants: [{ Id: "a" }, { Id: "b" }],
      })
    ).toBe("GROUP");
  });

  it("classifies ZvZ at the player floor", () => {
    const participants = Array.from({ length: ZVZ_MIN_PLAYERS - 2 }, (_, i) => ({
      Id: `p${i}`,
    }));
    expect(
      classifyContentType({
        killer: { Id: "k" },
        victim: { Id: "v" },
        participants,
      })
    ).toBe("ZVZ");
  });

  it("prefers battle total players over involved count", () => {
    expect(
      classifyContentType({
        killer: { Id: "k" },
        victim: { Id: "v" },
        battleTotalPlayers: 40,
      })
    ).toBe("ZVZ");
  });
});
