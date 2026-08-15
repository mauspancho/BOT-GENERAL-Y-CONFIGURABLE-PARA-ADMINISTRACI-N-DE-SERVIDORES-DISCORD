import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeTextFileAtomic } from "../../core/config/configStore.js";

export type PlannedFileOperation =
  | { type: "writeText"; path: string; content: string }
  | { type: "copyFile"; sourcePath: string; targetPath: string }
  | { type: "patchEnv"; envPath: string; values: Record<string, string>; ensureTikTokEncryptionKey?: boolean };

export function applyPlannedFileOperations(operations: PlannedFileOperation[]): void {
  for (const operation of operations) {
    if (operation.type === "writeText") {
      writeTextFileAtomic(operation.path, operation.content);
      continue;
    }

    if (operation.type === "copyFile") {
      fs.mkdirSync(path.dirname(operation.targetPath), { recursive: true });
      fs.copyFileSync(operation.sourcePath, operation.targetPath);
      continue;
    }

    applyEnvPatch(operation);
  }
}

function applyEnvPatch(operation: Extract<PlannedFileOperation, { type: "patchEnv" }>): void {
  const existing = readEnv(operation.envPath);
  const next = new Map(existing.values);
  for (const [key, value] of Object.entries(operation.values)) {
    next.set(key, value);
  }
  if (operation.ensureTikTokEncryptionKey && !next.has("TIKTOK_TOKEN_ENCRYPTION_KEY")) {
    next.set("TIKTOK_TOKEN_ENCRYPTION_KEY", cryptoRandomBase64());
  }

  writeTextFileAtomic(operation.envPath, serializeEnv(existing.order, next));
}

function readEnv(envPath: string): { values: Map<string, string>; order: string[] } {
  if (!fs.existsSync(envPath)) {
    return { values: new Map(), order: [] };
  }

  const values = new Map<string, string>();
  const order: string[] = [];
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    if (key) {
      values.set(key, trimmed.slice(index + 1));
      order.push(key);
    }
  }
  return { values, order };
}

function serializeEnv(order: string[], values: Map<string, string>): string {
  const keys = [...order];
  for (const key of values.keys()) {
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }

  return `${keys.map((key) => `${key}=${values.get(key) ?? ""}`).join("\n")}\n`;
}

function cryptoRandomBase64(): string {
  return crypto.randomBytes(32).toString("base64");
}
