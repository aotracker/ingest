import { describe, expect, it } from "vitest";
import {
  formatPgError,
  isRetryableTxError,
  postgresErrorCode,
  withTxRetry,
} from "./pg-errors";

describe("isRetryableTxError", () => {
  it("detects Postgres deadlock and serialization codes on the cause chain", () => {
    const deadlock = Object.assign(new Error("Failed query: insert into x"), {
      cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    });
    const serialization = Object.assign(new Error("Failed query: update y"), {
      cause: Object.assign(new Error("could not serialize access"), {
        code: "40001",
      }),
    });
    expect(isRetryableTxError(deadlock)).toBe(true);
    expect(isRetryableTxError(serialization)).toBe(true);
    expect(postgresErrorCode(deadlock)).toBe("40P01");
  });

  it("does not retry unrelated query errors", () => {
    const unique = Object.assign(new Error("Failed query: insert into x"), {
      cause: Object.assign(new Error("duplicate key"), { code: "23505" }),
    });
    expect(isRetryableTxError(unique)).toBe(false);
    expect(isRetryableTxError(new Error("connection refused"))).toBe(false);
  });
});

describe("formatPgError", () => {
  it("appends the Postgres reason hidden on cause", () => {
    const err = Object.assign(new Error('Failed query: insert into "guild_hour_players"'), {
      cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    });
    expect(formatPgError(err)).toContain("Failed query");
    expect(formatPgError(err)).toContain("deadlock detected");
    expect(formatPgError(err)).toContain("40P01");
  });
});

describe("withTxRetry", () => {
  it("retries deadlock then returns the successful result", async () => {
    let attempts = 0;
    const result = await withTxRetry(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("Failed query"), {
          cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
        });
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    let attempts = 0;
    await expect(
      withTxRetry(async () => {
        attempts += 1;
        throw new Error("relation does not exist");
      })
    ).rejects.toThrow("relation does not exist");
    expect(attempts).toBe(1);
  });
});
