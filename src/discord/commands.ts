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
  getGuildByAlbionId,
  getGuildByName,
  listFeedsForServer,
  searchGuildsForAutocomplete,
  setFeedChannel,
  trackGuildFeeds,
  untrackGuildFeeds,
  upsertDiscordServer,
} from "./db";
import { FEED_GUILD_DEATHS, FEED_GUILD_KILLS } from "./types";
import { regionLabel } from "./format";

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
    .setDescription("Follow an Albion guild's kills and deaths in this server")
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
    .setName("untrack")
    .setDescription("Stop posting kills and deaths in this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  guildCommand()
    .setName("status")
    .setDescription("Show AOTracker Discord feed settings for this server"),
];

export async function handleAutocomplete(
  interaction: AutocompleteInteraction
): Promise<void> {
  if (interaction.commandName !== "track") {
    await interaction.respond([]);
    return;
  }
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "guild") {
    await interaction.respond([]);
    return;
  }
  const regionRaw = interaction.options.getString("region");
  const region = isRegion(regionRaw) ? regionRaw : undefined;
  const rows = await searchGuildsForAutocomplete(focused.value, region);
  await interaction.respond(
    rows.slice(0, 25).map((row) => ({
      name: region
        ? row.name.slice(0, 100)
        : `${row.name} (${regionLabel(row.region)})`.slice(0, 100),
      value: row.albionId,
    }))
  );
}

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
    interaction.commandName !== "status" &&
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
    case "untrack":
      await handleUntrack(interaction);
      return;
    case "status":
      await handleStatus(interaction);
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
      ? `Now tracking **${guild.name}** (${regionLabel(regionRaw)}). Previous guild tracking was replaced. Set channels with \`/kills-channel\` and \`/deaths-channel\`.`
      : `Tracking **${guild.name}** (${regionLabel(regionRaw)}). Set channels with \`/kills-channel\` and \`/deaths-channel\`.`,
    ephemeral: true,
  });
}

async function handleChannel(
  interaction: ChatInputCommandInteraction,
  feedType: typeof FEED_GUILD_KILLS | typeof FEED_GUILD_DEATHS,
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
        ? "Stopped tracking. Channels will no longer receive kill/death posts."
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
  if (!kills && !deaths) {
    await interaction.reply({
      content: "No Albion guild is tracked. Use `/track` to start.",
      ephemeral: true,
    });
    return;
  }
  const target = kills ?? deaths;
  const lines = [
    `**Guild:** ${target?.targetName ?? "?"} (${regionLabel(target?.region ?? "americas")})`,
    `**Kills:** ${kills?.channelId ? `<#${kills.channelId}>` : "not set"}`,
    `**Deaths:** ${deaths?.channelId ? `<#${deaths.channelId}>` : "not set"}`,
  ];
  await interaction.reply({ content: lines.join("\n"), ephemeral: true });
}
