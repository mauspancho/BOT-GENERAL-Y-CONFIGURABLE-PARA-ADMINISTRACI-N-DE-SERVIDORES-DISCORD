import fs from "node:fs";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { Events } from "discord.js";
import { loadEnv } from "../core/config/env.js";
import { GuildConfigManager } from "../core/config/guildConfigManager.js";
import { getDatabasePath, getGuildConfigsDir } from "../core/config/paths.js";
import { openDatabase } from "../core/database/sqlite.js";
import { createDiscordClient } from "../core/discord/client.js";
import { validateBotPermissions } from "../installer/discord/setupDiscord.js";
import { hasTikTokCredentials } from "../modules/tiktokAlerts/tiktokEnv.js";

const args = parseArgs({
  options: {
    output: { type: "string" },
  },
  allowPositionals: true,
});

const diagnostic: Record<string, unknown> = {
  nodeVersion: process.version,
  botVersion: "0.1.0",
  guildConfigsDir: getGuildConfigsDir(),
  databasePath: getDatabasePath(),
};

try {
  const env = loadEnv();
  const configManager = new GuildConfigManager();
  configManager.migrateLegacyConfig();
  const configs = configManager.list();
  diagnostic.guilds = configs.map((config) => ({
    guildId: config.guildId,
    communityName: config.communityName,
    configVersion: config.version,
    modules: config.modules,
    rulesVersion: config.rules.version,
  }));
  if (configs.some((config) => config.modules.tiktokAlerts)) {
    diagnostic.tiktok = {
      credentials: hasTikTokCredentials() ? "configurado" : "incompleto",
      clientSecret: process.env.TIKTOK_CLIENT_SECRET ? "configurado" : "no configurado",
      redirectUri: process.env.TIKTOK_REDIRECT_URI ?? "default",
      callback: `${process.env.TIKTOK_CALLBACK_HOST ?? "127.0.0.1"}:${process.env.TIKTOK_CALLBACK_PORT ?? "8787"}`,
    };
  }

  const database = await openDatabase(getDatabasePath());
  diagnostic.database = "ok";
  database.close();

  const client = createDiscordClient();
  await client.login(env.DISCORD_TOKEN);
  if (!client.isReady()) {
    await once(client, Events.ClientReady);
  }
  diagnostic.discordConnectivity = "ok";
  const guildAccessible: string[] = [];
  const missingPermissions: Record<string, string[]> = {};
  for (const config of configs) {
    const guild = await client.guilds.fetch(config.guildId);
    guildAccessible.push(guild.name);
    missingPermissions[config.guildId] = (await validateBotPermissions(guild, config)).map(
      (permission) => permission.name,
    );
  }
  diagnostic.guildAccessible = guildAccessible;
  diagnostic.missingPermissions = missingPermissions;
  await client.destroy();
} catch (error) {
  diagnostic.error = error instanceof Error ? error.message : "Error desconocido.";
}

const output = `${JSON.stringify(diagnostic, null, 2)}\n`;
if (args.values.output) {
  fs.writeFileSync(args.values.output, output, "utf8");
  console.log(`Diagnostico escrito en ${args.values.output}`);
} else {
  console.log(output);
}
