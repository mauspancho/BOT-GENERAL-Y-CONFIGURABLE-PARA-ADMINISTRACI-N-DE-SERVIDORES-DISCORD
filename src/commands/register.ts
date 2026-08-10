import { REST, Routes } from "discord.js";
import type { ServerConfig } from "../core/config/schema.js";
import { enabledCommands } from "./index.js";

export async function registerGuildCommands(
  token: string,
  clientId: string,
  config: ServerConfig,
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  const body = enabledCommands(config).map((command) => command.data(config));
  await rest.put(Routes.applicationGuildCommands(clientId, config.guildId), { body });
}
