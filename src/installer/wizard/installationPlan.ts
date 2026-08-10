import type { ChannelConfig, LogicalChannelFunction, ServerConfig } from "../../core/config/schema.js";
import { CONFIG_VERSION } from "../../core/config/schema.js";
import { makeRole } from "../discord/setupDiscord.js";

export type StructureConfig = Omit<ServerConfig, "welcome" | "rules">;
export type DuplicateFunctionResolution = "replace" | "custom" | "cancel";

export interface ChannelDraft {
  name: string;
  type: ChannelConfig["type"];
  function: LogicalChannelFunction;
  readOnlyForMembers: boolean;
  id?: string;
}

export interface AddChannelResult {
  added: boolean;
  key?: string;
  conflict?: ChannelFunctionConflict;
}

export interface ChannelFunctionConflict {
  function: LogicalChannelFunction;
  existingKey: string;
  existingName: string;
}

export const uniqueChannelFunctions = new Set<LogicalChannelFunction>([
  "welcome",
  "rules",
  "announcements",
  "roles",
  "general",
  "logs",
  "tickets",
  "suggestions",
]);

const knownCategoryKeys = new Map<string, string>([
  ["informacion", "information"],
  ["información", "information"],
  ["info", "information"],
  ["comunidad", "community"],
  ["community", "community"],
  ["administracion", "administration"],
  ["administración", "administration"],
  ["admin", "administration"],
]);

export function createEmptyStructureConfig(
  guildId: string,
  communityName: string,
  modules: ServerConfig["modules"],
): StructureConfig {
  return {
    version: CONFIG_VERSION,
    guildId,
    communityName,
    locale: "es",
    categories: {},
    channels: {},
    roles: {},
    modules,
  };
}

export function addPlannedCategory(
  config: StructureConfig,
  category: { name: string; id?: string },
): string {
  const baseKey = keyForCategoryName(category.name);
  const key = makeUniqueKey(baseKey, config.categories);
  config.categories[key] = category.id ? { name: category.name, id: category.id } : { name: category.name };
  return key;
}

export function addPlannedChannel(
  config: StructureConfig,
  categoryKey: string,
  draft: ChannelDraft,
  duplicateResolution: DuplicateFunctionResolution = "cancel",
): AddChannelResult {
  const conflict = findChannelFunctionConflict(config, draft.function);
  const finalDraft = { ...draft };

  if (conflict) {
    if (duplicateResolution === "cancel") {
      return { added: false, conflict };
    }

    if (duplicateResolution === "custom") {
      finalDraft.function = "custom";
    }

    if (duplicateResolution === "replace") {
      convertChannelToCustom(config, conflict.existingKey);
    }
  }

  const key =
    finalDraft.function !== "custom" && uniqueChannelFunctions.has(finalDraft.function)
      ? finalDraft.function
      : makeUniqueKey(slugifyName(finalDraft.name) || "custom-channel", config.channels);

  config.channels[key] = {
    name: finalDraft.name,
    type: finalDraft.type,
    categoryKey,
    function: finalDraft.function,
    readOnlyForMembers: finalDraft.readOnlyForMembers,
    ...(finalDraft.id ? { id: finalDraft.id } : {}),
  };

  return { added: true, key };
}

export function ensureVerificationRoles(
  config: StructureConfig,
  values: { pendingRole: string; memberRole: string },
): void {
  if (!config.modules.rules) {
    return;
  }

  config.roles.pending = makeRole(values.pendingRole);
  config.roles.member = makeRole(values.memberRole);
}

export function slugifyName(name: string): string {
  return name
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

export function makeUniqueKey(baseKey: string, existing: Record<string, unknown>): string {
  const normalized = baseKey || "item";
  if (!existing[normalized]) {
    return normalized;
  }

  let index = 2;
  while (existing[`${normalized}-${index}`]) {
    index += 1;
  }

  return `${normalized}-${index}`;
}

export function keyForCategoryName(name: string): string {
  const slug = slugifyName(name);
  return knownCategoryKeys.get(slug) ?? slug;
}

export function findChannelFunctionConflict(
  config: StructureConfig,
  channelFunction: LogicalChannelFunction,
): ChannelFunctionConflict | undefined {
  if (channelFunction === "custom" || !uniqueChannelFunctions.has(channelFunction)) {
    return undefined;
  }

  const entry = Object.entries(config.channels).find(
    ([, channel]) => channel.function === channelFunction,
  );

  if (!entry) {
    return undefined;
  }

  const [existingKey, existingChannel] = entry;
  return {
    function: channelFunction,
    existingKey,
    existingName: existingChannel.name,
  };
}

function convertChannelToCustom(config: StructureConfig, key: string): void {
  const channel = config.channels[key];
  if (!channel) {
    return;
  }

  const customChannel = { ...channel, function: "custom" as const };
  delete config.channels[key];
  const customKey = makeUniqueKey(slugifyName(channel.name) || "custom-channel", config.channels);
  config.channels[customKey] = customChannel;
}
