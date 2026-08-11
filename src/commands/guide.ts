import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "./commandTypes.js";
import { requireManageGuild } from "../core/permissions/guards.js";
import { PersistentMessageRepository } from "../repositories/persistentMessageRepository.js";
import { ensureTheIslePanel } from "../modules/theIsleGuide/theIslePanelService.js";
import {
  getTheIsleGuideSourcePath,
  isTheIsleGuideEnabled,
  loadConfiguredTheIsleGuideFile,
  resolveTheIsleGuidePath,
} from "../modules/theIsleGuide/theIsleGuideConfig.js";

export const guideCommand: SlashCommand = {
  name: "guide",
  enabled: (config) => isTheIsleGuideEnabled(config),
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
    const sourcePath = getTheIsleGuideSourcePath(context.config);
    const resolvedPath = resolveTheIsleGuidePath(context.config);

    try {
      const data = loadConfiguredTheIsleGuideFile(context.config);
      await ensureTheIslePanel(
        interaction.client,
        context.config,
        new PersistentMessageRepository(context.database),
      );
      await interaction.editReply(
        [
          "Guia The Isle recargada correctamente.",
          "",
          `Archivo: ${sourcePath}`,
          `Ruta resuelta: ${resolvedPath}`,
          `Version: ${data.gameVersion}`,
          `Especies activas: ${data.species.filter((species) => species.enabled).length}`,
        ].join("\n"),
      );
    } catch (error) {
      await interaction.editReply(
        [
          "No se pudo recargar la guia.",
          "",
          `Archivo: ${sourcePath}`,
          `Ruta resuelta: ${resolvedPath}`,
          `Error: ${error instanceof Error ? error.message : "Error desconocido."}`,
        ].join("\n"),
      );
    }
  },
};
