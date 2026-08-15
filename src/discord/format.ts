const UTC_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function formatUtcStamp(date: Date): string {
  const month = UTC_MONTHS[date.getUTCMonth()] ?? "January";
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${month} ${day}, ${year} at ${hh}:${mm}:${ss} UTC`;
}

export function formatFame(value: number | null | undefined): string {
  if (value == null) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}b`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

export function formatSilver(value: number | null | undefined): string {
  return formatFame(value);
}

export function formatItemPower(
  value: number | string | null | undefined
): string {
  if (value == null || value === "") return "—";
  const parsed = typeof value === "number" ? value : parseFloat(value);
  if (Number.isNaN(parsed) || parsed <= 0) return "—";
  return String(Math.round(parsed));
}

export function itemIconCacheKey(
  type: string,
  quality: number | null | undefined = 1
): string {
  const [base, enchant] = type.split("@");
  const q =
    quality == null || !Number.isFinite(quality) || quality < 1
      ? 1
      : Math.min(5, Math.round(quality));
  const enchantSuffix = enchant ? `@${enchant}` : "";
  return `${base}${enchantSuffix}_q${q}`;
}

export function itemIconIdentifier(type: string): string {
  const [base, enchant] = type.split("@");
  return enchant ? `${base}@${enchant}` : base;
}

export function normalizeItemQuality(quality: number | null | undefined): number {
  const q = quality ?? 1;
  if (!Number.isFinite(q) || q < 1) return 1;
  if (q > 5) return 5;
  return Math.round(q);
}

export function contentTypeLabel(type: string | null | undefined): string {
  if (type === "ZVZ") return "ZvZ";
  if (type === "SOLO") return "1v1";
  return "Group";
}

export function regionLabel(region: string): string {
  if (region === "europe") return "Europe";
  if (region === "asia") return "Asia";
  return "Americas";
}
