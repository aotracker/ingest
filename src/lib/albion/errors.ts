import type { AlbionRegion } from "./types";

/** Albion has not published battle detail yet (typically HTTP 404). Soft-defer, do not hard-fail. */
export class BattleNotReadyError extends Error {
  readonly region: AlbionRegion;
  readonly battleId: number;

  constructor(region: AlbionRegion, battleId: number, detail?: string) {
    const suffix = detail ? `: ${detail}` : "";
    super(
      `Battle detail not ready from Albion API (${region}/${battleId})${suffix}`
    );
    this.name = "BattleNotReadyError";
    this.region = region;
    this.battleId = battleId;
  }
}

export function isBattleNotReadyError(
  error: unknown
): error is BattleNotReadyError {
  return (
    error instanceof BattleNotReadyError ||
    (error instanceof Error && error.name === "BattleNotReadyError")
  );
}

export function isHttpNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bHTTP 404\b/.test(message);
}
