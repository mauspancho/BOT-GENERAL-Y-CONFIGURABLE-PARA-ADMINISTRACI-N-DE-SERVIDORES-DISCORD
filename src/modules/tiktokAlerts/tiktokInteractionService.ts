import type { ButtonInteraction } from "discord.js";
import type { ServerConfig } from "../../core/config/schema.js";
import type { Database } from "../../core/database/sqlite.js";
import { requireAdministrator } from "../../core/permissions/guards.js";
import { TikTokRepository } from "../../repositories/tiktokRepository.js";
import {
  TIKTOK_DISCONNECT_CANCEL_PREFIX,
  TIKTOK_DISCONNECT_CONFIRM_PREFIX,
} from "../../commands/tiktok.js";
import { TikTokApiClient } from "./tiktokApiClient.js";
import { disconnectTikTok } from "./tiktokAlertService.js";
import { loadTikTokRuntimeConfig } from "./tiktokEnv.js";

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

  const expectedUserId = interaction.customId.split(":").at(-1);
  if (expectedUserId !== interaction.user.id) {
    await interaction.reply({ content: "Solo quien inicio la operacion puede confirmarla.", ephemeral: true });
    return true;
  }

  if (interaction.customId.startsWith(TIKTOK_DISCONNECT_CANCEL_PREFIX)) {
    await interaction.update({ content: "Desconexion TikTok cancelada.", components: [] });
    return true;
  }

  const runtime = loadTikTokRuntimeConfig();
  const repository = new TikTokRepository(database);
  await disconnectTikTok(repository, new TikTokApiClient(runtime), runtime, config.guildId);
  await interaction.update({ content: "TikTok desconectado correctamente.", components: [] });
  return true;
}
