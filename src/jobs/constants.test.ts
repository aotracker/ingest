import { describe, expect, it } from "vitest";
import {
  BATTLE_NOT_READY_MAX_DEFERS,
  battleNotReadyDelayMs,
  BULLMQ_PRIORITY_MAX,
  BULLMQ_PRIORITY_MIN,
  clampBullmqPriority,
  JOB_PRIORITY_DEFAULT,
} from "./constants";

describe("battleNotReadyDelayMs", () => {
  it("escalates then caps at the last delay", () => {
    expect(battleNotReadyDelayMs(1)).toBe(2 * 60_000);
    expect(battleNotReadyDelayMs(2)).toBe(5 * 60_000);
    expect(battleNotReadyDelayMs(BATTLE_NOT_READY_MAX_DEFERS)).toBe(60 * 60_000);
    expect(battleNotReadyDelayMs(99)).toBe(60 * 60_000);
  });
});

describe("clampBullmqPriority", () => {
  it("keeps valid priorities", () => {
    expect(clampBullmqPriority(JOB_PRIORITY_DEFAULT)).toBe(JOB_PRIORITY_DEFAULT);
    expect(clampBullmqPriority(BULLMQ_PRIORITY_MIN)).toBe(BULLMQ_PRIORITY_MIN);
    expect(clampBullmqPriority(BULLMQ_PRIORITY_MAX)).toBe(BULLMQ_PRIORITY_MAX);
  });

  it("rejects epoch-ms values that BullMQ cannot accept", () => {
    expect(clampBullmqPriority(Date.parse("2026-08-19T06:00:00.000Z"))).toBe(
      BULLMQ_PRIORITY_MAX
    );
  });

  it("falls back for non-finite input", () => {
    expect(clampBullmqPriority(Number.NaN)).toBe(JOB_PRIORITY_DEFAULT);
  });
});
