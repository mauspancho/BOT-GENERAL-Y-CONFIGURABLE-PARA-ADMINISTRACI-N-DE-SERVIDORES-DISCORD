import type { ChatInputCommandInteraction } from "discord.js";
import type { ServerConfig } from "../core/config/schema.js";
import type { Database } from "../core/database/sqlite.js";
import { botStatusCommand } from "./botStatus.js";
import { configStatusCommand } from "./configStatus.js";
import { rulesCommand } from "./rules.js";
import type { SlashCommand } from "./commandTypes.js";

export const allCommands: SlashCommand[] = [botStatusCommand, configStatusCommand, rulesCommand];

export function enabledCommands(config: ServerConfig): SlashCommand[] {
  return allCommands.filter((command) => command.enabled(config));
}

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  config: ServerConfig,
  database: Database,
): Promise<void> {
  const command = enabledCommands(config).find((candidate) => candidate.name === interaction.commandName);
  if (!command) {
    await interaction.reply({ content: "Comando no disponible en esta instalacion.", ephemeral: true });
    return;
  }

  await command.execute(interaction, { config, database });
}
