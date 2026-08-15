import { describe, expect, it } from "vitest";
import {
  BATTLE_NOT_READY_MAX_DEFERS,
  battleNotReadyDelayMs,
} from "./constants";

describe("battleNotReadyDelayMs", () => {
  it("escalates then caps at the last delay", () => {
    expect(battleNotReadyDelayMs(1)).toBe(2 * 60_000);
    expect(battleNotReadyDelayMs(2)).toBe(5 * 60_000);
    expect(battleNotReadyDelayMs(BATTLE_NOT_READY_MAX_DEFERS)).toBe(60 * 60_000);
    expect(battleNotReadyDelayMs(99)).toBe(60 * 60_000);
  });
});
