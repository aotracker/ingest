import type { AlbionRegion } from "./types";

const MAX_BODY_SNIPPET = 800;
const MAX_MESSAGE_LENGTH = 2000;

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

export type AlbionApiLogDetails = {
  url: string;
  path: string;
  method: string;
  region: AlbionRegion;
  latencyMs: number;
  attempt?: number;
  maxAttempts?: number;
  statusCode?: number;
  statusText?: string;
  responseBody?: string;
  networkCause?: string;
  timeoutMs?: number;
};

export type AlbionApiFailureRecord = {
  errorType: string;
  message: string;
  details: AlbionApiLogDetails;
};

export class AlbionApiError extends Error {
  readonly region: AlbionRegion;
  readonly path: string;
  readonly url: string;
  readonly errorType: string;
  readonly statusCode?: number;
  readonly details: AlbionApiLogDetails;

  constructor(message: string, record: AlbionApiFailureRecord) {
    super(message);
    this.name = "AlbionApiError";
    this.region = record.details.region;
    this.path = record.details.path;
    this.url = record.details.url;
    this.errorType = record.errorType;
    this.statusCode = record.details.statusCode;
    this.details = record.details;
  }
}

export type AlbionRequestErrorContext = {
  region: AlbionRegion;
  path: string;
  url: string;
  attempt: number;
  maxRetries: number;
  latencyMs: number;
  timeoutMs?: number;
};

export function truncateForLog(text: string, max = MAX_BODY_SNIPPET): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function clampMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_MESSAGE_LENGTH)}…`;
}

function attemptLabel(ctx: AlbionRequestErrorContext): string {
  return ctx.maxRetries > 0
    ? `attempt ${ctx.attempt + 1}/${ctx.maxRetries + 1}`
    : "single attempt";
}

function baseDetails(ctx: AlbionRequestErrorContext): AlbionApiLogDetails {
  return {
    region: ctx.region,
    path: ctx.path,
    url: ctx.url,
    method: "GET",
    latencyMs: ctx.latencyMs,
    attempt: ctx.attempt + 1,
    maxAttempts: ctx.maxRetries + 1,
    timeoutMs: ctx.timeoutMs,
  };
}

export async function buildAlbionHttpFailure(
  response: Response,
  ctx: AlbionRequestErrorContext
): Promise<AlbionApiFailureRecord> {
  let bodySnippet = "";
  try {
    const text = await response.text();
    if (text) {
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        const parts: string[] = [];
        if (json.message != null) parts.push(String(json.message));
        if (json.error != null) parts.push(String(json.error));
        if (json.title != null) parts.push(String(json.title));
        if (json.detail != null) parts.push(String(json.detail));
        if (json.errors != null) parts.push(JSON.stringify(json.errors));
        bodySnippet =
          parts.length > 0 ? parts.join("; ") : truncateForLog(text);
      } catch {
        bodySnippet = truncateForLog(text);
      }
    }
  } catch {
    // ignore body read failures
  }

  const statusLine = `HTTP ${response.status}${
    response.statusText ? ` ${response.statusText}` : ""
  }`;
  const segments = [
    `[${ctx.region}] ${statusLine}`,
    `GET ${ctx.path}`,
    `${attemptLabel(ctx)}, ${ctx.latencyMs}ms`,
  ];
  if (bodySnippet) segments.push(`response: ${bodySnippet}`);
  segments.push(`url: ${ctx.url}`);

  const details: AlbionApiLogDetails = {
    ...baseDetails(ctx),
    statusCode: response.status,
    statusText: response.statusText || undefined,
    responseBody: bodySnippet || undefined,
  };

  return {
    errorType: `http_${response.status}`,
    message: clampMessage(segments.join(" · ")),
    details,
  };
}

export function buildAlbionFetchFailure(
  err: unknown,
  ctx: AlbionRequestErrorContext
): AlbionApiFailureRecord {
  if (err instanceof AlbionApiError) {
    return {
      errorType: err.errorType,
      message: err.message,
      details: err.details,
    };
  }

  if (err instanceof Error && err.name === "AbortError") {
    const message = clampMessage(
      `[${ctx.region}] Albion gameinfo API timed out after ${ctx.latencyMs}ms (${attemptLabel(ctx)}) · GET ${ctx.path} · timeout: ${ctx.timeoutMs ?? "unknown"}ms · url: ${ctx.url}`
    );
    return {
      errorType: "timeout",
      message,
      details: baseDetails(ctx),
    };
  }

  const baseMessage = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause instanceof Error
      ? err.cause.message
      : undefined;

  let errorType = "request_failed";
  if (/fetch failed/i.test(baseMessage) || cause) {
    errorType = "network_error";
  }

  const detail =
    cause && cause !== baseMessage ? `${baseMessage} (cause: ${cause})` : baseMessage;

  const message = clampMessage(
    `[${ctx.region}] Albion gameinfo API request failed (${attemptLabel(ctx)}, ${ctx.latencyMs}ms) · GET ${ctx.path} · ${detail} · url: ${ctx.url}`
  );

  return {
    errorType,
    message,
    details: {
      ...baseDetails(ctx),
      networkCause: cause ?? baseMessage,
    },
  };
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
  if (error instanceof AlbionApiError && error.statusCode === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\bHTTP 404\b/.test(message);
}

export function describeAlbionError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
