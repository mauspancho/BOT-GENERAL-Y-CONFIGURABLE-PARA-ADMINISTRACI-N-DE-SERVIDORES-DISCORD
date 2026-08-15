import { loadEnv } from "../core/config/env.js";
import { GuildConfigManager } from "../core/config/guildConfigManager.js";
import { registerGuildCommands } from "../commands/register.js";

const env = loadEnv();
const configManager = new GuildConfigManager();
configManager.migrateLegacyConfig();
const configs = configManager.list();

if (configs.length === 0) {
  throw new Error("No hay servidores configurados.");
}

for (const config of configs) {
  await registerGuildCommands(env.DISCORD_TOKEN, env.DISCORD_CLIENT_ID, config);
  console.log(`Comandos registrados para ${config.communityName} (${config.guildId}).`);
}
