import { parseTwitchDurationSeconds } from "../media/urls";

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const HELIX = "https://api.twitch.tv/helix";
/** Fallback if Get Games fails; Albion Online on Twitch. */
export const ALBION_TWITCH_GAME_ID_FALLBACK = "623654";

export type TwitchUser = {
  id: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
};

export type TwitchStream = {
  userId: string;
  userLogin: string;
  title: string;
  viewerCount: number;
  startedAt: string;
  thumbnailUrl: string;
  gameId: string;
};

export type TwitchVideo = {
  id: string;
  title: string;
  createdAt: string;
  durationSeconds: number | null;
  url: string;
};

type CachedToken = { token: string; expiresAtMs: number };
let cachedToken: CachedToken | null = null;
let cachedGameId: string | null = null;

export function twitchCredentials(): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  const clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export class TwitchHelixError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TwitchHelixError";
    this.status = status;
  }
}

async function getAppToken(): Promise<{
  token: string;
  clientId: string;
}> {
  const creds = twitchCredentials();
  if (!creds) {
    throw new TwitchHelixError("Twitch client credentials are not configured", 503);
  }
  if (cachedToken && Date.now() < cachedToken.expiresAtMs - 60_000) {
    return { token: cachedToken.token, clientId: creds.clientId };
  }

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: "client_credentials",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new TwitchHelixError(`Twitch token HTTP ${res.status}`, res.status);
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new TwitchHelixError("Twitch token response missing access_token", 502);
  }
  const expiresIn = Number(json.expires_in) || 3600;
  cachedToken = {
    token: json.access_token,
    expiresAtMs: Date.now() + expiresIn * 1000,
  };
  return { token: json.access_token, clientId: creds.clientId };
}

async function helixGet<T>(
  path: string,
  query: Record<string, string | string[]>
): Promise<T> {
  const { token, clientId } = await getAppToken();
  const url = new URL(`${HELIX}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, value);
    }
  }
  const res = await fetch(url, {
    headers: {
      "Client-Id": clientId,
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new TwitchHelixError(`Helix ${path} HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export async function getTwitchUserByLogin(
  login: string
): Promise<TwitchUser | null> {
  const json = await helixGet<{
    data?: Array<{
      id: string;
      login: string;
      display_name: string;
      profile_image_url?: string;
    }>;
  }>("/users", { login });
  const row = json.data?.[0];
  if (!row) return null;
  return {
    id: row.id,
    login: row.login,
    displayName: row.display_name,
    avatarUrl: row.profile_image_url?.trim() || null,
  };
}

export async function getAlbionTwitchGameId(): Promise<string> {
  if (cachedGameId) return cachedGameId;
  try {
    const json = await helixGet<{ data?: Array<{ id: string; name: string }> }>(
      "/games",
      { name: "Albion Online" }
    );
    const match = json.data?.find(
      (row) => row.name.toLowerCase() === "albion online"
    );
    cachedGameId = match?.id || ALBION_TWITCH_GAME_ID_FALLBACK;
  } catch {
    cachedGameId = ALBION_TWITCH_GAME_ID_FALLBACK;
  }
  return cachedGameId;
}

export async function getTwitchStreamsByUserIds(
  userIds: string[]
): Promise<TwitchStream[]> {
  if (userIds.length === 0) return [];
  const json = await helixGet<{
    data?: Array<{
      user_id: string;
      user_login: string;
      title: string;
      viewer_count: number;
      started_at: string;
      thumbnail_url: string;
      game_id: string;
    }>;
  }>("/streams", { user_id: userIds, first: "100" });
  return (json.data ?? []).map((row) => ({
    userId: row.user_id,
    userLogin: row.user_login,
    title: row.title,
    viewerCount: row.viewer_count,
    startedAt: row.started_at,
    thumbnailUrl: row.thumbnail_url,
    gameId: row.game_id,
  }));
}

export async function getTwitchArchiveVideos(
  userId: string,
  first = 8
): Promise<TwitchVideo[]> {
  const json = await helixGet<{
    data?: Array<{
      id: string;
      title: string;
      created_at: string;
      duration: string;
      url: string;
    }>;
  }>("/videos", {
    user_id: userId,
    type: "archive",
    first: String(Math.min(Math.max(first, 1), 20)),
  });
  return (json.data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    durationSeconds: parseTwitchDurationSeconds(row.duration),
    url: row.url,
  }));
}

export function matchVodToSession(
  videos: TwitchVideo[],
  startedAt: Date
): TwitchVideo | null {
  const startMs = startedAt.getTime();
  let best: TwitchVideo | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const video of videos) {
    const created = new Date(video.createdAt).getTime();
    if (Number.isNaN(created)) continue;
    const delta = Math.abs(created - startMs);
    if (delta < bestDelta) {
      best = video;
      bestDelta = delta;
    }
  }
  // Helix created_at is usually within a few minutes of stream start.
  if (best && bestDelta <= 15 * 60_000) return best;
  return null;
}
