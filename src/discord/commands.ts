import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  ApplicationIntegrationType,
  InteractionContextType,
} from "discord-api-types/v10";
import {
  ALL_REGIONS,
  type AlbionRegion,
} from "@aotracker/core/albion/types";
import {
  getAllianceByAlbionId,
  getAllianceByName,
  getGuildByAlbionId,
  getGuildByName,
  getPlayerByAlbionId,
  getPlayerByName,
  listFeedsForServer,
  searchAlliancesForAutocomplete,
  searchGuildsForAutocomplete,
  searchPlayersForAutocomplete,
  setFeedChannel,
  trackGuildFeeds,
  untrackGuildFeeds,
  updateFeedFilters,
  upsertDiscordServer,
} from "./db";
import { regionLabel } from "./format";
import {
  addWatchlistEntry,
  consumeWatchlistRateLimit,
  feudPageUrl,
  findUserIdByDiscordAccountId,
  guildProfileUrl,
  listClaimedCharactersForUser,
  playerProfileUrl,
} from "./site-user";
import {
  FEED_GUILD_BATTLES,
  FEED_GUILD_DEATHS,
  FEED_GUILD_KILLS,
  applyFeedFilterPatch,
  parseFilters,
  DEFAULT_BATTLE_FEED_MIN_PLAYERS,
  type DiscordFeedFilters,
  type DiscordFeedType,
  type FeedFilterPatch,
} from "./types";

function isRegion(value: string | null): value is AlbionRegion {
  return !!value && (ALL_REGIONS as string[]).includes(value);
}

function hasManageGuild(interaction: ChatInputCommandInteraction): boolean {
  return (
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true
  );
}

function guildCommand(): SlashCommandBuilder {
  return new SlashCommandBuilder()
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setContexts(InteractionContextType.Guild);
}

export const slashCommandBuilders = [
  guildCommand()
    .setName("track")
    .setDescription("Follow an Albion guild's kills, deaths, and battles in this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName("region")
        .setDescription("Albion region")
        .setRequired(true)
        .addChoices(
          { name: "Americas", value: "americas" },
          { name: "Europe", value: "europe" },
          { name: "Asia", value: "asia" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("guild")
        .setDescription("Albion guild (must already exist on AOTracker)")
        .setRequired(true)
        .setAutocomplete(true)
    ),
  guildCommand()
    .setName("kills-channel")
    .setDescription("Channel for tracked-guild kills")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Kills channel")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    ),
  guildCommand()
    .setName("deaths-channel")
    .setDescription("Channel for tracked-guild deaths")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Deaths channel")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    ),
  guildCommand()
    .setName("battles-channel")
    .setDescription("Channel for tracked-guild battle summaries")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Battles channel")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    ),
  guildCommand()
    .setName("untrack")
    .setDescription("Stop posting kills, deaths, and battles in this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  guildCommand()
    .setName("status")
    .setDescription("Show AOTracker Discord feed settings for this server"),
  guildCommand()
    .setName("feed-filters")
    .setDescription("Set min fame, min players, content types, or pause Discord posts")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((option) =>
      option
        .setName("min-fame")
        .setDescription("Minimum kill fame (0 = any)")
        .setMinValue(0)
    )
    .addIntegerOption((option) =>
      option
        .setName("min-silver")
        .setDescription("Minimum estimated loot silver (0 = any)")
        .setMinValue(0)
    )
    .addStringOption((option) =>
      option
        .setName("content")
        .setDescription("Content types: all, or SOLO,GROUP,ZVZ")
    )
    .addBooleanOption((option) =>
      option.setName("paused").setDescription("Pause Discord posts")
    )
    .addIntegerOption((option) =>
      option
        .setName("min-players")
        .setDescription("Minimum battle size (players). Used by the battles feed.")
        .setMinValue(1)
        .setMaxValue(500)
    )
    .addBooleanOption((option) =>
      option
        .setName("create-thread")
        .setDescription("Start a Discord thread for each battle summary")
    )
    .addStringOption((option) =>
      option
        .setName("feed")
        .setDescription("Which feed to update (default: all)")
        .addChoices(
          { name: "Kills", value: "kills" },
          { name: "Deaths", value: "deaths" },
          { name: "Battles", value: "battles" },
          { name: "All", value: "both" }
        )
    ),
  guildCommand()
    .setName("ping-role")
    .setDescription("Role to mention on kill, death, or battle posts")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption((option) =>
      option.setName("role").setDescription("Role to ping (omit with clear)")
    )
    .addBooleanOption((option) =>
      option.setName("clear").setDescription("Stop pinging a role")
    )
    .addStringOption((option) =>
      option
        .setName("feed")
        .setDescription("Which feed to update (default: all)")
        .addChoices(
          { name: "Kills", value: "kills" },
          { name: "Deaths", value: "deaths" },
          { name: "Battles", value: "battles" },
          { name: "All", value: "both" }
        )
    ),
  guildCommand()
    .setName("whoami")
    .setDescription("Show your AOTracker claimed character"),
  guildCommand()
    .setName("lookup")
    .setDescription("Find an Albion player or guild on AOTracker")
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription("Player or guild")
        .setRequired(true)
        .addChoices(
          { name: "Player", value: "player" },
          { name: "Guild", value: "guild" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("region")
        .setDescription("Albion region")
        .setRequired(true)
        .addChoices(
          { name: "Americas", value: "americas" },
          { name: "Europe", value: "europe" },
          { name: "Asia", value: "asia" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Name (must already exist on AOTracker)")
        .setRequired(true)
        .setAutocomplete(true)
    ),
  guildCommand()
    .setName("feud")
    .setDescription("Link to the feud page for two Albion guilds")
    .addStringOption((option) =>
      option
        .setName("region")
        .setDescription("Albion region")
        .setRequired(true)
        .addChoices(
          { name: "Americas", value: "americas" },
          { name: "Europe", value: "europe" },
          { name: "Asia", value: "asia" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("guild-a")
        .setDescription("First guild")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("guild-b")
        .setDescription("Second guild")
        .setRequired(true)
        .setAutocomplete(true)
    ),
  guildCommand()
    .setName("watchlist-add")
    .setDescription("Add a player, guild, or alliance to your AOTracker watchlist")
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription("What to watch")
        .setRequired(true)
        .addChoices(
          { name: "Player", value: "player" },
          { name: "Guild", value: "guild" },
          { name: "Alliance", value: "alliance" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("region")
        .setDescription("Albion region")
        .setRequired(true)
        .addChoices(
          { name: "Americas", value: "americas" },
          { name: "Europe", value: "europe" },
          { name: "Asia", value: "asia" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Name (must already exist on AOTracker)")
        .setRequired(true)
        .setAutocomplete(true)
    ),
];

function autocompleteChoices(
  rows: { albionId: string; name: string; region: AlbionRegion }[],
  region?: AlbionRegion
) {
  return rows.slice(0, 25).map((row) => ({
    name: region
      ? row.name.slice(0, 100)
      : `${row.name} (${regionLabel(row.region)})`.slice(0, 100),
    value: row.albionId,
  }));
}

export async function handleAutocomplete(
  interaction: AutocompleteInteraction
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const regionRaw = interaction.options.getString("region");
  const region = isRegion(regionRaw) ? regionRaw : undefined;

  if (interaction.commandName === "track" && focused.name === "guild") {
    const rows = await searchGuildsForAutocomplete(focused.value, region);
    await interaction.respond(autocompleteChoices(rows, region));
    return;
  }

  if (
    (interaction.commandName === "lookup" ||
      interaction.commandName === "watchlist-add") &&
    focused.name === "name"
  ) {
    const type = interaction.options.getString("type");
    if (type === "player") {
      const rows = await searchPlayersForAutocomplete(focused.value, region);
      await interaction.respond(autocompleteChoices(rows, region));
      return;
    }
    if (type === "guild") {
      const rows = await searchGuildsForAutocomplete(focused.value, region);
      await interaction.respond(autocompleteChoices(rows, region));
      return;
    }
    if (type === "alliance") {
      const rows = await searchAlliancesForAutocomplete(focused.value, region);
      await interaction.respond(autocompleteChoices(rows, region));
      return;
    }
  }

  if (
    interaction.commandName === "feud" &&
    (focused.name === "guild-a" || focused.name === "guild-b")
  ) {
    const rows = await searchGuildsForAutocomplete(focused.value, region);
    await interaction.respond(autocompleteChoices(rows, region));
    return;
  }

  await interaction.respond([]);
}

const MANAGE_COMMANDS = new Set([
  "track",
  "kills-channel",
  "deaths-channel",
  "battles-channel",
  "untrack",
  "feed-filters",
  "ping-role",
]);

export async function handleChatCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "These commands only work in a Discord server.",
      ephemeral: true,
    });
    return;
  }

  if (
    MANAGE_COMMANDS.has(interaction.commandName) &&
    !hasManageGuild(interaction)
  ) {
    await interaction.reply({
      content: "You need **Manage Server** to configure AOTracker.",
      ephemeral: true,
    });
    return;
  }

  await upsertDiscordServer(interaction.guildId, interaction.guild?.name ?? null);

  switch (interaction.commandName) {
    case "track":
      await handleTrack(interaction);
      return;
    case "kills-channel":
      await handleChannel(interaction, FEED_GUILD_KILLS, "kills");
      return;
    case "deaths-channel":
      await handleChannel(interaction, FEED_GUILD_DEATHS, "deaths");
      return;
    case "battles-channel":
      await handleChannel(interaction, FEED_GUILD_BATTLES, "battles");
      return;
    case "untrack":
      await handleUntrack(interaction);
      return;
    case "status":
      await handleStatus(interaction);
      return;
    case "feed-filters":
      await handleFeedFilters(interaction);
      return;
    case "ping-role":
      await handlePingRole(interaction);
      return;
    case "whoami":
      await handleWhoami(interaction);
      return;
    case "lookup":
      await handleLookup(interaction);
      return;
    case "feud":
      await handleFeud(interaction);
      return;
    case "watchlist-add":
      await handleWatchlistAdd(interaction);
      return;
    default:
      await interaction.reply({
        content: "Unknown command.",
        ephemeral: true,
      });
  }
}

async function handleTrack(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const regionRaw = interaction.options.getString("region", true);
  const albionId = interaction.options.getString("guild", true);
  if (!isRegion(regionRaw)) {
    await interaction.reply({
      content: "Pick a valid region.",
      ephemeral: true,
    });
    return;
  }

  const guild =
    (await getGuildByAlbionId(regionRaw, albionId)) ??
    (await getGuildByName(regionRaw, albionId));
  if (!guild) {
    await interaction.reply({
      content:
        "That guild is not in AOTracker yet. Open it on aotracker.net first, then run `/track` again.",
      ephemeral: true,
    });
    return;
  }

  const { replaced } = await trackGuildFeeds({
    discordGuildId: interaction.guildId!,
    discordGuildName: interaction.guild?.name ?? null,
    region: regionRaw,
    albionGuildId: guild.albionId,
    albionGuildName: guild.name,
    createdByUserId: interaction.user.id,
  });

  await interaction.reply({
    content: replaced
      ? `Now tracking **${guild.name}** (${regionLabel(regionRaw)}). Previous guild tracking was replaced. Set channels with \`/kills-channel\`, \`/deaths-channel\`, and \`/battles-channel\`.`
      : `Tracking **${guild.name}** (${regionLabel(regionRaw)}). Set channels with \`/kills-channel\`, \`/deaths-channel\`, and \`/battles-channel\`.`,
    ephemeral: true,
  });
}

async function handleChannel(
  interaction: ChatInputCommandInteraction,
  feedType: DiscordFeedType,
  label: string
): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);
  const updated = await setFeedChannel(
    interaction.guildId!,
    feedType,
    channel.id
  );
  if (!updated) {
    await interaction.reply({
      content: "Run `/track` first to choose an Albion guild.",
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({
    content: `${label} will post in <#${channel.id}>.`,
    ephemeral: true,
  });
}

async function handleUntrack(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const removed = await untrackGuildFeeds(interaction.guildId!);
  await interaction.reply({
    content:
      removed > 0
        ? "Stopped tracking. Channels will no longer receive kill, death, or battle posts."
        : "Nothing was being tracked in this server.",
    ephemeral: true,
  });
}

async function handleStatus(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const feeds = await listFeedsForServer(interaction.guildId!);
  const kills = feeds.find((f) => f.feedType === FEED_GUILD_KILLS);
  const deaths = feeds.find((f) => f.feedType === FEED_GUILD_DEATHS);
  const battles = feeds.find((f) => f.feedType === FEED_GUILD_BATTLES);
  if (!kills && !deaths && !battles) {
    await interaction.reply({
      content: "No Albion guild is tracked. Use `/track` to start.",
      ephemeral: true,
    });
    return;
  }
  const target = kills ?? deaths ?? battles;
  const lines = [
    `**Guild:** ${target?.targetName ?? "?"} (${regionLabel(target?.region ?? "americas")})`,
    `**Kills:** ${kills?.channelId ? `<#${kills.channelId}>` : "not set"}`,
    `**Deaths:** ${deaths?.channelId ? `<#${deaths.channelId}>` : "not set"}`,
    `**Battles:** ${battles?.channelId ? `<#${battles.channelId}>` : "not set"}`,
    `**Kills filters:** ${formatFilterLine(parseFilters(kills?.filters))}`,
    `**Deaths filters:** ${formatFilterLine(parseFilters(deaths?.filters))}`,
    `**Battles filters:** ${formatBattleFilterLine(parseFilters(battles?.filters))}`,
  ];
  await interaction.reply({ content: lines.join("\n"), ephemeral: true });
}

function formatFilterLine(filters: DiscordFeedFilters): string {
  const parts = [
    filters.paused ? "paused" : "active",
    `fame ${filters.minFame ?? 0}`,
    `silver ${filters.minSilver ?? 0}`,
    filters.contentTypes?.length ? filters.contentTypes.join(",") : "all content",
  ];
  if (filters.pingRoleId) parts.push(`ping <@&${filters.pingRoleId}>`);
  return parts.join(" · ");
}

function formatBattleFilterLine(filters: DiscordFeedFilters): string {
  const parts = [
    filters.paused ? "paused" : "active",
    `min players ${filters.minPlayers ?? DEFAULT_BATTLE_FEED_MIN_PLAYERS}`,
    filters.createThread ? "thread" : "no thread",
  ];
  if (filters.pingRoleId) parts.push(`ping <@&${filters.pingRoleId}>`);
  return parts.join(" · ");
}

function feedTypesFromOption(
  value: string | null
): DiscordFeedType[] | undefined {
  if (value === "kills") return [FEED_GUILD_KILLS];
  if (value === "deaths") return [FEED_GUILD_DEATHS];
  if (value === "battles") return [FEED_GUILD_BATTLES];
  return undefined;
}

async function handleFeedFilters(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const feeds = await listFeedsForServer(interaction.guildId!);
  if (feeds.length === 0) {
    await interaction.reply({
      content: "Run `/track` first to choose an Albion guild.",
      ephemeral: true,
    });
    return;
  }

  const patch: FeedFilterPatch = {};
  const minFame = interaction.options.getInteger("min-fame");
  const minSilver = interaction.options.getInteger("min-silver");
  const content = interaction.options.getString("content");
  const paused = interaction.options.getBoolean("paused");
  const minPlayers = interaction.options.getInteger("min-players");
  const createThread = interaction.options.getBoolean("create-thread");

  if (minFame != null) {
    patch.minFame = minFame > 0 ? minFame : null;
  }
  if (minSilver != null) {
    patch.minSilver = minSilver > 0 ? minSilver : null;
  }
  if (content != null) {
    const types = content
      .split(/[,\s]+/)
      .map((value) => value.trim().toUpperCase())
      .filter((value) => value === "SOLO" || value === "GROUP" || value === "ZVZ");
    patch.contentTypes = types.length > 0 ? types : null;
  }
  if (paused != null) {
    patch.paused = paused ? true : null;
  }
  if (minPlayers != null) {
    patch.minPlayers = minPlayers > 0 ? minPlayers : null;
  }
  if (createThread != null) {
    patch.createThread = createThread ? true : null;
  }

  if (Object.keys(patch).length === 0) {
    await interaction.reply({
      content:
        "Provide at least one option: `min-fame`, `min-silver`, `content`, `paused`, `min-players`, or `create-thread`.",
      ephemeral: true,
    });
    return;
  }

  const updated = await updateFeedFilters(
    interaction.guildId!,
    patch,
    feedTypesFromOption(interaction.options.getString("feed"))
  );
  const next = applyFeedFilterPatch(parseFilters(feeds[0]?.filters), patch);
  const scope = interaction.options.getString("feed") ?? "all";
  await interaction.reply({
    content: [
      `Updated filters on ${updated} ${scope} feed${updated === 1 ? "" : "s"}.`,
      `Paused: ${next.paused ? "yes" : "no"}`,
      `Min fame: ${next.minFame ?? 0}`,
      `Min silver: ${next.minSilver ?? 0}`,
      `Min players: ${next.minPlayers ?? DEFAULT_BATTLE_FEED_MIN_PLAYERS}`,
      `Thread per battle: ${next.createThread ? "yes" : "no"}`,
      `Content: ${next.contentTypes?.length ? next.contentTypes.join(", ") : "all"}`,
    ].join("\n"),
    ephemeral: true,
  });
}

async function handlePingRole(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const feeds = await listFeedsForServer(interaction.guildId!);
  if (feeds.length === 0) {
    await interaction.reply({
      content: "Run `/track` first to choose an Albion guild.",
      ephemeral: true,
    });
    return;
  }

  const clear = interaction.options.getBoolean("clear");
  const role = interaction.options.getRole("role");
  if (!clear && !role) {
    await interaction.reply({
      content: "Pick a role, or set `clear` to stop pinging.",
      ephemeral: true,
    });
    return;
  }

  const patch: FeedFilterPatch = {
    pingRoleId: clear || !role ? null : role.id,
  };
  const updated = await updateFeedFilters(
    interaction.guildId!,
    patch,
    feedTypesFromOption(interaction.options.getString("feed"))
  );
  await interaction.reply({
    content: clear || !role
      ? `Cleared ping role on ${updated} feed${updated === 1 ? "" : "s"}.`
      : `Will ping <@&${role.id}> on ${updated} feed${updated === 1 ? "" : "s"}.`,
    ephemeral: true,
  });
}

async function handleWhoami(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const userId = await findUserIdByDiscordAccountId(interaction.user.id);
  if (!userId) {
    await interaction.reply({
      content:
        "No AOTracker account is linked to this Discord user. Sign in on aotracker.net and claim a character.",
      ephemeral: true,
    });
    return;
  }
  const claims = await listClaimedCharactersForUser(userId);
  if (claims.length === 0) {
    await interaction.reply({
      content:
        "You're signed in on AOTracker, but no character is claimed. Open Account settings and claim one per region.",
      ephemeral: true,
    });
    return;
  }
  const lines = claims.map(
    (claim) =>
      `**${claim.name}** (${regionLabel(claim.region)}) — ${playerProfileUrl(claim.region, claim.name)}`
  );
  await interaction.reply({
    content: lines.join("\n"),
    ephemeral: true,
  });
}

async function handleLookup(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const type = interaction.options.getString("type", true);
  const regionRaw = interaction.options.getString("region", true);
  const name = interaction.options.getString("name", true);
  if (!isRegion(regionRaw)) {
    await interaction.reply({ content: "Pick a valid region.", ephemeral: true });
    return;
  }

  if (type === "player") {
    const player =
      (await getPlayerByAlbionId(regionRaw, name)) ??
      (await getPlayerByName(regionRaw, name));
    if (!player) {
      await interaction.reply({
        content:
          "That player is not in AOTracker yet. Open them on aotracker.net first.",
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      content: `**${player.name}** (${regionLabel(regionRaw)})\n${playerProfileUrl(regionRaw, player.name)}`,
      ephemeral: true,
    });
    return;
  }

  const guild =
    (await getGuildByAlbionId(regionRaw, name)) ??
    (await getGuildByName(regionRaw, name));
  if (!guild) {
    await interaction.reply({
      content:
        "That guild is not in AOTracker yet. Open it on aotracker.net first.",
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({
    content: `**${guild.name}** (${regionLabel(regionRaw)})\n${guildProfileUrl(regionRaw, guild.name)}`,
    ephemeral: true,
  });
}

async function handleFeud(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const regionRaw = interaction.options.getString("region", true);
  const a = interaction.options.getString("guild-a", true);
  const b = interaction.options.getString("guild-b", true);
  if (!isRegion(regionRaw)) {
    await interaction.reply({ content: "Pick a valid region.", ephemeral: true });
    return;
  }
  const guildA =
    (await getGuildByAlbionId(regionRaw, a)) ?? (await getGuildByName(regionRaw, a));
  const guildB =
    (await getGuildByAlbionId(regionRaw, b)) ?? (await getGuildByName(regionRaw, b));
  if (!guildA || !guildB) {
    await interaction.reply({
      content:
        "Both guilds must already exist on AOTracker. Search them on the site first.",
      ephemeral: true,
    });
    return;
  }
  if (guildA.albionId === guildB.albionId) {
    await interaction.reply({
      content: "Pick two different guilds.",
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({
    content: `${guildA.name} vs ${guildB.name} (${regionLabel(regionRaw)})\n${feudPageUrl(regionRaw, guildA.name, guildB.name)}`,
    ephemeral: true,
  });
}

async function handleWatchlistAdd(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!consumeWatchlistRateLimit(interaction.user.id)) {
    await interaction.reply({
      content: "Too many watchlist updates. Try again in a few minutes.",
      ephemeral: true,
    });
    return;
  }

  const userId = await findUserIdByDiscordAccountId(interaction.user.id);
  if (!userId) {
    await interaction.reply({
      content:
        "Sign in on aotracker.net with this Discord account first, then run `/watchlist-add` again.",
      ephemeral: true,
    });
    return;
  }

  const type = interaction.options.getString("type", true);
  const regionRaw = interaction.options.getString("region", true);
  const name = interaction.options.getString("name", true);
  if (!isRegion(regionRaw)) {
    await interaction.reply({ content: "Pick a valid region.", ephemeral: true });
    return;
  }

  let entity: { albionId: string; name: string } | null = null;
  if (type === "player") {
    const player =
      (await getPlayerByAlbionId(regionRaw, name)) ??
      (await getPlayerByName(regionRaw, name));
    if (player) entity = { albionId: player.albionId, name: player.name };
  } else if (type === "guild") {
    const guild =
      (await getGuildByAlbionId(regionRaw, name)) ??
      (await getGuildByName(regionRaw, name));
    if (guild) entity = { albionId: guild.albionId, name: guild.name };
  } else if (type === "alliance") {
    const alliance =
      (await getAllianceByAlbionId(regionRaw, name)) ??
      (await getAllianceByName(regionRaw, name));
    if (alliance) entity = { albionId: alliance.albionId, name: alliance.name };
  }

  if (!entity || (type !== "player" && type !== "guild" && type !== "alliance")) {
    await interaction.reply({
      content:
        "That entity is not in AOTracker yet. Open it on aotracker.net first.",
      ephemeral: true,
    });
    return;
  }

  const result = await addWatchlistEntry({
    userId,
    type,
    region: regionRaw,
    albionId: entity.albionId,
    name: entity.name,
  });
  await interaction.reply({
    content:
      result === "added"
        ? `Added **${entity.name}** to your AOTracker watchlist.`
        : `**${entity.name}** is already on your watchlist.`,
    ephemeral: true,
  });
}
