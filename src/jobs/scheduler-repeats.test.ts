import { describe, expect, it } from "vitest";
import {
  isProtectedSchedulerJobId,
  isRepeatNextStuck,
  REPEAT_STUCK_SLACK_MS,
} from "./scheduler-repeats";

describe("isRepeatNextStuck", () => {
  const now = Date.parse("2026-08-17T20:22:00.000Z");

  it("treats a missing next run as stuck", () => {
    expect(isRepeatNextStuck(undefined, now)).toBe(true);
    expect(isRepeatNextStuck(null, now)).toBe(true);
  });

  it("treats a next run more than slack in the past as stuck", () => {
    expect(isRepeatNextStuck(now - REPEAT_STUCK_SLACK_MS - 1, now)).toBe(true);
  });

  it("allows a next run slightly in the past (clock skew)", () => {
    expect(isRepeatNextStuck(now - 5_000, now)).toBe(false);
  });

  it("is not stuck when the next run is in the future", () => {
    expect(isRepeatNextStuck(now + 60_000, now)).toBe(false);
  });
});

describe("isProtectedSchedulerJobId", () => {
  it("keeps manual admin triggers and startup catch-up jobs", () => {
    expect(isProtectedSchedulerJobId("manual-health-check-1")).toBe(true);
    expect(isProtectedSchedulerJobId("startup-ingest-poll-1")).toBe(true);
    expect(isProtectedSchedulerJobId("repeat:health-check:123")).toBe(false);
  });
});
