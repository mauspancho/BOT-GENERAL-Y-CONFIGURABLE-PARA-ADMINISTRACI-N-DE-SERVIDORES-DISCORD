import { ChannelType, type Client } from "discord.js";
import type { ServerConfig } from "../../core/config/schema.js";
import type { PersistentMessageRepository } from "../../repositories/persistentMessageRepository.js";
import { hashRules } from "../../services/rulesContentService.js";
import { THE_ISLE_PANEL_TYPE, buildTheIslePanelPayload } from "./theIsleUi.js";

export async function ensureTheIslePanel(
  client: Client,
  config: ServerConfig,
  repository: PersistentMessageRepository,
): Promise<void> {
  if (!config.modules.theIsleGuide) {
    return;
  }

  const channelId = config.channels.theIsleGuide?.id;
  if (!channelId) {
    return;
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error(`El canal The Isle ${channelId} no existe o no es de texto.`);
  }

  const payload = buildTheIslePanelPayload();
  const contentHash = hashRules(JSON.stringify(payload));
  const existing = repository.find(config.guildId, THE_ISLE_PANEL_TYPE);

  if (existing && existing.channelId === channelId) {
    const message = await channel.messages.fetch(existing.messageId).catch(() => null);
    if (message) {
      if (existing.contentHash !== contentHash) {
        await message.edit(payload);
      }
      repository.upsert({
        guildId: config.guildId,
        channelId,
        messageId: message.id,
        panelType: THE_ISLE_PANEL_TYPE,
        version: 1,
        contentHash,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
  }

  const sent = await channel.send(payload);
  repository.upsert({
    guildId: config.guildId,
    channelId,
    messageId: sent.id,
    panelType: THE_ISLE_PANEL_TYPE,
    version: 1,
    contentHash,
    updatedAt: new Date().toISOString(),
  });
}
