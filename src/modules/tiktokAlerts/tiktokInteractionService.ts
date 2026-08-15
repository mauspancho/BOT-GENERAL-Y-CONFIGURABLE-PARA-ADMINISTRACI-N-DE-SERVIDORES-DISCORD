import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";
import type { ServerConfig } from "../../core/config/schema.js";
import type { Database } from "../../core/database/sqlite.js";
import type { GuildConfigManager } from "../../core/config/guildConfigManager.js";
import { requireAdministrator, requireGuildAdministratorForUser } from "../../core/permissions/guards.js";
import { TikTokRepository } from "../../repositories/tiktokRepository.js";
import {
  TIKTOK_CONNECT_CANCEL_PREFIX,
  TIKTOK_CONNECT_CONFIRM_PREFIX,
  TIKTOK_DISCONNECT_CANCEL_PREFIX,
  TIKTOK_DISCONNECT_CONFIRM_PREFIX,
  TIKTOK_REPUBLISH_SELECT_PREFIX,
} from "./tiktokCustomIds.js";
import { TikTokApiClient } from "./tiktokApiClient.js";
import {
  cancelTikTokPendingConnection,
  confirmTikTokPendingConnection,
  disconnectTikTok,
  republishTikTokVideo,
} from "./tiktokAlertService.js";
import { loadTikTokRuntimeConfig } from "./tiktokEnv.js";
import type { TikTokRuntimeConfig } from "./tiktokTypes.js";
import { deleteTikTokRepublishSession, getTikTokRepublishSession } from "./tiktokRepublishState.js";

export function isTikTokPendingButton(customId: string): boolean {
  return customId.startsWith(TIKTOK_CONNECT_CONFIRM_PREFIX) || customId.startsWith(TIKTOK_CONNECT_CANCEL_PREFIX);
}

export async function handleTikTokPendingDmButton(
  interaction: ButtonInteraction,
  configManager: Pick<GuildConfigManager, "get">,
  database: Database,
  dependencies?: { runtime?: TikTokRuntimeConfig; api?: TikTokApiClient },
): Promise<boolean> {
  if (!isTikTokPendingButton(interaction.customId)) {
    return false;
  }

  const state = pendingStateFromCustomId(interaction.customId);
  const repository = new TikTokRepository(database);
  const pending = repository.findPendingConnection(state);
  if (!pending) {
    await interaction.reply({ content: "La confirmacion TikTok ya no existe o expiro.", ephemeral: true });
    return true;
  }

  const config = configManager.get(pending.guildId);
  if (!config.modules.tiktokAlerts) {
    await interaction.reply({ content: "TikTok Alerts ya no esta habilitado en ese servidor.", ephemeral: true });
    return true;
  }

  if (pending.discordUserId !== interaction.user.id) {
    await interaction.reply({ content: "Solo quien inicio la conexion puede confirmarla.", ephemeral: true });
    return true;
  }

  if (!(await requireGuildAdministratorForUser(interaction.client, pending.guildId, interaction.user.id))) {
    await interaction.reply({ content: "Ya no tienes permiso de Administrador en ese servidor.", ephemeral: true });
    return true;
  }

  const runtime = dependencies?.runtime ?? loadTikTokRuntimeConfig();
  const api = dependencies?.api ?? new TikTokApiClient(runtime);

  if (interaction.customId.startsWith(TIKTOK_CONNECT_CONFIRM_PREFIX)) {
    const connection = await confirmTikTokPendingConnection(repository, api, runtime, {
      state,
      guildId: pending.guildId,
      discordUserId: interaction.user.id,
    });
    await interaction.update({ content: `TikTok conectado correctamente: ${connection.displayName}.`, components: [] });
    return true;
  }

  await cancelTikTokPendingConnection(repository, api, runtime, {
    state,
    guildId: pending.guildId,
    discordUserId: interaction.user.id,
  });
  await interaction.update({ content: "Conexion TikTok cancelada.", components: [] });
  return true;
}

export async function handleTikTokButton(
  interaction: ButtonInteraction,
  config: ServerConfig,
  database: Database,
): Promise<boolean> {
  if (!config.modules.tiktokAlerts) {
    return false;
  }

  if (
    !interaction.customId.startsWith(TIKTOK_DISCONNECT_CONFIRM_PREFIX) &&
    !interaction.customId.startsWith(TIKTOK_DISCONNECT_CANCEL_PREFIX)
  ) {
    return false;
  }

  if (!(await requireAdministrator(interaction))) {
    return true;
  }

  if (interaction.customId.startsWith(TIKTOK_DISCONNECT_CANCEL_PREFIX)) {
    const expectedUserId = interaction.customId.split(":").at(-1);
    if (expectedUserId !== interaction.user.id) {
      await interaction.reply({ content: "Solo quien inicio la operacion puede confirmarla.", ephemeral: true });
      return true;
    }
    await interaction.update({ content: "Desconexion TikTok cancelada.", components: [] });
    return true;
  }

  const runtime = loadTikTokRuntimeConfig();
  const repository = new TikTokRepository(database);
  const api = new TikTokApiClient(runtime);

  const expectedUserId = interaction.customId.split(":").at(-1);
  if (expectedUserId !== interaction.user.id) {
    await interaction.reply({ content: "Solo quien inicio la operacion puede confirmarla.", ephemeral: true });
    return true;
  }

  await disconnectTikTok(repository, api, runtime, config.guildId);
  await interaction.update({ content: "TikTok desconectado correctamente.", components: [] });
  return true;
}

export async function handleTikTokRepublishSelect(
  interaction: StringSelectMenuInteraction,
  config: ServerConfig,
  database: Database,
  dependencies?: { runtime?: TikTokRuntimeConfig; api?: TikTokApiClient },
): Promise<boolean> {
  if (!interaction.customId.startsWith(TIKTOK_REPUBLISH_SELECT_PREFIX)) {
    return false;
  }
  if (!config.modules.tiktokAlerts) {
    await interaction.reply({ content: "TikTok Alerts ya no esta habilitado.", ephemeral: true });
    return true;
  }
  if (!(await requireAdministrator(interaction))) {
    return true;
  }

  const sessionId = interaction.customId.slice(TIKTOK_REPUBLISH_SELECT_PREFIX.length);
  const session = getTikTokRepublishSession(sessionId);
  if (!session) {
    await interaction.reply({ content: "La seleccion de republicacion expiro. Ejecuta /tiktok republicar otra vez.", ephemeral: true });
    return true;
  }
  if (session.guildId !== config.guildId || session.discordUserId !== interaction.user.id) {
    await interaction.reply({ content: "Esta seleccion pertenece a otro servidor o administrador.", ephemeral: true });
    return true;
  }

  const [videoId] = interaction.values;
  if (!videoId || !session.videoIds.includes(videoId)) {
    await interaction.reply({ content: "El video seleccionado no pertenece a esta sesion.", ephemeral: true });
    return true;
  }

  const repository = new TikTokRepository(database);
  const runtime = dependencies?.runtime ?? loadTikTokRuntimeConfig();
  const api = dependencies?.api ?? new TikTokApiClient(runtime);
  let video;
  try {
    video = await republishTikTokVideo(interaction.client, config, repository, api, runtime, videoId);
  } catch (error) {
    await interaction.reply({ content: safeRepublishErrorMessage(error), ephemeral: true });
    return true;
  }
  deleteTikTokRepublishSession(sessionId);
  await interaction.update({
    content: `Video republicado correctamente en #${config.channels.general?.name ?? "general"}: ${video.id}`,
    components: [],
  });
  return true;
}

function safeRepublishErrorMessage(error: unknown): string {
  if (error instanceof Error && /No hay una cuenta|ya no esta disponible/.test(error.message)) {
    return error.message;
  }
  return "No se pudo republicar el video TikTok en este momento.";
}

function pendingStateFromCustomId(customId: string): string {
  return customId.startsWith(TIKTOK_CONNECT_CONFIRM_PREFIX)
    ? customId.slice(TIKTOK_CONNECT_CONFIRM_PREFIX.length)
    : customId.slice(TIKTOK_CONNECT_CANCEL_PREFIX.length);
}
