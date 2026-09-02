/** Shared formatting helpers used by ingest workers and the web app. */

export function formatFame(value: number | null | undefined): string {
  if (value == null) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}b`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

/** Compact silver formatter (same scale labels as fame). */
export function formatSilver(value: number | null | undefined): string {
  return formatFame(value);
}

export function regionLabel(region: string): string {
  const labels: Record<string, string> = {
    americas: "Americas",
    europe: "Europe",
    asia: "Asia",
  };
  return labels[region] ?? region;
}

/** Albion API returns fame/healing as floats or decimal strings; DB columns are bigint. */
export function toBigInt(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n =
    typeof value === "number"
      ? value
      : parseFloat(String(value).replace(/,/g, ""));
  if (Number.isNaN(n)) return null;
  return Math.round(n);
}

/**
 * `players.fame_ratio` is numeric(10, 4) — max 999999.9999.
 * Albion returns huge FameRatio when death fame is 0; clamp so the upsert cannot overflow.
 */
export const FAME_RATIO_NUMERIC_MAX = 999_999.9999;
const FAME_RATIO_NUMERIC_MAX_SQL = "999999.9999";

export function toFameRatio(
  value: number | string | null | undefined
): string | null {
  if (value == null || value === "") return null;
  const n =
    typeof value === "number"
      ? value
      : parseFloat(String(value).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  if (n > FAME_RATIO_NUMERIC_MAX) return FAME_RATIO_NUMERIC_MAX_SQL;
  if (n < 0) return "0";
  return String(n);
}
