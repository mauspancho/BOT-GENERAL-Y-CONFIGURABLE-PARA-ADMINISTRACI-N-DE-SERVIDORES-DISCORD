import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { SlashCommand } from "./commandTypes.js";
import type { ServerConfig } from "../core/config/schema.js";
import { requireAdministrator } from "../core/permissions/guards.js";
import { TikTokRepository } from "../repositories/tiktokRepository.js";
import { TikTokApiClient } from "../modules/tiktokAlerts/tiktokApiClient.js";
import {
  createTikTokAuthorization,
  refreshTikTokConnectionIfNeeded,
  sendTikTokTestAlert,
} from "../modules/tiktokAlerts/tiktokAlertService.js";
import { loadTikTokRuntimeConfig } from "../modules/tiktokAlerts/tiktokEnv.js";
import {
  TIKTOK_DISCONNECT_CANCEL_PREFIX,
  TIKTOK_DISCONNECT_CONFIRM_PREFIX,
  TIKTOK_REPUBLISH_SELECT_PREFIX,
} from "../modules/tiktokAlerts/tiktokCustomIds.js";
import { createTikTokRepublishSession } from "../modules/tiktokAlerts/tiktokRepublishState.js";
import type { TikTokVideo } from "../modules/tiktokAlerts/tiktokTypes.js";

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
      .addSubcommand((subcommand) => subcommand.setName("republicar").setDescription("Republica manualmente un video TikTok existente."))
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
        return;
      }

      if (subcommand === "republicar") {
        const connection = repository.findConnection(context.config.guildId);
        if (!connection) {
          await interaction.reply({ content: "No hay una cuenta TikTok conectada.", ephemeral: true });
          return;
        }
        if (!context.config.modules.generalAlerts || !context.config.channels.general?.id) {
          await interaction.reply({ content: "Republicar requiere generalAlerts y un canal general configurado.", ephemeral: true });
          return;
        }

        const refreshed = await refreshTikTokConnectionIfNeeded(repository, api, runtime, connection);
        const videos = await api.listVideos(refreshed.accessToken, 20);
        if (videos.length === 0) {
          await interaction.reply({ content: "La cuenta TikTok no tiene videos disponibles.", ephemeral: true });
          return;
        }

        const session = createTikTokRepublishSession({
          guildId: context.config.guildId,
          discordUserId: interaction.user.id,
          videos,
        });
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`${TIKTOK_REPUBLISH_SELECT_PREFIX}${session.id}`)
          .setPlaceholder(`Videos de ${connection.displayName}`)
          .addOptions(videos.slice(0, 20).map(toRepublishOption));
        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
        await interaction.reply({
          content: `Selecciona el video que deseas republicar de ${connection.displayName}.`,
          components: [row],
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

function toRepublishOption(video: TikTokVideo): { label: string; description: string; value: string } {
  const text = video.title ?? video.videoDescription ?? "Video TikTok";
  const date = video.createTime ? new Date(video.createTime * 1000).toLocaleDateString("es-MX") : "sin fecha";
  return {
    label: trimDiscordOption(text, 100),
    description: trimDiscordOption(`${date} - ID ${maskVideoId(video.id)}`, 100),
    value: video.id,
  };
}

function trimDiscordOption(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function maskVideoId(videoId: string): string {
  return videoId.length <= 8 ? videoId : `${videoId.slice(0, 4)}...${videoId.slice(-4)}`;
}

function maskOpenId(openId: string): string {
  if (openId.length <= 8) {
    return "********";
  }
  return `${openId.slice(0, 4)}...${openId.slice(-4)}`;
}
