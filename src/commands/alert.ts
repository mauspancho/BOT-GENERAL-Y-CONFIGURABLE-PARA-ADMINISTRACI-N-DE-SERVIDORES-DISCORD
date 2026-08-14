import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "./commandTypes.js";
import { requireAdministrator } from "../core/permissions/guards.js";
import {
  generalAlertMentions,
  generalAlertTypes,
  sendGeneralAlert,
  type GeneralAlertMention,
  type GeneralAlertType,
} from "../services/generalAlertService.js";

export const alertCommand: SlashCommand = {
  name: "alerta",
  enabled: (config) => config.modules.generalAlerts,
  data: () =>
    new SlashCommandBuilder()
      .setName("alerta")
      .setDescription("Envia alertas administrativas al canal general.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .setDMPermission(false)
      .addSubcommand((subcommand) =>
        subcommand
          .setName("enviar")
          .setDescription("Envia una alerta al canal general.")
          .addStringOption((option) =>
            option
              .setName("mensaje")
              .setDescription("Mensaje publico de la alerta.")
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(4096),
          )
          .addStringOption((option) =>
            option
              .setName("tipo")
              .setDescription("Tipo de alerta.")
              .setRequired(false)
              .addChoices(
                ...generalAlertTypes.map((type) => ({
                  name: type,
                  value: type,
                })),
              ),
          )
          .addStringOption((option) =>
            option
              .setName("mencion")
              .setDescription("Mencion explicita para la alerta.")
              .setRequired(false)
              .addChoices(
                ...generalAlertMentions.map((mention) => ({
                  name: mention,
                  value: mention,
                })),
              ),
          ),
      )
      .toJSON(),
  async execute(interaction, context) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "Este comando solo funciona dentro del servidor.", ephemeral: true });
      return;
    }

    if (!(await requireAdministrator(interaction))) {
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== "enviar") {
      await interaction.reply({ content: "Subcomando no disponible.", ephemeral: true });
      return;
    }

    const message = interaction.options.getString("mensaje", true);
    const type = interaction.options.getString("tipo") as GeneralAlertType | null;
    const mention = interaction.options.getString("mencion") as GeneralAlertMention | null;

    try {
      const result = await sendGeneralAlert(interaction.client, context.config, {
        message,
        ...(type ? { type } : {}),
        ...(mention ? { mention } : {}),
        source: `<@${interaction.user.id}>`,
      });

      await interaction.reply({
        content: [
          `Alerta enviada correctamente a #${result.channelName}.`,
          `Tipo: ${result.type}`,
          `Mencion: ${result.mention}`,
          `Canal destino: #${result.channelName} (${result.channelId})`,
        ].join("\n"),
        ephemeral: true,
      });
    } catch (error) {
      await interaction.reply({
        content: error instanceof Error ? error.message : "No se pudo enviar la alerta.",
        ephemeral: true,
      });
    }
  },
};
