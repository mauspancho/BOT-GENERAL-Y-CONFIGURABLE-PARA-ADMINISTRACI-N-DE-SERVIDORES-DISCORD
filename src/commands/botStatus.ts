import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "./commandTypes.js";

export const botStatusCommand: SlashCommand = {
  name: "bot-status",
  enabled: () => true,
  data: () =>
    new SlashCommandBuilder()
      .setName("bot-status")
      .setDescription("Muestra el estado basico del bot.")
      .toJSON(),
  async execute(interaction, context) {
    await interaction.reply({
      content: `Discord Community Bot 0.1.0\nServidor configurado: ${context.config.communityName}`,
      ephemeral: true,
    });
  },
};
