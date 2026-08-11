import fs from "node:fs";
import { ConfigurationError } from "../../core/errors/AppError.js";
import { slugifyName } from "../../installer/wizard/installationPlan.js";
import { dinosaurTypes, type DinosaurSpecies, type DinosaurType, type TheIsleGuideData } from "./theIsleTypes.js";

export function loadTheIsleGuideFile(path: string): TheIsleGuideData {
  if (!fs.existsSync(path)) {
    throw new ConfigurationError(`No existe el archivo The Isle: ${path}`);
  }

  return parseTheIsleGuideMarkdown(fs.readFileSync(path, "utf8"));
}

export function parseTheIsleGuideMarkdown(markdown: string): TheIsleGuideData {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const version = readMetadata(normalized, "version");
  const updated = readMetadata(normalized, "updated");
  const sources = readMetadata(normalized, "sources", false);

  if (!version) {
    throw new ConfigurationError("Falta metadata version en dinosaurs.md.");
  }
  if (!updated) {
    throw new ConfigurationError("Falta metadata updated en dinosaurs.md.");
  }

  const speciesSections = splitSpeciesSections(normalized);
  if (speciesSections.length === 0) {
    throw new ConfigurationError("dinosaurs.md no contiene especies con encabezado ##.");
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  const species = speciesSections.map((section) => {
    const parsed = parseSpeciesSection(section);
    if (ids.has(parsed.id)) {
      throw new ConfigurationError(`ID de especie duplicado: ${parsed.id}`);
    }
    if (names.has(parsed.name.toLowerCase())) {
      throw new ConfigurationError(`Especie duplicada: ${parsed.name}`);
    }
    ids.add(parsed.id);
    names.add(parsed.name.toLowerCase());
    return parsed;
  });

  return {
    gameVersion: version,
    updatedAt: updated,
    ...(sources ? { sources } : {}),
    species,
  };
}

export function enabledSpecies(data: TheIsleGuideData): DinosaurSpecies[] {
  return data.species.filter((species) => species.enabled);
}

function splitSpeciesSections(markdown: string): string[] {
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? markdown.length;
    return markdown.slice(start, end).trim();
  });
}

function parseSpeciesSection(section: string): DinosaurSpecies {
  const nameMatch = section.match(/^##\s+(.+)$/m);
  const name = nameMatch?.[1]?.trim();
  if (!name) {
    throw new ConfigurationError("Hay una especie sin nombre.");
  }

  const id = slugifyName(name);
  if (!id) {
    throw new ConfigurationError(`No se pudo generar ID para la especie: ${name}`);
  }

  const type = readMetadata(section, "type") as DinosaurType | undefined;
  if (!type || !dinosaurTypes.includes(type)) {
    throw new ConfigurationError(`Tipo invalido para ${name}: ${type ?? "sin tipo"}`);
  }

  const enabledRaw = readMetadata(section, "enabled") ?? "true";
  const enabled = enabledRaw.toLowerCase() === "true";
  const recommendedMutations = readListSection(section, "Build recomendada");
  if (enabled && recommendedMutations.length === 0) {
    throw new ConfigurationError(`La build recomendada de ${name} esta vacia.`);
  }

  return {
    id,
    name,
    type,
    enabled,
    recommendedMutations,
    alternatives: readListSection(section, "Alternativas"),
    description: readTextSection(section, "Descripcion") || readTextSection(section, "Descripción"),
    notes: readTextSection(section, "Notas"),
  };
}

function readMetadata(markdown: string, key: string, required = true): string | undefined {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.+)$`, "im"));
  const value = match?.[1]?.trim();
  if (required && !value) {
    throw new ConfigurationError(`Falta metadata ${key}.`);
  }
  return value;
}

function readListSection(markdown: string, heading: string): string[] {
  return readSection(markdown, heading)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function readTextSection(markdown: string, heading: string): string {
  return readSection(markdown, heading)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("###"))
    .join("\n")
    .trim();
}

function readSection(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`^###\\s+${escaped}\\s*$`, "im"));
  if (!match || match.index === undefined) {
    return "";
  }

  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^###\s+|^---$/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}
