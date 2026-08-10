import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "./commandTypes.js";
import { PersistentMessageRepository } from "../repositories/persistentMessageRepository.js";
import { ensureRulesPanel } from "../services/rulesPanelService.js";
import { requireManageGuild } from "../core/permissions/guards.js";

export const rulesCommand: SlashCommand = {
  name: "rules",
  enabled: (config) => config.modules.rules,
  data: () =>
    new SlashCommandBuilder()
      .setName("rules")
      .setDescription("Publica o actualiza el panel persistente de reglas.")
      .toJSON(),
  async execute(interaction, context) {
    if (!(await requireManageGuild(interaction))) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const repository = new PersistentMessageRepository(context.database);
    await ensureRulesPanel(interaction.client, context.config, repository);
    await interaction.editReply("Panel de reglas validado.");
  },
};
