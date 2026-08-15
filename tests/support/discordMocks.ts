import { ChannelType, type Guild } from "discord.js";
import { vi } from "vitest";

export function makeGuildMock(options: {
  id?: string;
  features: string[];
  channels?: Array<Record<string, unknown>>;
  roles?: Array<Record<string, unknown>>;
}): Guild {
  const channelList = options.channels ?? [];
  const roleList = options.roles ?? [];
  const createChannel = vi.fn((values: { name: string; type: ChannelType; parent?: string }) => {
    const created = {
      id: `${values.name}-created`,
      name: values.name,
      parentId: values.parent,
      type: values.type,
      isThread: () => false,
      delete: vi.fn(() => Promise.resolve()),
    };
    channelList.push(created);
    return Promise.resolve(created);
  });
  const createRole = vi.fn((values: { name: string }) => {
    const created = {
      id: `${values.name}-created`,
      name: values.name,
      managed: false,
      delete: vi.fn(() => Promise.resolve()),
    };
    roleList.push(created);
    return Promise.resolve(created);
  });
  const cache = {
    values: () => channelList.values(),
    find: (predicate: (channel: Record<string, unknown>) => boolean) => channelList.find(predicate),
  };
  const roleCache = {
    values: () => roleList.values(),
    find: (predicate: (role: Record<string, unknown>) => boolean) => roleList.find(predicate),
  };

  return {
    id: options.id ?? "guild",
    features: options.features,
    channels: {
      cache,
      fetch: (id: string) => Promise.resolve(channelList.find((channel) => channel.id === id) ?? null),
      create: createChannel,
    },
    roles: {
      cache: roleCache,
      fetch: (id: string) => Promise.resolve(roleList.find((role) => role.id === id) ?? null),
      create: createRole,
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
    delete: vi.fn(() => Promise.resolve()),
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
    delete: vi.fn(() => Promise.resolve()),
  };
}

export function voiceChannel(
  id: string,
  name: string,
  parentId?: string,
): Record<string, unknown> {
  return {
    id,
    name,
    parentId,
    type: ChannelType.GuildVoice,
    isThread: () => false,
    delete: vi.fn(() => Promise.resolve()),
  };
}

export function forumChannel(id: string, name: string, parentId?: string): Record<string, unknown> {
  return {
    id,
    name,
    parentId,
    type: ChannelType.GuildForum,
    isThread: () => false,
    delete: vi.fn(() => Promise.resolve()),
  };
}

export function role(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    managed: false,
    delete: vi.fn(() => Promise.resolve()),
  };
}
