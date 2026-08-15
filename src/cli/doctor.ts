import fs from "node:fs";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { Events } from "discord.js";
import { loadEnv } from "../core/config/env.js";
import { getConfigPath, getDatabasePath } from "../core/config/paths.js";
import { readServerConfig } from "../core/config/configStore.js";
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
  configPath: getConfigPath(),
  databasePath: getDatabasePath(),
};

try {
  const env = loadEnv();
  const config = readServerConfig(getConfigPath());
  diagnostic.configVersion = config.version;
  diagnostic.guildId = config.guildId;
  diagnostic.communityName = config.communityName;
  diagnostic.modules = config.modules;
  if (config.modules.tiktokAlerts) {
    diagnostic.tiktok = {
      credentials: hasTikTokCredentials() ? "configurado" : "incompleto",
      clientSecret: process.env.TIKTOK_CLIENT_SECRET ? "configurado" : "no configurado",
      redirectUri: process.env.TIKTOK_REDIRECT_URI ?? "default",
      callback: `${process.env.TIKTOK_CALLBACK_HOST ?? "127.0.0.1"}:${process.env.TIKTOK_CALLBACK_PORT ?? "8787"}`,
    };
  }
  diagnostic.rulesVersion = config.rules.version;

  const database = await openDatabase(getDatabasePath());
  diagnostic.database = "ok";
  database.close();

  const client = createDiscordClient();
  await client.login(env.DISCORD_TOKEN);
  if (!client.isReady()) {
    await once(client, Events.ClientReady);
  }
  const guild = await client.guilds.fetch(config.guildId);
  diagnostic.discordConnectivity = "ok";
  diagnostic.guildAccessible = guild.name;
  diagnostic.missingPermissions = (await validateBotPermissions(guild, config)).map(
    (permission) => permission.name,
  );
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
