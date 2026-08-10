import type { GuildMember } from "discord.js";
import type { ServerConfig } from "../core/config/schema.js";
import { renderMemberTemplate } from "../services/templateService.js";
import { sendDiscordLog } from "../services/discordLogService.js";

export async function handleGuildMemberAdd(member: GuildMember, config: ServerConfig): Promise<void> {
  if (member.guild.id !== config.guildId) {
    return;
  }

  const pendingRoleId = config.roles.pending?.id;
  if (pendingRoleId && config.roles.pending?.enabled) {
    await member.roles.add(pendingRoleId).catch(() => undefined);
  }

  if (config.modules.welcome) {
    const message = renderMemberTemplate(config.welcome.message, member);

    if (config.welcome.channelEnabled) {
      const welcomeChannelId = config.channels.welcome?.id;
      if (welcomeChannelId) {
        const channel = await member.guild.channels.fetch(welcomeChannelId).catch(() => null);
        if (channel?.isTextBased()) {
          await channel.send(message).catch(() => undefined);
        }
      }
    }

    if (config.welcome.dmEnabled) {
      await member.send(message).catch(() => undefined);
    }
  }

  await sendDiscordLog(member.client, config, `<@${member.id}> entro al servidor.`);
}
