import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "./commandTypes.js";
import type { ServerConfig } from "../core/config/schema.js";
import { requireAdministrator } from "../core/permissions/guards.js";
import { TikTokRepository } from "../repositories/tiktokRepository.js";
import { TikTokApiClient } from "../modules/tiktokAlerts/tiktokApiClient.js";
import {
  createTikTokAuthorization,
  sendTikTokTestAlert,
} from "../modules/tiktokAlerts/tiktokAlertService.js";
import { loadTikTokRuntimeConfig } from "../modules/tiktokAlerts/tiktokEnv.js";

export const TIKTOK_DISCONNECT_CONFIRM_PREFIX = "tiktok:disconnect:confirm:";
export const TIKTOK_DISCONNECT_CANCEL_PREFIX = "tiktok:disconnect:cancel:";

export const tiktokCommand: SlashCommand = {
  name: "tiktok",
  enabled: (config) => config.modules.tiktokAlerts,
  data: () =>
    new SlashCommandBuilder()
      .setName("tiktok")
      .setDescription("Administra alertas automaticas de TikTok.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .setDMPermission(false)
      .addSubcommand((subcommand) => subcommand.setName("conectar").setDescription("Conecta una cuenta TikTok."))
      .addSubcommand((subcommand) => subcommand.setName("estado").setDescription("Muestra el estado de TikTok."))
      .addSubcommand((subcommand) => subcommand.setName("activar").setDescription("Activa el monitoreo TikTok."))
      .addSubcommand((subcommand) => subcommand.setName("desactivar").setDescription("Desactiva el monitoreo TikTok."))
      .addSubcommand((subcommand) => subcommand.setName("desconectar").setDescription("Desconecta la cuenta TikTok."))
      .addSubcommand((subcommand) => subcommand.setName("prueba").setDescription("Publica una alerta de prueba TikTok."))
      .toJSON(),
  async execute(interaction, context) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "Este comando solo funciona dentro del servidor.", ephemeral: true });
      return;
    }
    if (!(await requireAdministrator(interaction))) {
      return;
    }

    const repository = new TikTokRepository(context.database);
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === "estado") {
        const connection = repository.findConnection(context.config.guildId);
        await interaction.reply({
          content: formatTikTokStatus(context.config, connection),
          ephemeral: true,
        });
        return;
      }

      const runtime = loadTikTokRuntimeConfig();
      const api = new TikTokApiClient(runtime);

      if (subcommand === "conectar") {
        if (repository.findConnection(context.config.guildId)) {
          await interaction.reply({
            content: "Ya hay una cuenta TikTok conectada. Usa /tiktok desconectar antes de conectar otra.",
            ephemeral: true,
          });
          return;
        }

        const authorization = createTikTokAuthorization(repository, api, {
          guildId: context.config.guildId,
          discordUserId: interaction.user.id,
        });
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel("Conectar cuenta TikTok")
            .setStyle(ButtonStyle.Link)
            .setURL(authorization.url),
        );
        await interaction.reply({
          content: "Abre el enlace privado para autorizar la cuenta TikTok. Expira en 10 minutos.",
          components: [row],
          ephemeral: true,
        });
        return;
      }

      if (subcommand === "activar") {
        if (!repository.findConnection(context.config.guildId)) {
          await interaction.reply({ content: "No hay una cuenta TikTok conectada.", ephemeral: true });
          return;
        }
        repository.setConnectionEnabled(context.config.guildId, true);
        await interaction.reply({ content: "Monitoreo TikTok activado.", ephemeral: true });
        return;
      }

      if (subcommand === "desactivar") {
        if (!repository.findConnection(context.config.guildId)) {
          await interaction.reply({ content: "No hay una cuenta TikTok conectada.", ephemeral: true });
          return;
        }
        repository.setConnectionEnabled(context.config.guildId, false);
        await interaction.reply({ content: "Monitoreo TikTok desactivado. La cuenta sigue conectada.", ephemeral: true });
        return;
      }

      if (subcommand === "desconectar") {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${TIKTOK_DISCONNECT_CONFIRM_PREFIX}${interaction.user.id}`)
            .setLabel("Desconectar")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`${TIKTOK_DISCONNECT_CANCEL_PREFIX}${interaction.user.id}`)
            .setLabel("Cancelar")
            .setStyle(ButtonStyle.Secondary),
        );
        await interaction.reply({
          content: "Confirma que deseas desconectar TikTok. Se borraran los tokens cifrados.",
          components: [row],
          ephemeral: true,
        });
        return;
      }

      if (subcommand === "prueba") {
        const video = await sendTikTokTestAlert(interaction.client, context.config, repository, api, runtime);
        await interaction.reply({
          content: video ? `Alerta de prueba enviada para video ${video.id}.` : "La cuenta no tiene videos publicos.",
          ephemeral: true,
        });
      }
    } catch (error) {
      await interaction.reply({
        content: error instanceof Error ? error.message : "TikTok no disponible.",
        ephemeral: true,
      });
    }
  },
};

function formatTikTokStatus(
  config: ServerConfig,
  connection: ReturnType<TikTokRepository["findConnection"]>,
): string {
  return [
    "TikTok Alerts",
    `Modulo: ${config.modules.tiktokAlerts ? "activo" : "inactivo"}`,
    `Cuenta conectada: ${connection ? "si" : "no"}`,
    ...(connection
      ? [
          `Cuenta: ${connection.displayName}`,
          `Open ID: ${maskOpenId(connection.openId)}`,
          `Monitoreo: ${connection.enabled ? "activo" : "inactivo"}`,
          `Ultima comprobacion: ${connection.lastCheckAt ?? "nunca"}`,
          `Ultimo exito: ${connection.lastSuccessAt ?? "nunca"}`,
          `Ultimo video detectado: ${connection.lastVideoId ?? "ninguno"}`,
          `Estado del token: ${new Date(connection.refreshTokenExpiresAt).getTime() > Date.now() ? "renovable" : "expirado"}`,
        ]
      : []),
    `Destino: #${config.channels.general?.name ?? "general"}`,
    `Polling: ${Math.round(config.tiktokAlerts.pollingIntervalSeconds / 60)} minutos`,
    `Mencion configurada: ${config.tiktokAlerts.mention}`,
  ].join("\n");
}

function maskOpenId(openId: string): string {
  if (openId.length <= 8) {
    return "********";
  }
  return `${openId.slice(0, 4)}...${openId.slice(-4)}`;
}
