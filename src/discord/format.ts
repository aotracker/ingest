export { formatFame, formatSilver, regionLabel } from "@aotracker/core/utils";
export {
  itemIconCacheKey,
  itemIconIdentifier,
  normalizeItemQuality,
} from "@aotracker/core/item-icon-keys";

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

const UTC_MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Compact stamp for snapshot images where the full month name overflows. */
export function formatUtcStampShort(date: Date): string {
  const month = UTC_MONTHS_SHORT[date.getUTCMonth()] ?? "Jan";
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${month} ${day}, ${year} ${hh}:${mm}:${ss} UTC`;
}

export function formatItemPower(
  value: number | string | null | undefined
): string {
  if (value == null || value === "") return "—";
  const parsed = typeof value === "number" ? value : parseFloat(value);
  if (Number.isNaN(parsed) || parsed <= 0) return "—";
  return String(Math.round(parsed));
}

export function contentTypeLabel(type: string | null | undefined): string {
  if (type === "ZVZ") return "ZvZ";
  if (type === "SOLO") return "1v1";
  return "Group";
}
