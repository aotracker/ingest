/** Postgres / Drizzle errors that are safe to retry as a whole transaction. */
const RETRYABLE_PG_CODES = new Set(["40001", "40P01"]);

const RETRYABLE_MESSAGE =
  /deadlock detected|could not serialize access|serialization failure/i;

export function unwrapErrorChain(err: unknown, depth = 5): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  for (let i = 0; i < depth && current != null; i++) {
    chain.push(current);
    if (typeof current !== "object") break;
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

export function postgresErrorCode(err: unknown): string | null {
  for (const item of unwrapErrorChain(err)) {
    if (
      item &&
      typeof item === "object" &&
      "code" in item &&
      typeof (item as { code: unknown }).code === "string"
    ) {
      return (item as { code: string }).code;
    }
  }
  return null;
}

export function isRetryableTxError(err: unknown): boolean {
  const code = postgresErrorCode(err);
  if (code && RETRYABLE_PG_CODES.has(code)) return true;
  return unwrapErrorChain(err).some((item) =>
    RETRYABLE_MESSAGE.test(item instanceof Error ? item.message : String(item))
  );
}

/** Drizzle's message is just "Failed query: …"; the PG reason is on `.cause`. */
export function formatPgError(err: unknown): string {
  const parts: string[] = [];
  for (const item of unwrapErrorChain(err)) {
    const message = item instanceof Error ? item.message : String(item);
    if (message && !parts.includes(message)) parts.push(message);
  }
  const code = postgresErrorCode(err);
  if (code && parts.length > 0) {
    parts[parts.length - 1] = `${parts[parts.length - 1]} (${code})`;
  }
  return parts.join(" — ") || "Unknown error";
}

const TX_RETRY_ATTEMPTS = 4;
const TX_RETRY_BASE_MS = 40;

export async function withTxRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= TX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === TX_RETRY_ATTEMPTS || !isRetryableTxError(err)) {
        throw err;
      }
      const delay =
        TX_RETRY_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 50);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
