import fs from "node:fs";
import path from "node:path";
import { getGuildRulesPath, getGuildRulesSourcePath, resolveFromRoot } from "../../core/config/paths.js";
import { normalizeRules } from "../../services/rulesContentService.js";
import type { PlannedFileOperation } from "./plannedFileOperations.js";

export function managedRulesSourcePath(guildId: string): string {
  return getGuildRulesSourcePath(guildId);
}

export function managedRulesAbsolutePath(guildId: string): string {
  return getGuildRulesPath(guildId);
}

export function isManagedRulesPath(guildId: string, sourcePath: string): boolean {
  return path.resolve(resolveFromRoot(sourcePath)) === path.resolve(managedRulesAbsolutePath(guildId));
}

export function planImportRulesFile(guildId: string, sourcePath: string): { sourcePath: string; fileOperations: PlannedFileOperation[] } {
  return {
    sourcePath: managedRulesSourcePath(guildId),
    fileOperations: [{ type: "copyFile", sourcePath, targetPath: managedRulesAbsolutePath(guildId) }],
  };
}

export function planWriteManagedRules(guildId: string, content: string): { sourcePath: string; fileOperations: PlannedFileOperation[] } {
  return {
    sourcePath: managedRulesSourcePath(guildId),
    fileOperations: [{ type: "writeText", path: managedRulesAbsolutePath(guildId), content: `${normalizeRules(content)}\n` }],
  };
}

export function readRulesForDisplay(sourcePath: string): string | undefined {
  const resolved = resolveFromRoot(sourcePath);
  return fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : undefined;
}
