import { Events } from "discord.js";
import { loadEnv } from "./core/config/env.js";
import { GuildConfigManager } from "./core/config/guildConfigManager.js";
import { getDatabasePath } from "./core/config/paths.js";
import { openDatabase } from "./core/database/sqlite.js";
import { createDiscordClient } from "./core/discord/client.js";
import { createLogger } from "./core/logger/logger.js";
import { handleGuildMemberAdd } from "./events/guildMemberAdd.js";
import { handleInteractionCreate } from "./events/interactionCreate.js";
import { enabledModules } from "./modules/index.js";
import { TikTokMultiGuildRuntime } from "./modules/tiktokAlerts/tiktokAlertsModule.js";
import { handleTikTokPendingDmButton, isTikTokPendingButton } from "./modules/tiktokAlerts/tiktokInteractionService.js";
import type { BotModule, BotModuleContext } from "./types/BotModule.js";
import { registerGuildCommands } from "./commands/register.js";

const logger = createLogger();
const env = loadEnv();
const configManager = new GuildConfigManager();
configManager.migrateLegacyConfig();
const database = await openDatabase(getDatabasePath());
const client = createDiscordClient();
const startedModules: Array<{ module: BotModule; context: BotModuleContext }> = [];
let tiktokRuntime: TikTokMultiGuildRuntime | undefined;

client.once(Events.ClientReady, () => {
  void (async () => {
    const configs = configManager.list();
    logger.info({ bot: client.user?.tag, guilds: configs.map((config) => config.guildId) }, "Discord connection ready");

    for (const config of configs) {
      await registerGuildCommands(env.DISCORD_TOKEN, env.DISCORD_CLIENT_ID, config);
      const context = { client, config, database, logger };
      for (const module of enabledModules(config)) {
        await module.start(context);
        startedModules.push({ module, context });
      }
    }

    if (configs.some((config) => config.modules.tiktokAlerts)) {
      tiktokRuntime = new TikTokMultiGuildRuntime(client, configManager, database, logger);
      await tiktokRuntime.start();
    }
  })().catch((error: unknown) => {
    logger.error({ error }, "clientReady handler failed");
  });
});

client.on("guildMemberAdd", (member) => {
  const config = configManager.find(member.guild.id);
  if (!config) {
    return;
  }

  void handleGuildMemberAdd(member, config).catch((error: unknown) => {
    logger.error({ error, guildId: member.guild.id }, "guildMemberAdd handler failed");
  });
});

client.on("interactionCreate", (interaction) => {
  if (interaction.isButton() && isTikTokPendingButton(interaction.customId)) {
    void handleTikTokPendingDmButton(interaction, configManager, database).catch((error: unknown) => {
      logger.error({ error, userId: interaction.user.id }, "TikTok pending DM button failed");
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        void interaction.reply({ content: error instanceof Error ? error.message : "No se pudo procesar TikTok.", ephemeral: true });
      }
    });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    if (interaction.isRepliable()) {
      void interaction.reply({ content: "Este comando solo funciona dentro de un servidor.", ephemeral: true });
    }
    return;
  }

  const config = configManager.find(guildId);
  if (!config) {
    if (interaction.isRepliable()) {
      void interaction.reply({ content: "Este servidor todavia no esta configurado.", ephemeral: true });
    }
    return;
  }

  void handleInteractionCreate(interaction, config, database).catch((error: unknown) => {
    logger.error({ error, guildId }, "interactionCreate handler failed");
  });
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "Shutting down");
  await tiktokRuntime?.stop();
  for (const item of [...startedModules].reverse()) {
    await item.module.stop?.(item.context);
  }
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
