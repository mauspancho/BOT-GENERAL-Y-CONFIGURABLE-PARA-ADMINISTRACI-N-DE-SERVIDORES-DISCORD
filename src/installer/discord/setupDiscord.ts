import {
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type GuildBasedChannel,
  type GuildChannelCreateOptions,
  type NonThreadGuildBasedChannel,
  type Role,
} from "discord.js";
import type { ChannelConfig, RoleConfig, ServerConfig } from "../../core/config/schema.js";
import { getMissingPermissions, getRequiredPermissions } from "../../core/permissions/requiredPermissions.js";

export interface StructureChange {
  action: "create" | "reuse" | "skip" | "repair";
  resourceType: "category" | "channel" | "role";
  key: string;
  name: string;
  id?: string;
}

export async function validateBotPermissions(guild: Guild, config: Pick<ServerConfig, "modules" | "rules">) {
  const botMember = await guild.members.fetchMe();
  return getMissingPermissions(botMember, getRequiredPermissions(config));
}

export async function applyStructurePlan(guild: Guild, config: ServerConfig): Promise<StructureChange[]> {
  const changes: StructureChange[] = [];
  const categoryIds = new Map<string, string>();

  for (const [key, category] of Object.entries(config.categories)) {
    const existing = await findCategory(guild, category.id, category.name);
    if (existing) {
      category.id = existing.id;
      category.name = existing.name;
      categoryIds.set(key, existing.id);
      changes.push({ action: "skip", resourceType: "category", key, name: existing.name, id: existing.id });
      continue;
    }

    const created = await guild.channels.create({
      name: category.name,
      type: ChannelType.GuildCategory,
    });
    category.id = created.id;
    categoryIds.set(key, created.id);
    changes.push({ action: "create", resourceType: "category", key, name: created.name, id: created.id });
  }

  for (const [key, channel] of Object.entries(config.channels)) {
    const existing = await findChannel(guild, channel.id, channel.name);
    if (existing) {
      channel.id = existing.id;
      channel.name = existing.name;
      changes.push({ action: "skip", resourceType: "channel", key, name: existing.name, id: existing.id });
      continue;
    }

    const parent = channel.categoryKey ? categoryIds.get(channel.categoryKey) : undefined;
    const channelOptions: GuildChannelCreateOptions = {
      name: channel.name,
      type: toDiscordChannelType(channel.type),
    };

    if (channel.readOnlyForMembers) {
      channelOptions.permissionOverwrites = [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel],
          deny: [PermissionFlagsBits.SendMessages],
        },
        {
          id: guild.members.me?.id ?? guild.client.user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        },
      ];
    }
    const created = await guild.channels.create(
      parent ? { ...channelOptions, parent } : channelOptions,
    );
    channel.id = created.id;
    changes.push({ action: "create", resourceType: "channel", key, name: created.name, id: created.id });
  }

  for (const [key, role] of Object.entries(config.roles)) {
    if (!role.enabled) {
      changes.push({ action: "skip", resourceType: "role", key, name: role.name });
      continue;
    }

    const existing = await findRole(guild, role.id, role.name);
    if (existing) {
      role.id = existing.id;
      role.name = existing.name;
      changes.push({ action: "skip", resourceType: "role", key, name: existing.name, id: existing.id });
      continue;
    }

    const created = await guild.roles.create({
      name: role.name,
      reason: "Discord Community Bot setup",
    });
    role.id = created.id;
    changes.push({ action: "create", resourceType: "role", key, name: created.name, id: created.id });
  }

  return changes;
}

export async function findCategory(
  guild: Guild,
  id: string | undefined,
  name: string,
): Promise<CategoryChannel | undefined> {
  if (id) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (channel && channel.type === ChannelType.GuildCategory) {
      return channel;
    }
  }

  return guild.channels.cache.find(
    (channel): channel is CategoryChannel => channel.type === ChannelType.GuildCategory && channel.name === name,
  );
}

export async function findChannel(
  guild: Guild,
  id: string | undefined,
  name: string,
): Promise<NonThreadGuildBasedChannel | undefined> {
  if (id) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (channel && !channel.isThread()) {
      return channel;
    }
  }

  return guild.channels.cache.find(
    (channel): channel is NonThreadGuildBasedChannel => !channel.isThread() && channel.name === name,
  );
}

export async function findRole(guild: Guild, id: string | undefined, name: string): Promise<Role | undefined> {
  if (id) {
    const role = await guild.roles.fetch(id).catch(() => null);
    if (role) {
      return role;
    }
  }

  return guild.roles.cache.find((role) => role.name === name);
}

export function listReusableChannels(guild: Guild): GuildBasedChannel[] {
  return [...guild.channels.cache.values()].filter((channel) => !channel.isThread());
}

export function listReusableRoles(guild: Guild): Role[] {
  return [...guild.roles.cache.values()].filter((role) => !role.managed && role.name !== "@everyone");
}

export function toDiscordChannelType(type: ChannelConfig["type"]): ChannelType.GuildText | ChannelType.GuildAnnouncement | ChannelType.GuildVoice {
  if (type === "announcement") {
    return ChannelType.GuildAnnouncement;
  }
  if (type === "voice") {
    return ChannelType.GuildVoice;
  }
  return ChannelType.GuildText;
}

export function makeRole(name: string, enabled = true): RoleConfig {
  return { name, enabled, protected: true };
}
