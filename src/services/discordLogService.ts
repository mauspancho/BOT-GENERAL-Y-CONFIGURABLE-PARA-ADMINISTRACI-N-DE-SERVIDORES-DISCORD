import { ChannelType, EmbedBuilder, type Client } from "discord.js";
import type { ServerConfig } from "../core/config/schema.js";

export async function sendDiscordLog(
  client: Client,
  config: ServerConfig,
  message: string,
): Promise<void> {
  if (!config.modules.logs) {
    return;
  }

  const channelId = config.channels.logs?.id;
  if (!channelId) {
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Evento administrativo")
    .setDescription(message)
    .setTimestamp(new Date());

  await channel.send({ embeds: [embed] }).catch(() => undefined);
}
