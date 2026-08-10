import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigurationError } from "../core/errors/AppError.js";

export const DISCORD_MESSAGE_LIMIT = 2000;
export const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;

export function loadRulesFile(sourcePath: string): string {
  if (!fs.existsSync(sourcePath)) {
    throw new ConfigurationError(`El archivo de reglas no existe: ${sourcePath}`);
  }

  const extension = path.extname(sourcePath).toLowerCase();
  if (![".md", ".txt"].includes(extension)) {
    throw new ConfigurationError("Las reglas solo pueden importarse desde archivos .md o .txt.");
  }

  const stat = fs.statSync(sourcePath);
  if (stat.size > 128 * 1024) {
    throw new ConfigurationError("El archivo de reglas supera el limite razonable de 128 KB.");
  }

  return normalizeRules(fs.readFileSync(sourcePath, "utf8"));
}

export function normalizeRules(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

export function hashRules(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function splitDiscordText(content: string, limit = DISCORD_EMBED_DESCRIPTION_LIMIT): string[] {
  const normalized = normalizeRules(content);
  if (normalized.length <= limit) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit + 1);
    const breakPoint = Math.max(
      candidate.lastIndexOf("\n\n"),
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf(" "),
    );
    const splitAt = breakPoint > Math.floor(limit * 0.6) ? breakPoint : limit;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
