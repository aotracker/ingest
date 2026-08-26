/** Kill switch: bot, notify enqueue, and Discord guild catch-up. */
export function isDiscordEnabled(): boolean {
  return process.env.DISCORD_ENABLED === "1";
}

export function discordBotToken(): string | null {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  return token || null;
}

export function discordClientId(): string | null {
  const id = process.env.DISCORD_CLIENT_ID?.trim();
  return id || null;
}

export function discordDevGuildId(): string | null {
  const id = process.env.DISCORD_DEV_GUILD_ID?.trim();
  return id || null;
}

/** Discord snowflake IDs are 17–20 digit numbers, not YouTube/random strings. */
export function isDiscordSnowflake(id: string | null | undefined): id is string {
  return typeof id === "string" && /^\d{17,20}$/.test(id);
}

export function snapshotCdnBase(): string {
  return (
    process.env.DISCORD_SNAPSHOT_CDN?.replace(/\/$/, "") ||
    "https://cdn.aotracker.net/snapshots"
  );
}

export function itemIconCdnBase(): string {
  return (
    process.env.ITEM_ICON_CDN?.replace(/\/$/, "") ||
    "https://cdn.aotracker.net/item-icons"
  );
}

export function appPublicUrl(): string {
  return (
    process.env.APP_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    "https://www.aotracker.net"
  );
}

export const DISCORD_INVITE_PERMISSIONS = "309237446016";

export function discordInviteUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    permissions: DISCORD_INVITE_PERMISSIONS,
    integration_type: "0",
    scope: "bot applications.commands",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
