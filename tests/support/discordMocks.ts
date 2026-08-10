import { ChannelType, type Guild } from "discord.js";
import { vi } from "vitest";

export function makeGuildMock(options: {
  features: string[];
  channels?: Array<Record<string, unknown>>;
  roles?: Array<Record<string, unknown>>;
}): Guild {
  const channelList = options.channels ?? [];
  const roleList = options.roles ?? [];
  const cache = {
    values: () => channelList.values(),
    find: (predicate: (channel: Record<string, unknown>) => boolean) => channelList.find(predicate),
  };
  const roleCache = {
    values: () => roleList.values(),
    find: (predicate: (role: Record<string, unknown>) => boolean) => roleList.find(predicate),
  };

  return {
    features: options.features,
    channels: {
      cache,
      fetch: (id: string) => Promise.resolve(channelList.find((channel) => channel.id === id) ?? null),
      create: vi.fn(),
    },
    roles: {
      cache: roleCache,
      fetch: (id: string) => Promise.resolve(roleList.find((role) => role.id === id) ?? null),
      create: vi.fn(),
      everyone: { id: "everyone" },
    },
    members: {
      me: { id: "bot" },
    },
    client: {
      user: { id: "bot" },
    },
  } as unknown as Guild;
}

export function category(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    type: ChannelType.GuildCategory,
    isThread: () => false,
  };
}

export function textChannel(
  id: string,
  name: string,
  parentId?: string,
): Record<string, unknown> {
  return {
    id,
    name,
    parentId,
    type: ChannelType.GuildText,
    isThread: () => false,
  };
}
