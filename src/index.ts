import { Events } from "discord.js";
import { loadEnv } from "./core/config/env.js";
import { getConfigPath, getDatabasePath } from "./core/config/paths.js";
import { readServerConfig } from "./core/config/configStore.js";
import { openDatabase } from "./core/database/sqlite.js";
import { createDiscordClient } from "./core/discord/client.js";
import { createLogger } from "./core/logger/logger.js";
import { handleGuildMemberAdd } from "./events/guildMemberAdd.js";
import { handleInteractionCreate } from "./events/interactionCreate.js";
import { enabledModules } from "./modules/index.js";
import { registerGuildCommands } from "./commands/register.js";

const logger = createLogger();
const env = loadEnv();
const config = readServerConfig(getConfigPath());
const database = await openDatabase(getDatabasePath());
const client = createDiscordClient();

client.once(Events.ClientReady, () => {
  void (async () => {
    logger.info({ bot: client.user?.tag, guildId: config.guildId }, "Discord connection ready");
    await registerGuildCommands(env.DISCORD_TOKEN, env.DISCORD_CLIENT_ID, config);

    for (const module of enabledModules(config)) {
      await module.start({ client, config, database, logger });
    }
  })().catch((error: unknown) => {
    logger.error({ error }, "clientReady handler failed");
  });
});

client.on("guildMemberAdd", (member) => {
  void handleGuildMemberAdd(member, config).catch((error: unknown) => {
    logger.error({ error }, "guildMemberAdd handler failed");
  });
});

client.on("interactionCreate", (interaction) => {
  void handleInteractionCreate(interaction, config, database).catch((error: unknown) => {
    logger.error({ error }, "interactionCreate handler failed");
  });
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "Shutting down");
  await client.destroy();
  database.close();
}

process.on("SIGINT", (signal) => {
  void shutdown(signal).then(() => process.exit(0));
});

process.on("SIGTERM", (signal) => {
  void shutdown(signal).then(() => process.exit(0));
});

await client.login(env.DISCORD_TOKEN);
