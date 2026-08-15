import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";
import {
  discordBotToken,
  discordClientId,
  discordDevGuildId,
  isDiscordEnabled,
  isDiscordSnowflake,
} from "./enabled";
import {
  handleAutocomplete,
  handleChatCommand,
  slashCommandBuilders,
} from "./commands";
import { upsertDiscordServer } from "./db";
import { recordOpsEvent } from "@aotracker/core/ops/events";
import {
  recordDiscordBotError,
  recordDiscordBotHeartbeat,
} from "@aotracker/core/jobs/worker-state";

const HEARTBEAT_MS = 30_000;

function heartbeatPayload(client: Client): Record<string, unknown> {
  return {
    tag: client.user?.tag ?? null,
    userId: client.user?.id ?? null,
    guilds: client.guilds.cache.size,
    ping: client.ws.ping,
    wsStatus: client.ws.status,
  };
}

function startHeartbeat(client: Client): NodeJS.Timeout {
  const beat = () => {
    if (!client.isReady() || !client.user) return;
    void recordDiscordBotHeartbeat(heartbeatPayload(client)).catch((err) => {
      console.warn(
        "[discord] heartbeat failed:",
        err instanceof Error ? err.message : err
      );
    });
  };
  beat();
  return setInterval(beat, HEARTBEAT_MS);
}

function commandBody() {
  return slashCommandBuilders.map((cmd) => cmd.toJSON());
}

async function putGuildCommands(
  rest: REST,
  clientId: string,
  guildId: string
): Promise<void> {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commandBody(),
  });
  console.log(`[discord] Registered slash commands for guild ${guildId}`);
}

async function registerGlobalCommands(
  rest: REST,
  clientId: string
): Promise<void> {
  await rest.put(Routes.applicationCommands(clientId), {
    body: commandBody(),
  });
  console.log("[discord] Registered global slash commands");
}

async function registerCommandsForGuilds(
  token: string,
  clientId: string,
  guildIds: string[]
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);

  try {
    await registerGlobalCommands(rest, clientId);
  } catch (err) {
    console.error(
      "[discord] Global command registration failed:",
      err instanceof Error ? err.message : err
    );
  }

  const ids = new Set(guildIds.filter(isDiscordSnowflake));
  const devGuildId = discordDevGuildId();
  if (devGuildId) {
    if (isDiscordSnowflake(devGuildId)) {
      ids.add(devGuildId);
    } else {
      console.warn(
        `[discord] DISCORD_DEV_GUILD_ID="${devGuildId}" is not a Discord server ID. Enable Developer Mode, right-click the server name, Copy Server ID (17–20 digits).`
      );
    }
  }

  for (const guildId of ids) {
    try {
      await putGuildCommands(rest, clientId, guildId);
    } catch (err) {
      console.error(
        `[discord] Command registration failed for guild ${guildId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

export async function startDiscordBot(): Promise<Client> {
  if (!isDiscordEnabled()) {
    console.log("[discord] DISCORD_ENABLED is not 1 — bot will not log in");
    process.exit(0);
  }

  const token = discordBotToken();
  const clientId = discordClientId();
  if (!token || !clientId) {
    throw new Error("DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required");
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, (ready) => {
    console.log(
      `[discord] Logged in as ${ready.user.tag} (${ready.guilds.cache.size} server(s))`
    );
    startHeartbeat(ready);
    const guildIds = [...ready.guilds.cache.keys()];
    void registerCommandsForGuilds(token, clientId, guildIds).catch((err) => {
      console.error("[discord] Command registration failed:", err);
    });
  });

  client.on(Events.Error, (err) => {
    void recordDiscordBotError(err.message).catch(() => undefined);
  });

  client.on(Events.ShardDisconnect, (_event, shardId) => {
    void recordDiscordBotError(
      `Discord shard ${shardId} disconnected`
    ).catch(() => undefined);
  });

  client.on(Events.GuildCreate, (guild) => {
    console.log(`[discord] Joined ${guild.name} (${guild.id})`);
    void upsertDiscordServer(guild.id, guild.name).catch((err) => {
      console.warn("[discord] guildCreate upsert failed:", err);
    });
    const rest = new REST({ version: "10" }).setToken(token);
    void putGuildCommands(rest, clientId, guild.id).catch((err) => {
      console.error(
        `[discord] Command registration failed for joined guild ${guild.id}:`,
        err instanceof Error ? err.message : err
      );
    });
  });

  client.on(Events.GuildDelete, (guild) => {
    void upsertDiscordServer(guild.id, guild.name, true).catch((err) => {
      console.warn("[discord] guildDelete upsert failed:", err);
    });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction);
        return;
      }
      if (interaction.isChatInputCommand()) {
        await handleChatCommand(interaction);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[discord] interaction failed:", message);
      void recordOpsEvent({
        source: "discord",
        severity: "error",
        category: "command",
        message,
      });
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction
          .reply({
            content: "Something went wrong running that command.",
            ephemeral: true,
          })
          .catch(() => undefined);
      }
    }
  });

  await client.login(token);
  return client;
}
