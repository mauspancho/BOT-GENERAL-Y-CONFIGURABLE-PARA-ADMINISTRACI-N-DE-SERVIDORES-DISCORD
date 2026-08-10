import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "./commandTypes.js";
import { requireManageGuild } from "../core/permissions/guards.js";

export const configStatusCommand: SlashCommand = {
  name: "config-status",
  enabled: () => true,
  data: () =>
    new SlashCommandBuilder()
      .setName("config-status")
      .setDescription("Muestra un resumen seguro de la configuracion.")
      .toJSON(),
  async execute(interaction, context) {
    if (!(await requireManageGuild(interaction))) {
      return;
    }

    const enabledModules = Object.entries(context.config.modules)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(", ");

    await interaction.reply({
      content: [
        `Comunidad: ${context.config.communityName}`,
        `Guild ID: ${context.config.guildId}`,
        `Version config: ${context.config.version}`,
        `Version reglas: ${context.config.rules.version}`,
        `Modulos activos: ${enabledModules || "ninguno"}`,
      ].join("\n"),
      ephemeral: true,
    });
  },
};
