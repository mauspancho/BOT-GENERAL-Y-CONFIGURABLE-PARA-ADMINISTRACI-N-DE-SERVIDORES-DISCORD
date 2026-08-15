import fs from "node:fs";
import path from "node:path";
import type { Guild } from "discord.js";
import type { ServerConfig } from "../../core/config/schema.js";
import type { GuildConfigManager } from "../../core/config/guildConfigManager.js";
import { applyStructurePlan, preflightStructurePlan, type StructureChange } from "../discord/setupDiscord.js";
import { applyPlannedFileOperations, type PlannedFileOperation } from "./plannedFileOperations.js";
import { jsonEqual } from "./configDiff.js";
import type { ConfigSection, GuildConfigEditSession } from "./GuildConfigEditSession.js";

export interface ConfigEditTransactionOptions {
  session: GuildConfigEditSession;
  configManager: Pick<GuildConfigManager, "save">;
  backup: () => unknown;
  fileOperations?: PlannedFileOperation[];
  guild?: Guild;
  applyDiscordStructure?: boolean;
  registerCommands?: (config: ServerConfig) => Promise<void>;
  ensureRulesPanel?: (config: ServerConfig) => Promise<void>;
  auditPath?: string;
  actor?: string;
}

export interface ConfigEditTransactionResult {
  applied: boolean;
  reason?: "no-op";
  structureChanges: StructureChange[];
}

export async function applyConfigEditTransaction(
  options: ConfigEditTransactionOptions,
): Promise<ConfigEditTransactionResult> {
  const original = options.session.getOriginal();
  const working = options.session.getWorking();
  if (!options.session.hasChanges() && (options.fileOperations?.length ?? 0) === 0) {
    return { applied: false, reason: "no-op", structureChanges: [] };
  }

  if (options.guild && shouldRunPreflight(options.session.sections(), Boolean(options.applyDiscordStructure))) {
    const preflight = preflightStructurePlan(options.guild, working);
    if (!preflight.ok) {
      throw new Error(`Preflight invalido: ${preflight.errors.join("; ")}`);
    }
  }

  options.backup();
  applyPlannedFileOperations(options.fileOperations ?? []);

  const structureChanges =
    options.applyDiscordStructure && options.guild ? await applyStructurePlan(options.guild, working) : [];
  options.configManager.save(working.guildId, working);

  if (shouldRegisterCommands(original, working)) {
    await options.registerCommands?.(working);
  }
  if (shouldEnsureRulesPanel(original, working, options.session.sections())) {
    await options.ensureRulesPanel?.(working);
  }
  appendAudit(options.auditPath, working.guildId, options.actor ?? "CLI", options.session.sections(), "OK");

  return { applied: true, structureChanges };
}

function shouldRunPreflight(changedSections: ConfigSection[], applyDiscordStructure: boolean): boolean {
  return applyDiscordStructure || changedSections.includes("structure") || changedSections.includes("modules");
}

export function shouldRegisterCommands(original: ServerConfig, working: ServerConfig): boolean {
  return !jsonEqual(original.modules, working.modules);
}

export function shouldEnsureRulesPanel(
  original: ServerConfig,
  working: ServerConfig,
  changedSections: ConfigSection[],
): boolean {
  if (!changedSections.includes("rules")) {
    return false;
  }

  return (
    original.modules.rules !== working.modules.rules ||
    original.rules.enabled !== working.rules.enabled ||
    original.rules.sourcePath !== working.rules.sourcePath ||
    original.rules.version !== working.rules.version
  );
}

function appendAudit(
  auditPath: string | undefined,
  guildId: string,
  actor: string,
  sections: ConfigSection[],
  result: string,
): void {
  if (!auditPath) {
    return;
  }

  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(
    auditPath,
    `${JSON.stringify({ guild_id: guildId, actor, sections, timestamp: new Date().toISOString(), result })}\n`,
    "utf8",
  );
}
