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
import { InstallerError } from "../../core/errors/AppError.js";
import { getMissingPermissions, getRequiredPermissions } from "../../core/permissions/requiredPermissions.js";
import { ensureAutomaticInfrastructure } from "../wizard/installationPlan.js";
import { isTheIsleGuideEnabled } from "../../modules/theIsleGuide/theIsleGuideConfig.js";
import {
  guildSupportsAnnouncementChannels,
  isCompatibleDiscordChannel,
  toDiscordChannelType,
} from "./channelCompatibility.js";

export interface StructureChange {
  action: "create" | "reuse" | "skip" | "repair";
  resourceType: "category" | "channel" | "role";
  key: string;
  name: string;
  id?: string;
}

export interface StructurePreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export class StructureApplyError extends InstallerError {
  public constructor(
    message: string,
    public readonly createdResources: StructureChange[],
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

export async function validateBotPermissions(guild: Guild, config: Pick<ServerConfig, "modules" | "rules">) {
  const botMember = await guild.members.fetchMe();
  return getMissingPermissions(botMember, getRequiredPermissions(config));
}

export function preflightStructurePlan(
  guild: Guild,
  config: ServerConfig,
): StructurePreflightResult {
  const result: StructurePreflightResult = {
    ok: true,
    errors: [],
    warnings: [],
  };

  ensureAutomaticInfrastructure(config);
  validateStructureShape(config, result);
  normalizeUnsupportedChannelTypes(guild, config, result);

  if (result.errors.length > 0) {
    result.ok = false;
  }

  return result;
}

export async function applyStructurePlan(guild: Guild, config: ServerConfig): Promise<StructureChange[]> {
  const changes: StructureChange[] = [];
  const createdResources: StructureChange[] = [];
  const categoryIds = new Map<string, string>();

  const preflight = preflightStructurePlan(guild, config);
  if (!preflight.ok) {
    throw new StructureApplyError(
      `Preflight invalido: ${preflight.errors.join("; ")}`,
      createdResources,
    );
  }

  try {
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
      const change: StructureChange = {
        action: "create",
        resourceType: "category",
        key,
        name: created.name,
        id: created.id,
      };
      changes.push(change);
      createdResources.push(change);
    }

    for (const [key, channel] of Object.entries(config.channels)) {
      const existing = await findChannel(guild, channel.id, channel.name, channel.type);
      if (existing) {
        channel.id = existing.id;
        channel.name = existing.name;
        changes.push({ action: "skip", resourceType: "channel", key, name: existing.name, id: existing.id });
        continue;
      }

      const parent = channel.categoryKey ? categoryIds.get(channel.categoryKey) : undefined;
      const channelOptions: GuildChannelCreateOptions = {
        name: channel.name,
        type: toDiscordChannelType(channel.type, guildSupportsAnnouncementChannels(guild)),
      };

      const permissionOverwrites = getChannelPermissionOverwrites(guild, channel);
      if (permissionOverwrites) {
        channelOptions.permissionOverwrites = permissionOverwrites;
      }
      const created = await guild.channels.create(parent ? { ...channelOptions, parent } : channelOptions);
      channel.id = created.id;
      const change: StructureChange = {
        action: "create",
        resourceType: "channel",
        key,
        name: created.name,
        id: created.id,
      };
      changes.push(change);
      createdResources.push(change);
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
      const change: StructureChange = {
        action: "create",
        resourceType: "role",
        key,
        name: created.name,
        id: created.id,
      };
      changes.push(change);
      createdResources.push(change);
    }

    return changes;
  } catch (error) {
    throw new StructureApplyError(
      "La instalacion no pudo completarse.",
      createdResources,
      error,
    );
  }
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
  expectedType?: ChannelConfig["type"],
): Promise<NonThreadGuildBasedChannel | undefined> {
  if (id) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (channel && !channel.isThread() && isExpectedChannelType(channel, expectedType, guildSupportsAnnouncementChannels(guild))) {
      return channel;
    }
  }

  return guild.channels.cache.find(
    (channel): channel is NonThreadGuildBasedChannel =>
      !channel.isThread() &&
      channel.name === name &&
      isExpectedChannelType(channel, expectedType, guildSupportsAnnouncementChannels(guild)),
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

export function makeRole(name: string, enabled = true): RoleConfig {
  return { name, enabled, protected: true };
}

export async function rollbackCreatedResources(
  guild: Guild,
  createdResources: StructureChange[],
): Promise<StructureChange[]> {
  const reverted: StructureChange[] = [];

  for (const resource of [...createdResources].reverse()) {
    if (resource.action !== "create") {
      continue;
    }
    if (!resource.id) {
      continue;
    }

    if (resource.resourceType === "role") {
      const role = await guild.roles.fetch(resource.id).catch(() => null);
      if (role) {
        await role.delete("Rollback Discord Community Bot setup");
        reverted.push(resource);
      }
      continue;
    }

    const channel = await guild.channels.fetch(resource.id).catch(() => null);
    if (channel && !channel.isThread()) {
      await channel.delete("Rollback Discord Community Bot setup");
      reverted.push(resource);
    }
  }

  return reverted;
}

function validateStructureShape(config: ServerConfig, result: StructurePreflightResult): void {
  validateModuleResources(config, result);
  validateUniqueChannelFunctions(config, result);

  for (const [key, category] of Object.entries(config.categories)) {
    if (category.name.trim().length === 0) {
      result.errors.push(`La categoria "${key}" no tiene nombre.`);
    }
  }

  for (const [key, channel] of Object.entries(config.channels)) {
    if (channel.name.trim().length === 0) {
      result.errors.push(`El canal "${key}" no tiene nombre.`);
    }
    if (channel.categoryKey && !config.categories[channel.categoryKey]) {
      result.errors.push(
        `El canal "${key}" referencia la categoria inexistente "${channel.categoryKey}".`,
      );
    }
  }

  for (const [key, role] of Object.entries(config.roles)) {
    if (role.enabled && role.name.trim().length === 0) {
      result.errors.push(`El rol "${key}" no tiene nombre.`);
    }
  }
}

function validateUniqueChannelFunctions(config: ServerConfig, result: StructurePreflightResult): void {
  const uniqueFunctions = new Set([
    "welcome",
    "rules",
    "announcements",
    "roles",
    "general",
    "tickets",
    "suggestions",
    "theIsleGuide",
  ]);
  const seen = new Map<string, string>();

  for (const [key, channel] of Object.entries(config.channels)) {
    if (!uniqueFunctions.has(channel.function)) {
      continue;
    }

    const existing = seen.get(channel.function);
    if (existing) {
      result.errors.push(
        `La funcion unica "${channel.function}" esta asignada a "${existing}" y "${key}".`,
      );
      continue;
    }

    seen.set(channel.function, key);
  }
}

function validateModuleResources(config: ServerConfig, result: StructurePreflightResult): void {
  const generalReason = config.modules.generalAlerts ? "modulo generalAlerts" : "core del servidor";
  if (config.modules.tiktokAlerts && !config.modules.generalAlerts) {
    result.errors.push("El modulo tiktokAlerts requiere modules.generalAlerts=true.");
  }

  const requiredChannels: Array<[boolean, string, string]> = [
    [true, "general", generalReason],
    [config.modules.welcome && config.welcome.channelEnabled, "welcome", "modulo welcome"],
    [config.modules.rules, "rules", "modulo rules"],
    [config.modules.announcements, "announcements", "modulo announcements"],
    [config.modules.selfRoles, "roles", "modulo selfRoles"],
    [config.modules.tickets, "tickets", "modulo tickets"],
    [config.modules.suggestions, "suggestions", "modulo suggestions"],
    [config.modules.logs, "logs", "infraestructura logs"],
    [config.modules.tiktokAlerts, "general", "modulo tiktokAlerts"],
    [isTheIsleGuideEnabled(config), "theIsleGuide", "modulo theIsleGuide"],
  ];

  for (const [required, key, reason] of requiredChannels) {
    if (required && !config.channels[key]) {
      result.errors.push(`Falta el canal logico "${key}" requerido por ${reason}.`);
    }
  }

  if (config.modules.rules) {
    for (const key of ["pending", "member"] as const) {
      if (!config.roles[key]?.enabled) {
        result.errors.push(`Falta el rol logico "${key}" requerido por el modulo rules.`);
      }
    }
  }
}

export function getChannelPermissionOverwrites(
  guild: Guild,
  channel: ChannelConfig,
): GuildChannelCreateOptions["permissionOverwrites"] {
  const botId = guild.members.me?.id ?? guild.client.user.id;

  if (channel.function === "logs") {
    return [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: botId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ];
  }

  if (!channel.readOnlyForMembers) {
    return undefined;
  }

  return [
    {
      id: guild.roles.everyone.id,
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [PermissionFlagsBits.SendMessages],
    },
    {
      id: botId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    },
  ];
}

function normalizeUnsupportedChannelTypes(
  guild: Guild,
  config: ServerConfig,
  result: StructurePreflightResult,
): void {
  if (guildSupportsAnnouncementChannels(guild)) {
    return;
  }

  for (const [key, channel] of Object.entries(config.channels)) {
    if (channel.type === "announcement") {
      channel.type = "text";
      result.warnings.push(
        `Este servidor no admite canales de anuncios. El canal "${key}" se usara como texto normal.`,
      );
    }
  }
}

function isExpectedChannelType(
  channel: NonThreadGuildBasedChannel,
  expectedType: ChannelConfig["type"] | undefined,
  allowAnnouncementChannels: boolean,
): boolean {
  if (!expectedType) {
    return true;
  }
  return isCompatibleDiscordChannel(channel, expectedType, allowAnnouncementChannels);
}

export { guildSupportsAnnouncementChannels, toDiscordChannelType };
