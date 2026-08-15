import type { ServerConfig } from "../../core/config/schema.js";

export interface ConfigDiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

const topLevelSections = [
  "communityName",
  "modules",
  "tiktokAlerts",
  "rules",
  "welcome",
  "theIsleGuide",
  "categories",
  "channels",
  "roles",
] as const;

export function getConfigDiff(before: ServerConfig, after: ServerConfig): ConfigDiffEntry[] {
  const entries: ConfigDiffEntry[] = [];
  collectDiff("", before, after, entries);
  return entries;
}

export function getUnchangedTopLevelSections(before: ServerConfig, after: ServerConfig): string[] {
  return topLevelSections.filter((section) => jsonEqual(before[section], after[section]));
}

export function formatConfigDiff(before: ServerConfig, after: ServerConfig): string {
  const changes = getConfigDiff(before, after);
  const unchanged = getUnchangedTopLevelSections(before, after);
  if (changes.length === 0) {
    return "No hay cambios para aplicar.";
  }

  return [
    `Servidor: ${after.communityName}`,
    "",
    "Cambios:",
    ...changes.map((change) => `${change.path}:\n  ${formatValue(change.before)} -> ${formatValue(change.after)}`),
    "",
    "Sin cambios:",
    ...unchanged.map((section) => `  ${section}`),
  ].join("\n");
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectDiff(path: string, before: unknown, after: unknown, entries: ConfigDiffEntry[]): void {
  if (jsonEqual(before, after)) {
    return;
  }

  if (!isPlainObject(before) || !isPlainObject(after)) {
    entries.push({ path, before, after });
    return;
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    collectDiff(path ? `${path}.${key}` : key, before[key], after[key], entries);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}
