export type MediaPlatform = "twitch" | "youtube";

const TWITCH_LOGIN_RE = /^[a-z0-9_]{3,25}$/;
const YOUTUBE_CHANNEL_ID_RE = /^UC[\w-]{21,}$/;

export function parseTwitchLogin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  try {
    const withProto = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const url = new URL(withProto);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "twitch.tv" || host === "m.twitch.tv") {
      const part = url.pathname.split("/").filter(Boolean)[0] ?? "";
      candidate = part;
    }
  } catch {
    candidate = trimmed.replace(/^@/, "");
  }

  const login = candidate.replace(/^@/, "").split(/[/?#]/)[0]?.toLowerCase() ?? "";
  return TWITCH_LOGIN_RE.test(login) ? login : null;
}

export function twitchChannelUrl(login: string): string {
  return `https://www.twitch.tv/${login}`;
}

export function twitchVodUrl(vodId: string, offsetSeconds?: number): string {
  const base = `https://www.twitch.tv/videos/${vodId}`;
  if (offsetSeconds == null || offsetSeconds <= 0) return base;
  return `${base}?t=${formatTwitchOffset(offsetSeconds)}`;
}

/** Rewind before the killboard death so the VOD starts in the fight, not on the corpse. */
export const KILL_VOD_LEAD_IN_SECONDS = 30;

export function twitchVodOffsetForKill(
  occurredAt: Date,
  streamStartedAt: Date,
  leadInSeconds = KILL_VOD_LEAD_IN_SECONDS
): number {
  const raw = Math.floor(
    (occurredAt.getTime() - streamStartedAt.getTime()) / 1000
  );
  return Math.max(0, raw - leadInSeconds);
}

export function formatTwitchOffset(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m${sec}s`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

/** Parse Helix VOD duration strings like `3h2m1s`, `14m7s`, `42s`. */
export function parseTwitchDurationSeconds(duration: string): number | null {
  const match = duration
    .trim()
    .match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match) return null;
  const h = match[1] ? Number(match[1]) : 0;
  const m = match[2] ? Number(match[2]) : 0;
  const s = match[3] ? Number(match[3]) : 0;
  if (!match[1] && !match[2] && !match[3]) return null;
  return h * 3600 + m * 60 + s;
}

export function parseYoutubeChannelInput(raw: string): {
  kind: "id" | "handle";
  value: string;
} | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (YOUTUBE_CHANNEL_ID_RE.test(trimmed)) {
    return { kind: "id", value: trimmed };
  }

  try {
    const withProto = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const url = new URL(withProto);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtu.be"
    ) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "channel" && parts[1] && YOUTUBE_CHANNEL_ID_RE.test(parts[1])) {
        return { kind: "id", value: parts[1] };
      }
      if (parts[0]?.startsWith("@")) {
        return { kind: "handle", value: parts[0].slice(1) };
      }
    }
  } catch {
    // fall through to handle parse
  }

  const handle = trimmed.replace(/^@/, "").split(/[/?#]/)[0] ?? "";
  if (handle.length >= 3 && /^[\w.-]+$/.test(handle)) {
    return { kind: "handle", value: handle };
  }
  return null;
}

export function youtubeChannelUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`;
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/** Helix live/VOD thumbs use `{width}`/`{height}` or `%{width}`/`%{height}` placeholders. */
export function sizedTwitchThumbnail(
  url: string | null | undefined,
  width = 440,
  height = 248
): string | null {
  if (!url?.trim()) return null;
  return url
    .replaceAll("%{width}", String(width))
    .replaceAll("%{height}", String(height))
    .replaceAll("{width}", String(width))
    .replaceAll("{height}", String(height));
}

export function isMediaPlatform(value: string): value is MediaPlatform {
  return value === "twitch" || value === "youtube";
}
