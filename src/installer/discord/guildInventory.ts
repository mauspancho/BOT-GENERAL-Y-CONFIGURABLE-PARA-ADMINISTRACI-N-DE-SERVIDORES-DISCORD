import { ChannelType, type Guild, type GuildBasedChannel, type Role } from "discord.js";
import type { ChannelConfig, LogicalChannelFunction, RoleConfig, ServerConfig } from "../../core/config/schema.js";
import type { StructureConfig } from "../wizard/installationPlan.js";

export interface InventoryCategory {
  id: string;
  name: string;
  normalizedName: string;
  position?: number | undefined;
}

export interface InventoryChannel {
  id: string;
  name: string;
  normalizedName: string;
  type: ChannelConfig["type"] | "category";
  parentId?: string | undefined;
  position?: number | undefined;
}

export interface InventoryRole {
  id: string;
  name: string;
  normalizedName: string;
  position?: number | undefined;
}

export interface GuildInventory {
  guildId: string;
  lastScannedAt: string;
  categories: InventoryCategory[];
  channels: InventoryChannel[];
  roles: InventoryRole[];
}

export interface ResourceMatch<T> {
  status: "none" | "matched" | "ambiguous";
  candidates: T[];
}

const logicalChannelAliases: Record<Exclude<LogicalChannelFunction, "custom">, string[]> = {
  general: ["general", "chat-general", "comunidad", "chat"],
  welcome: ["bienvenida", "welcome", "bienvenidos"],
  rules: ["reglas", "rules"],
  announcements: ["anuncios", "avisos", "announcements", "noticias"],
  roles: ["roles", "elige-tus-roles", "seleccion-roles"],
  logs: ["logs", "log", "registros"],
  tickets: ["tickets", "soporte"],
  suggestions: ["sugerencias", "suggestions"],
  theIsleGuide: ["the-isle", "the-isle-guide", "mutaciones", "guia-the-isle"],
};

const categoryAliases: Record<string, string[]> = {
  information: ["informacion", "información", "info"],
  community: ["comunidad", "community"],
  administration: ["administracion", "administración", "admin", "logs"],
};

const roleAliases: Record<string, string[]> = {
  pending: ["sin-verificar", "pendiente", "unverified"],
  member: ["miembro", "member", "verificado", "verified"],
};

export function scanGuildInventory(guild: Guild, now = new Date()): GuildInventory {
  const channels = [...guild.channels.cache.values()];
  return {
    guildId: guild.id,
    lastScannedAt: now.toISOString(),
    categories: channels
      .filter((channel) => channel.type === ChannelType.GuildCategory)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        normalizedName: normalizeDiscordResourceName(channel.name),
        position: readPosition(channel),
      })),
    channels: channels
      .filter((channel) => channel.type !== ChannelType.GuildCategory && !channel.isThread())
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        normalizedName: normalizeDiscordResourceName(channel.name),
        type: toInventoryChannelType(channel),
        parentId: "parentId" in channel ? channel.parentId ?? undefined : undefined,
        position: readPosition(channel),
      })),
    roles: [...guild.roles.cache.values()]
      .filter((role) => !role.managed && role.name !== "@everyone")
      .map((role) => ({
        id: role.id,
        name: role.name,
        normalizedName: normalizeDiscordResourceName(role.name),
        position: readRolePosition(role),
      })),
  };
}

export function normalizeDiscordResourceName(value: string): string {
  return value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")
    .toLowerCase()
    .replaceAll(/[「」【】[\](){}]/g, "")
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replaceAll(/^-|-$/g, "");
}

export function findChannelCandidates(
  inventory: GuildInventory,
  key: string,
  channel: ChannelConfig,
): ResourceMatch<InventoryChannel> {
  const wantedType = channel.type === "announcement" ? ["announcement", "text"] : [channel.type];
  const aliases = channel.function === "custom" ? [channel.name] : logicalChannelAliases[channel.function];
  const normalizedAliases = new Set([key, channel.name, ...aliases].map(normalizeDiscordResourceName));
  const matches = inventory.channels.filter(
    (candidate) => wantedType.includes(candidate.type) && normalizedAliases.has(candidate.normalizedName),
  );
  return classifyMatches(matches);
}

export function findCategoryCandidates(
  inventory: GuildInventory,
  key: string,
  category: { name: string; id?: string | undefined },
): ResourceMatch<InventoryCategory> {
  const normalizedAliases = new Set([key, category.name, ...(categoryAliases[key] ?? [])].map(normalizeDiscordResourceName));
  const matches = inventory.categories.filter((candidate) => normalizedAliases.has(candidate.normalizedName));
  return classifyMatches(matches);
}

export function findRoleCandidates(
  inventory: GuildInventory,
  key: string,
  role: RoleConfig,
): ResourceMatch<InventoryRole> {
  const normalizedAliases = new Set([key, role.name, ...(roleAliases[key] ?? [])].map(normalizeDiscordResourceName));
  const matches = inventory.roles.filter((candidate) => normalizedAliases.has(candidate.normalizedName));
  return classifyMatches(matches);
}

export function applyInventoryToConfig(
  config: StructureConfig | ServerConfig,
  inventory: GuildInventory,
): { reused: string[]; ambiguous: string[]; missing: string[] } {
  const reused: string[] = [];
  const ambiguous: string[] = [];
  const missing: string[] = [];

  for (const [key, category] of Object.entries(config.categories)) {
    if (category.id && inventory.categories.some((candidate) => candidate.id === category.id)) {
      reused.push(`category:${key}`);
      continue;
    }
    const match = findCategoryCandidates(inventory, key, category);
    if (match.status === "matched") {
      const candidate = match.candidates[0];
      if (!candidate) {
        continue;
      }
      config.categories[key] = { name: candidate.name, id: candidate.id };
      reused.push(`category:${key}`);
      continue;
    }
    if (match.status === "ambiguous") {
      ambiguous.push(`category:${key}`);
      continue;
    }
    missing.push(`category:${key}`);
  }

  for (const [key, channel] of Object.entries(config.channels)) {
    if (channel.id && inventory.channels.some((candidate) => candidate.id === channel.id && isCompatibleType(candidate, channel))) {
      reused.push(`channel:${key}`);
      continue;
    }
    const match = findChannelCandidates(inventory, key, channel);
    if (match.status === "matched") {
      const candidate = match.candidates[0];
      if (!candidate) {
        continue;
      }
      const categoryKey = categoryKeyForParent(config, inventory, candidate.parentId);
      config.channels[key] = {
        ...channel,
        id: candidate.id,
        name: candidate.name,
        ...(categoryKey ? { categoryKey } : {}),
      };
      reused.push(`channel:${key}`);
      continue;
    }
    if (match.status === "ambiguous") {
      ambiguous.push(`channel:${key}`);
      continue;
    }
    missing.push(`channel:${key}`);
  }

  for (const [key, role] of Object.entries(config.roles)) {
    if (!role.enabled) {
      continue;
    }
    if (role.id && inventory.roles.some((candidate) => candidate.id === role.id)) {
      reused.push(`role:${key}`);
      continue;
    }
    const match = findRoleCandidates(inventory, key, role);
    if (match.status === "matched") {
      const candidate = match.candidates[0];
      if (!candidate) {
        continue;
      }
      config.roles[key] = { ...role, id: candidate.id, name: candidate.name };
      reused.push(`role:${key}`);
      continue;
    }
    if (match.status === "ambiguous") {
      ambiguous.push(`role:${key}`);
      continue;
    }
    missing.push(`role:${key}`);
  }

  return { reused, ambiguous, missing };
}

function classifyMatches<T>(matches: T[]): ResourceMatch<T> {
  if (matches.length === 0) {
    return { status: "none", candidates: [] };
  }
  if (matches.length === 1) {
    return { status: "matched", candidates: matches };
  }
  return { status: "ambiguous", candidates: matches };
}

function isCompatibleType(candidate: InventoryChannel, channel: ChannelConfig): boolean {
  if (channel.type === "announcement") {
    return candidate.type === "announcement" || candidate.type === "text";
  }
  return candidate.type === channel.type;
}

function categoryKeyForParent(
  config: StructureConfig | ServerConfig,
  inventory: GuildInventory,
  parentId: string | undefined,
): string | undefined {
  if (!parentId) {
    return undefined;
  }
  const existing = Object.entries(config.categories).find(([, category]) => category.id === parentId);
  if (existing) {
    return existing[0];
  }
  const category = inventory.categories.find((candidate) => candidate.id === parentId);
  if (!category) {
    return undefined;
  }
  const key = Object.keys(config.categories).find(
    (candidateKey) => normalizeDiscordResourceName(candidateKey) === category.normalizedName,
  );
  return key;
}

function toInventoryChannelType(channel: GuildBasedChannel): InventoryChannel["type"] {
  if (channel.type === ChannelType.GuildCategory) {
    return "category";
  }
  if (channel.type === ChannelType.GuildVoice) {
    return "voice";
  }
  if (channel.type === ChannelType.GuildAnnouncement) {
    return "announcement";
  }
  return "text";
}

function readPosition(channel: GuildBasedChannel): number | undefined {
  return typeof (channel as { position?: unknown }).position === "number"
    ? (channel as { position: number }).position
    : undefined;
}

function readRolePosition(role: Role): number | undefined {
  return typeof (role as { position?: unknown }).position === "number"
    ? (role as { position: number }).position
    : undefined;
}
