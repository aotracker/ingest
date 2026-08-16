import {
  ensureCircuitAllows,
  enforceSharedRateLimit,
  getRegionHealthMetrics,
  recordApiFailure,
  recordApiSoftMiss,
  recordApiSuccess,
  CircuitOpenError,
} from "../db/api-state";
import {
  AlbionApiError,
  buildAlbionFetchFailure,
  buildAlbionHttpFailure,
  isHttpNotFoundError,
} from "./errors";
import { resolveBattleTotalPlayers } from "./battles";
import type {
  AlbionAllianceInfo,
  AlbionBattle,
  AlbionBattleSummary,
  AlbionEvent,
  AlbionGuildInfo,
  AlbionPlayerInfo,
  AlbionRegion,
  AlbionSearchResult,
  BattleSortType,
  RangeType,
} from "./types";
import { ENABLED_REGIONS, REGION_BASE_URLS } from "./types";

const RETRY_DELAYS = [1000, 3000, 9000];
const DEFAULT_TIMEOUT = 10_000;
const BATTLE_TIMEOUT = 20_000;
const MIN_REQUEST_INTERVAL_MS = 1000;

export const PAGE_LOAD_REQUEST_OPTIONS = {
  maxRetries: 0,
  timeout: 8_000,
} as const;

export { CircuitOpenError };

export interface RequestLog {
  region: AlbionRegion;
  endpoint: string;
  latencyMs: number;
  status: "success" | "error";
  errorType?: string;
  errorMessage?: string;
  timestamp: string;
}

export class AlbionApiClient {
  private lastRequestAt: Record<AlbionRegion, number> = {
    americas: 0,
    europe: 0,
    asia: 0,
  };

  async request<T>(
    region: AlbionRegion,
    path: string,
    options?: {
      timeout?: number;
      skipRateLimit?: boolean;
      maxRetries?: number;
      signal?: AbortSignal;
    }
  ): Promise<T> {
    await ensureCircuitAllows(region);

    if (!options?.skipRateLimit) {
      await this.enforceRateLimit(region);
    }

    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    const maxRetries = options?.maxRetries ?? RETRY_DELAYS.length;
    const url = `${REGION_BASE_URLS[region]}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const start = Date.now();
      const errorContext = {
        region,
        path,
        url,
        attempt,
        maxRetries,
        latencyMs: 0,
        timeoutMs: timeout,
      };

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const onOuterAbort = () => controller.abort();
        options?.signal?.addEventListener("abort", onOuterAbort, { once: true });
        if (options?.signal?.aborted) controller.abort();

        const response = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
          cache: "no-store",
        });

        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onOuterAbort);
        const latencyMs = Date.now() - start;
        errorContext.latencyMs = latencyMs;

        if (!response.ok) {
          const failure = await buildAlbionHttpFailure(response, errorContext);
          throw new AlbionApiError(failure.message, failure);
        }

        const data = (await response.json()) as T;
        await recordApiSuccess(region, path, latencyMs);
        return data;
      } catch (err) {
        const latencyMs = Date.now() - start;
        errorContext.latencyMs = latencyMs;

        if (err instanceof CircuitOpenError) {
          lastError = err;
          throw err;
        }

        const failure =
          err instanceof AlbionApiError
            ? {
                errorType: err.errorType,
                message: err.message,
                details: err.details,
              }
            : buildAlbionFetchFailure(err, errorContext);

        lastError =
          err instanceof AlbionApiError
            ? err
            : new Error(failure.message);

        if (attempt >= maxRetries) {
          if (isHttpNotFoundError(lastError)) {
            await recordApiSoftMiss(
              region,
              path,
              latencyMs,
              failure.message,
              failure.details
            );
          } else {
            await recordApiFailure(
              region,
              path,
              latencyMs,
              failure.errorType,
              failure.message,
              failure.details
            );
          }
        } else {
          await sleep(RETRY_DELAYS[attempt]);
        }
      }
    }

    throw lastError ?? new Error("Request failed");
  }

  async getRecentEvents(
    region: AlbionRegion,
    limit = 50,
    offset = 0
  ): Promise<AlbionEvent[]> {
    try {
      return await this.request<AlbionEvent[]>(
        region,
        `/events?limit=${limit}&offset=${offset}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (region === "asia" && message.includes("404")) {
        return [];
      }
      throw err;
    }
  }

  async getEvent(region: AlbionRegion, eventId: number): Promise<AlbionEvent> {
    return this.request<AlbionEvent>(region, `/events/${eventId}`);
  }

  async getPlayerInfo(
    region: AlbionRegion,
    playerId: string
  ): Promise<AlbionPlayerInfo> {
    return this.request<AlbionPlayerInfo>(region, `/players/${playerId}`);
  }

  async getPlayerDeaths(
    region: AlbionRegion,
    playerId: string
  ): Promise<AlbionEvent[]> {
    return this.request<AlbionEvent[]>(region, `/players/${playerId}/deaths`);
  }

  async getPlayerKills(
    region: AlbionRegion,
    playerId: string
  ): Promise<AlbionEvent[]> {
    return this.request<AlbionEvent[]>(region, `/players/${playerId}/kills`);
  }

  async getPlayerTopKills(
    region: AlbionRegion,
    playerId: string,
    limit = 10
  ): Promise<AlbionEvent[]> {
    return this.request<AlbionEvent[]>(
      region,
      `/players/${playerId}/topkills?limit=${limit}&range=week`
    );
  }

  async search(
    region: AlbionRegion,
    query: string,
    requestOptions?: { timeout?: number; maxRetries?: number }
  ): Promise<AlbionSearchResult> {
    return this.request<AlbionSearchResult>(
      region,
      `/search?q=${encodeURIComponent(query)}`,
      requestOptions
    );
  }

  async getBattle(
    region: AlbionRegion,
    battleId: number
  ): Promise<AlbionBattle> {
    return this.request<AlbionBattle>(region, `/battles/${battleId}`, {
      timeout: BATTLE_TIMEOUT,
    });
  }

  async getBattleEvents(
    region: AlbionRegion,
    battleId: number,
    options?: {
      offset?: number;
      limit?: number;
      requestOptions?: { timeout?: number; maxRetries?: number; signal?: AbortSignal };
    }
  ): Promise<AlbionEvent[]> {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 51;
    return this.request<AlbionEvent[]>(
      region,
      `/events/battle/${battleId}?offset=${offset}&limit=${limit}`,
      { timeout: BATTLE_TIMEOUT, ...options?.requestOptions }
    );
  }

  async getGuildInfo(
    region: AlbionRegion,
    guildId: string,
    requestOptions?: { timeout?: number; maxRetries?: number }
  ): Promise<AlbionGuildInfo> {
    return this.request<AlbionGuildInfo>(
      region,
      `/guilds/${guildId}`,
      requestOptions
    );
  }

  async getGuildTopKills(
    region: AlbionRegion,
    guildId: string,
    options?: {
      limit?: number;
      range?: RangeType;
      requestOptions?: { timeout?: number; maxRetries?: number };
    }
  ): Promise<AlbionEvent[]> {
    const params = new URLSearchParams();
    params.set("limit", String(options?.limit ?? 10));
    params.set("range", options?.range ?? "week");
    return this.request<AlbionEvent[]>(
      region,
      `/guilds/${guildId}/top?${params.toString()}`,
      options?.requestOptions
    );
  }

  async getBattles(
    region: AlbionRegion,
    options?: {
      guildId?: string;
      allianceId?: string;
      sort?: BattleSortType;
      limit?: number;
      offset?: number;
      range?: RangeType;
      requestOptions?: { timeout?: number; maxRetries?: number };
    }
  ): Promise<AlbionBattleSummary[]> {
    const raw = await this.getBattlesRaw(region, options);
    return raw.map(normalizeBattleSummary);
  }

  async getBattlesRaw(
    region: AlbionRegion,
    options?: {
      guildId?: string;
      allianceId?: string;
      sort?: BattleSortType;
      limit?: number;
      offset?: number;
      range?: RangeType;
      requestOptions?: { timeout?: number; maxRetries?: number };
    }
  ): Promise<AlbionBattle[]> {
    const params = new URLSearchParams();
    params.set("limit", String(options?.limit ?? 10));
    params.set("offset", String(options?.offset ?? 0));
    params.set("sort", options?.sort ?? "recent");
    if (options?.guildId) params.set("guildId", options.guildId);
    if (options?.allianceId) params.set("allianceId", options.allianceId);
    if (options?.range) params.set("range", options.range);

    return this.request<AlbionBattle[]>(
      region,
      `/battles?${params.toString()}`,
      { timeout: BATTLE_TIMEOUT, ...options?.requestOptions }
    );
  }

  async getAllianceInfo(
    region: AlbionRegion,
    allianceId: string,
    requestOptions?: { timeout?: number; maxRetries?: number }
  ): Promise<AlbionAllianceInfo> {
    return this.request<AlbionAllianceInfo>(
      region,
      `/alliances/${allianceId}`,
      requestOptions
    );
  }

  async ping(
    region: AlbionRegion
  ): Promise<{
    ok: boolean;
    latencyMs: number;
    note?: string;
    details?: Record<string, unknown>;
  }> {
    const start = Date.now();
    const eventsPath = "/events?limit=1";
    const searchPath = "/search?q=a";
    const probePath = region === "asia" ? searchPath : eventsPath;
    const probeUrl = `${REGION_BASE_URLS[region]}${probePath}`;
    // Health/status pages must not wait on full retry budgets when gameinfo is down.
    const pingOptions = {
      skipRateLimit: true,
      maxRetries: 0,
      timeout: 5_000,
    } as const;

    if (region === "asia") {
      try {
        await this.request<AlbionSearchResult>(region, searchPath, pingOptions);
        return {
          ok: true,
          latencyMs: Date.now() - start,
          note: "Using search endpoint (events feed unavailable)",
        };
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          return {
            ok: false,
            latencyMs: Date.now() - start,
            note: `[${region}] Circuit open — cooling down before probe`,
            details: {
              region,
              path: probePath,
              url: probeUrl,
              reason: "circuit_open",
            },
          };
        }
        if (err instanceof AlbionApiError) {
          return {
            ok: false,
            latencyMs: Date.now() - start,
            note: err.message,
            details: err.details,
          };
        }
        return {
          ok: false,
          latencyMs: Date.now() - start,
          note: err instanceof Error ? err.message : String(err),
          details: {
            region,
            path: probePath,
            url: probeUrl,
          },
        };
      }
    }

    try {
      await this.request<AlbionEvent[]>(region, eventsPath, pingOptions);
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          note: `[${region}] Circuit open — cooling down before probe`,
          details: {
            region,
            path: probePath,
            url: probeUrl,
            reason: "circuit_open",
          },
        };
      }
      if (err instanceof AlbionApiError) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          note: err.message,
          details: err.details,
        };
      }
      return {
        ok: false,
        latencyMs: Date.now() - start,
        note: err instanceof Error ? err.message : String(err),
        details: {
          region,
          path: probePath,
          url: probeUrl,
        },
      };
    }
  }

  async getHealthMetrics(): Promise<
    Record<
      AlbionRegion,
      {
        circuitOpen: boolean;
        consecutiveFailures: number;
        lastSuccessAt: string | null;
        lastErrorAt: string | null;
        lastErrorMessage: string | null;
        avgLatencyMs: number;
      }
    >
  > {
    const result = {} as Record<
      AlbionRegion,
      {
        circuitOpen: boolean;
        consecutiveFailures: number;
        lastSuccessAt: string | null;
        lastErrorAt: string | null;
        lastErrorMessage: string | null;
        avgLatencyMs: number;
      }
    >;

    for (const region of ENABLED_REGIONS) {
      result[region] = await getRegionHealthMetrics(region);
    }

    return result;
  }

  private async enforceRateLimit(region: AlbionRegion): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt[region];
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
    }
    this.lastRequestAt[region] = Date.now();

    await enforceSharedRateLimit(region, MIN_REQUEST_INTERVAL_MS);
  }
}

let clientInstance: AlbionApiClient | null = null;

export function getAlbionClient(): AlbionApiClient {
  if (!clientInstance) clientInstance = new AlbionApiClient();
  return clientInstance;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBattleSummary(battle: AlbionBattle): AlbionBattleSummary {
  return {
    id: battle.id ?? battle.albionId ?? 0,
    startTime: battle.startTime ?? null,
    totalFame: battle.totalFame ?? null,
    totalKills: battle.totalKills ?? null,
    totalPlayers: resolveBattleTotalPlayers(battle),
  };
}
