import fs from "node:fs";
import path from "node:path";
import type { ServerConfig, TheIsleGuideConfig } from "../../core/config/schema.js";
import { resolveFromRoot } from "../../core/config/paths.js";
import { ConfigurationError } from "../../core/errors/AppError.js";
import { dinosaurTypes, type DinosaurType, type TheIsleGuideData } from "./theIsleTypes.js";
import { loadTheIsleGuideFile } from "./theIsleParser.js";

export const LEGACY_THE_ISLE_GUIDE_SOURCE_PATH = "./data/the-isle/dinosaurs.md";
const allowedExtensions = new Set([".md", ".markdown"]);

export interface TheIsleGuideValidationSummary {
  sourcePath: string;
  resolvedPath: string;
  data: TheIsleGuideData;
  totalSpecies: number;
  activeSpecies: number;
  countsByType: Record<DinosaurType, number>;
}

export function isTheIsleGuideEnabled(config: Pick<ServerConfig, "modules" | "theIsleGuide">): boolean {
  return config.modules.theIsleGuide && (config.theIsleGuide.enabled ?? true);
}

export function createTheIsleGuideConfig(
  modules: ServerConfig["modules"],
  sourcePath?: string,
): TheIsleGuideConfig {
  if (!modules.theIsleGuide) {
    return { enabled: false };
  }

  if (!sourcePath?.trim()) {
    throw new ConfigurationError("The Isle Guide esta activo, pero falta theIsleGuide.sourcePath.");
  }

  return {
    enabled: true,
    sourcePath: sourcePath.trim(),
  };
}

export function getTheIsleGuideSourcePath(config: Pick<ServerConfig, "modules" | "theIsleGuide">): string {
  const configured = config.theIsleGuide.sourcePath?.trim();
  if (configured) {
    return configured;
  }

  if (config.modules.theIsleGuide) {
    return LEGACY_THE_ISLE_GUIDE_SOURCE_PATH;
  }

  throw new ConfigurationError("The Isle Guide esta desactivado y no tiene sourcePath configurado.");
}

export function resolveTheIsleGuidePath(config: Pick<ServerConfig, "modules" | "theIsleGuide">): string {
  return resolveTheIsleGuideSourcePath(getTheIsleGuideSourcePath(config));
}

export function resolveTheIsleGuideSourcePath(sourcePath: string): string {
  return path.isAbsolute(sourcePath) ? sourcePath : resolveFromRoot(sourcePath);
}

export function loadConfiguredTheIsleGuideFile(config: Pick<ServerConfig, "modules" | "theIsleGuide">): TheIsleGuideData {
  return loadTheIsleGuideFile(resolveTheIsleGuidePath(config));
}

export function validateTheIsleGuideSourcePath(sourcePath: string): TheIsleGuideValidationSummary {
  const trimmedPath = sourcePath.trim();
  if (!trimmedPath) {
    throw new ConfigurationError("La ruta del archivo de dinosaurios esta vacia.");
  }

  const resolvedPath = resolveTheIsleGuideSourcePath(trimmedPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new ConfigurationError(`No existe el archivo The Isle: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new ConfigurationError(`La ruta The Isle no es un archivo: ${resolvedPath}`);
  }

  fs.accessSync(resolvedPath, fs.constants.R_OK);

  const extension = path.extname(resolvedPath).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new ConfigurationError(`Extension no permitida para The Isle: ${extension || "sin extension"}. Use .md o .markdown.`);
  }

  const data = loadTheIsleGuideFile(resolvedPath);
  const activeSpecies = data.species.filter((species) => species.enabled);
  const countsByType = dinosaurTypes.reduce(
    (counts, type) => {
      counts[type] = activeSpecies.filter((species) => species.type === type).length;
      return counts;
    },
    { carnivore: 0, herbivore: 0, omnivore: 0 } as Record<DinosaurType, number>,
  );

  return {
    sourcePath: trimmedPath,
    resolvedPath,
    data,
    totalSpecies: data.species.length,
    activeSpecies: activeSpecies.length,
    countsByType,
  };
}
