import fs from "node:fs";
import path from "node:path";
import { ChannelType, type Guild, type GuildBasedChannel, type Role } from "discord.js";
import { getGuildDataDir } from "../../core/config/paths.js";
import type { ChannelConfig, LogicalChannelFunction, RoleConfig, ServerConfig } from "../../core/config/schema.js";
import type { StructureConfig } from "../wizard/installationPlan.js";
import { toSupportedChannelType } from "./channelCompatibility.js";

export interface InventoryCategory {
  id: string;
  name: string;
  normalizedName: string;
  type: "category";
  position?: number | undefined;
}

export interface InventoryChannel {
  id: string;
  name: string;
  normalizedName: string;
  type: ChannelConfig["type"] | "unsupported";
  discordType: number;
  parentId?: string | undefined;
  position?: number | undefined;
}

export interface InventoryRole {
  id: string;
  name: string;
  normalizedName: string;
  type: "role";
  position?: number | undefined;
}

export interface GuildInventory {
  schemaVersion: 1;
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
    schemaVersion: 1,
    guildId: guild.id,
    lastScannedAt: now.toISOString(),
    categories: channels
      .filter((channel) => channel.type === ChannelType.GuildCategory)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        normalizedName: normalizeDiscordResourceName(channel.name),
        type: "category",
        position: readPosition(channel),
      })),
    channels: channels
      .filter((channel) => channel.type !== ChannelType.GuildCategory && !channel.isThread())
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        normalizedName: normalizeDiscordResourceName(channel.name),
        type: toInventoryChannelType(channel),
        discordType: channel.type,
        parentId: "parentId" in channel ? channel.parentId ?? undefined : undefined,
        position: readPosition(channel),
      })),
    roles: [...guild.roles.cache.values()]
      .filter((role) => !role.managed && role.name !== "@everyone")
      .map((role) => ({
        id: role.id,
        name: role.name,
        normalizedName: normalizeDiscordResourceName(role.name),
        type: "role",
        position: readRolePosition(role),
      })),
  };
}

export function scanAndPersistGuildInventory(guild: Guild, now = new Date()): GuildInventory {
  const inventory = scanGuildInventory(guild, now);
  writeGuildInventorySnapshot(inventory);
  return inventory;
}

export function getGuildInventorySnapshotPath(guildId: string): string {
  return path.join(getGuildDataDir(guildId), "discord-inventory.json");
}

export function writeGuildInventorySnapshot(inventory: GuildInventory): void {
  const targetPath = getGuildInventorySnapshotPath(inventory.guildId);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, targetPath);
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
  const compatible = inventory.channels.filter((candidate) => isCompatibleType(candidate, channel));
  const levels = [
    [channel.name],
    [key],
    channel.function === "custom" ? [] : logicalChannelAliases[channel.function],
  ];

  for (const level of levels) {
    const normalized = new Set(level.map(normalizeDiscordResourceName));
    const matches = compatible.filter((candidate) => normalized.has(candidate.normalizedName));
    if (matches.length > 0) {
      return classifyMatches(matches);
    }
  }

  return { status: "none", candidates: [] };
}

export function findCategoryCandidates(
  inventory: GuildInventory,
  key: string,
  category: { name: string; id?: string | undefined },
): ResourceMatch<InventoryCategory> {
  return findCandidatesByPriority(inventory.categories, [
    [category.name],
    [key],
    categoryAliases[key] ?? [],
  ]);
}

export function findRoleCandidates(
  inventory: GuildInventory,
  key: string,
  role: RoleConfig,
): ResourceMatch<InventoryRole> {
  return findCandidatesByPriority(inventory.roles, [
    [role.name],
    [key],
    roleAliases[key] ?? [],
  ]);
}

export function applyInventoryToConfig(
  config: StructureConfig | ServerConfig,
  inventory: GuildInventory,
): { reused: string[]; ambiguous: string[]; missing: string[] } {
  const reused: string[] = [];
  const ambiguous: string[] = [];
  const missing: string[] = [];

  if (config.guildId !== inventory.guildId) {
    throw new Error(`El inventario ${inventory.guildId} no pertenece al servidor configurado ${config.guildId}.`);
  }

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

function findCandidatesByPriority<T extends { normalizedName: string }>(candidates: T[], levels: string[][]): ResourceMatch<T> {
  for (const level of levels) {
    const normalized = new Set(level.map(normalizeDiscordResourceName));
    const matches = candidates.filter((candidate) => normalized.has(candidate.normalizedName));
    if (matches.length > 0) {
      return classifyMatches(matches);
    }
  }
  return { status: "none", candidates: [] };
}

export function isCompatibleInventoryChannel(candidate: InventoryChannel, channel: ChannelConfig): boolean {
  return isCompatibleType(candidate, channel);
}

function isCompatibleType(candidate: InventoryChannel, channel: ChannelConfig): boolean {
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
  return toSupportedChannelType(channel) ?? "unsupported";
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
