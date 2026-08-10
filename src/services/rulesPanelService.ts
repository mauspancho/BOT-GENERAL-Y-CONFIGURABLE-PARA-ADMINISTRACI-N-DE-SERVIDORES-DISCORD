import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type Client,
} from "discord.js";
import type { ServerConfig } from "../core/config/schema.js";
import type { PersistentMessageRepository } from "../repositories/persistentMessageRepository.js";
import { hashRules, loadRulesFile, splitDiscordText } from "./rulesContentService.js";

export const RULES_ACCEPT_CUSTOM_ID = "rules:v1:accept";
export const RULES_REJECT_CUSTOM_ID = "rules:v1:reject";
export const RULES_PANEL_TYPE = "rules";

export async function ensureRulesPanel(
  client: Client,
  config: ServerConfig,
  repository: PersistentMessageRepository,
): Promise<void> {
  if (!config.modules.rules || !config.rules.enabled) {
    return;
  }

  const rulesChannelId = config.channels.rules?.id;
  if (!rulesChannelId) {
    return;
  }

  const channel = await client.channels.fetch(rulesChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error(`El canal de reglas ${rulesChannelId} no existe o no es de texto.`);
  }

  const rulesContent = loadRulesFile(config.rules.sourcePath);
  const contentHash = hashRules(rulesContent);
  const existing = repository.find(config.guildId, RULES_PANEL_TYPE);

  const payload = buildRulesPanelPayload(config, rulesContent);

  if (existing && existing.channelId === rulesChannelId) {
    const message = await channel.messages.fetch(existing.messageId).catch(() => null);
    if (message) {
      if (existing.contentHash !== contentHash || existing.version !== config.rules.version) {
        await message.edit(payload);
        repository.upsert({
          guildId: config.guildId,
          channelId: rulesChannelId,
          messageId: message.id,
          panelType: RULES_PANEL_TYPE,
          version: config.rules.version,
          contentHash,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }
  }

  const sent = await channel.send(payload);
  repository.upsert({
    guildId: config.guildId,
    channelId: rulesChannelId,
    messageId: sent.id,
    panelType: RULES_PANEL_TYPE,
    version: config.rules.version,
    contentHash,
    updatedAt: new Date().toISOString(),
  });
}

function buildRulesPanelPayload(config: ServerConfig, rulesContent: string) {
  const chunks = splitDiscordText(rulesContent);
  const embeds = chunks.map((chunk, index) =>
    new EmbedBuilder()
      .setTitle(index === 0 ? `Reglas de ${config.communityName}` : `Reglas (${index + 1})`)
      .setDescription(chunk)
      .setFooter({ text: `Version ${config.rules.version}` }),
  );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(RULES_ACCEPT_CUSTOM_ID)
      .setLabel("Aceptar")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(RULES_REJECT_CUSTOM_ID)
      .setLabel("Rechazar")
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds, components: [row] };
}
