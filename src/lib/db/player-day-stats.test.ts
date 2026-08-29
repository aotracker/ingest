import { describe, expect, it } from "vitest";
import { utcDate } from "./player-day-stats";

describe("player day UTC bucket", () => {
  it("uses the UTC calendar date", () => {
    expect(utcDate(new Date("2026-08-28T23:30:00.000Z"))).toBe("2026-08-28");
    expect(utcDate(new Date("2026-08-29T00:00:00.000Z"))).toBe("2026-08-29");
  });
});
