import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "./commandTypes.js";
import { requireManageGuild } from "../core/permissions/guards.js";
import { PersistentMessageRepository } from "../repositories/persistentMessageRepository.js";
import { ensureTheIslePanel } from "../modules/theIsleGuide/theIslePanelService.js";
import { getRulesPath } from "../core/config/paths.js";
import { loadTheIsleGuideFile } from "../modules/theIsleGuide/theIsleParser.js";

export const guideCommand: SlashCommand = {
  name: "guide",
  enabled: (config) => config.modules.theIsleGuide,
  data: () =>
    new SlashCommandBuilder()
      .setName("guide")
      .setDescription("Administra guias opcionales.")
      .addSubcommand((subcommand) =>
        subcommand.setName("reload").setDescription("Recarga el panel de The Isle desde Markdown."),
      )
      .toJSON(),
  async execute(interaction, context) {
    if (!(await requireManageGuild(interaction))) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    loadTheIsleGuideFile(getRulesPath("./data/the-isle/dinosaurs.md"));
    await ensureTheIslePanel(
      interaction.client,
      context.config,
      new PersistentMessageRepository(context.database),
    );
    await interaction.editReply("Guia The Isle recargada desde data/the-isle/dinosaurs.md.");
  },
};
