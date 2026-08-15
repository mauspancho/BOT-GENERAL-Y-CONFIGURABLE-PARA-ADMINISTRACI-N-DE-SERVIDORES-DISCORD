import type { ChannelConfig, LogicalChannelFunction, ServerConfig } from "../../core/config/schema.js";
import type { PlannedFileOperation } from "./plannedFileOperations.js";
import {
  managedRulesSourcePath,
  planImportRulesFile,
  planWriteManagedRules,
} from "./rulesStorage.js";

export interface SectionPatchResult {
  fileOperations: PlannedFileOperation[];
}

export function patchTikTokAlerts(
  config: ServerConfig,
  patch: Partial<ServerConfig["tiktokAlerts"]> & { enabled?: boolean },
): void {
  config.modules.tiktokAlerts = patch.enabled ?? config.modules.tiktokAlerts;
  config.tiktokAlerts = {
    ...config.tiktokAlerts,
    ...patch,
    enabled: patch.enabled ?? config.tiktokAlerts.enabled,
  };
}

export function patchGeneralAlerts(config: ServerConfig, enabled: boolean): void {
  config.modules.generalAlerts = enabled;
}

export function patchWelcome(config: ServerConfig, patch: Partial<ServerConfig["welcome"]>): void {
  config.welcome = { ...config.welcome, ...patch };
}

export function patchTheIsleGuide(config: ServerConfig, patch: ServerConfig["theIsleGuide"]): void {
  config.modules.theIsleGuide = patch.enabled;
  config.theIsleGuide = patch;
}

export function patchRulesBehavior(
  config: ServerConfig,
  patch: Partial<Pick<ServerConfig["rules"], "rejectAction" | "requireReacceptOnRulesChange" | "enabled">>,
): void {
  config.rules = { ...config.rules, ...patch };
  if (patch.enabled !== undefined) {
    config.modules.rules = patch.enabled;
  }
}

export function patchRulesExternalPath(config: ServerConfig, sourcePath: string): SectionPatchResult {
  config.modules.rules = true;
  config.rules = { ...config.rules, enabled: true, sourcePath };
  return { fileOperations: [] };
}

export function patchRulesImport(config: ServerConfig, importPath: string): SectionPatchResult {
  const planned = planImportRulesFile(config.guildId, importPath);
  config.modules.rules = true;
  config.rules = {
    ...config.rules,
    enabled: true,
    sourcePath: planned.sourcePath,
    version: config.rules.version + 1,
  };
  return { fileOperations: planned.fileOperations };
}

export function patchManagedRulesContent(config: ServerConfig, content: string): SectionPatchResult {
  const planned = planWriteManagedRules(config.guildId, content);
  config.modules.rules = true;
  config.rules = {
    ...config.rules,
    enabled: true,
    sourcePath: managedRulesSourcePath(config.guildId),
    version: config.rules.version + 1,
  };
  return { fileOperations: planned.fileOperations };
}

export function patchCommunityName(config: ServerConfig, communityName: string): void {
  config.communityName = communityName;
}

export function patchCategoryName(config: ServerConfig, key: string, name: string): void {
  const current = config.categories[key];
  if (!current) {
    throw new Error(`Categoria no encontrada: ${key}`);
  }
  config.categories[key] = { ...current, name };
}

export function patchChannel(
  config: ServerConfig,
  key: string,
  patch: Partial<ChannelConfig>,
): void {
  const current = config.channels[key];
  if (!current) {
    throw new Error(`Canal no encontrado: ${key}`);
  }
  config.channels[key] = { ...current, ...patch };
}

export function addLogicalChannel(
  config: ServerConfig,
  key: string,
  channel: ChannelConfig,
): void {
  if (config.channels[key]) {
    throw new Error(`Ya existe el canal logico: ${key}`);
  }
  if (channel.function !== "custom") {
    const duplicate = Object.entries(config.channels).find(
      ([existingKey, existing]) => existingKey !== key && existing.function === channel.function,
    );
    if (duplicate) {
      throw new Error(`La funcion ${channel.function} ya esta asignada a ${duplicate[0]}.`);
    }
  }
  config.channels[key] = channel;
}

export function ensureLogicalChannel(
  config: ServerConfig,
  key: string,
  values: { name: string; function: LogicalChannelFunction; categoryKey?: string; id?: string },
): void {
  if (config.channels[key]) {
    return;
  }

  addLogicalChannel(config, key, {
    name: values.name,
    type: "text",
    ...(values.categoryKey ? { categoryKey: values.categoryKey } : {}),
    ...(values.id ? { id: values.id } : {}),
    function: values.function,
    readOnlyForMembers: values.function !== "general",
  });
}
