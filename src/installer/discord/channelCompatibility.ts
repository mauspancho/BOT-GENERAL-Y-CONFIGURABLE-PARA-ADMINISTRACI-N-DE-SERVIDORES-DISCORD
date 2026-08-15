import {
  ChannelType,
  type Guild,
  type GuildBasedChannel,
  type NonThreadGuildBasedChannel,
} from "discord.js";
import type { ChannelConfig } from "../../core/config/schema.js";

export type SupportedDiscordChannelType = ChannelConfig["type"];

export function guildSupportsAnnouncementChannels(guild: Pick<Guild, "features">): boolean {
  return guild.features.includes("COMMUNITY");
}

export function toDiscordChannelType(
  type: ChannelConfig["type"],
  allowAnnouncementChannels = true,
): ChannelType.GuildText | ChannelType.GuildAnnouncement | ChannelType.GuildVoice {
  if (type === "announcement") {
    return allowAnnouncementChannels ? ChannelType.GuildAnnouncement : ChannelType.GuildText;
  }
  if (type === "voice") {
    return ChannelType.GuildVoice;
  }
  return ChannelType.GuildText;
}

export function toSupportedChannelType(channel: GuildBasedChannel): SupportedDiscordChannelType | undefined {
  if (channel.type === ChannelType.GuildText) {
    return "text";
  }
  if (channel.type === ChannelType.GuildVoice) {
    return "voice";
  }
  if (channel.type === ChannelType.GuildAnnouncement) {
    return "announcement";
  }
  return undefined;
}

export function isCompatibleDiscordChannel(
  channel: NonThreadGuildBasedChannel,
  expectedType: ChannelConfig["type"],
  allowAnnouncementChannels: boolean,
): boolean {
  return channel.type === toDiscordChannelType(expectedType, allowAnnouncementChannels);
}

export function isCompatibleReusableChannel(
  guild: Pick<Guild, "features">,
  channel: GuildBasedChannel,
  expectedType: ChannelConfig["type"],
): channel is NonThreadGuildBasedChannel {
  return !channel.isThread() && isCompatibleDiscordChannel(channel, expectedType, guildSupportsAnnouncementChannels(guild));
}
