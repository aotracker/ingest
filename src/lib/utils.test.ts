import { describe, expect, it } from "vitest";
import { FAME_RATIO_NUMERIC_MAX, toFameRatio } from "./utils";

describe("toFameRatio", () => {
  it("passes through typical Albion ratios", () => {
    expect(toFameRatio(1.23)).toBe("1.23");
    expect(toFameRatio(0)).toBe("0");
    expect(toFameRatio(FAME_RATIO_NUMERIC_MAX)).toBe("999999.9999");
  });

  it("clamps overflow from 0-death fame players", () => {
    expect(toFameRatio(2_115_919.97)).toBe("999999.9999");
    expect(toFameRatio(1_000_000)).toBe("999999.9999");
  });

  it("rejects non-finite values", () => {
    expect(toFameRatio(null)).toBeNull();
    expect(toFameRatio(undefined)).toBeNull();
    expect(toFameRatio("")).toBeNull();
    expect(toFameRatio(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toFameRatio(Number.NaN)).toBeNull();
    expect(toFameRatio(-2)).toBe("0");
  });
});
