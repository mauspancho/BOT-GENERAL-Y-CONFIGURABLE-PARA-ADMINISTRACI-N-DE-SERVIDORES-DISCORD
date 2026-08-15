import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeTextFileAtomic } from "../../core/config/configStore.js";

export type PlannedFileOperation =
  | { type: "writeText"; path: string; content: string }
  | { type: "copyFile"; sourcePath: string; targetPath: string }
  | { type: "patchEnv"; envPath: string; values: Record<string, string>; ensureTikTokEncryptionKey?: boolean };

interface FileSnapshot {
  path: string;
  existed: boolean;
  content?: Buffer;
}

export function applyPlannedFileOperations(operations: PlannedFileOperation[]): () => void {
  const snapshots = captureSnapshots(operations);
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
  return () => restoreSnapshots(snapshots);
}

function applyEnvPatch(operation: Extract<PlannedFileOperation, { type: "patchEnv" }>): void {
  const existing = readEnv(operation.envPath);
  const next = new Map(existing.values);
  for (const [key, value] of Object.entries(operation.values)) {
    next.set(key, value);
  }
  if (operation.ensureTikTokEncryptionKey && !hasValidEncryptionKey(next.get("TIKTOK_TOKEN_ENCRYPTION_KEY"))) {
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

function captureSnapshots(operations: PlannedFileOperation[]): FileSnapshot[] {
  const targets = new Set<string>();
  for (const operation of operations) {
    if (operation.type === "writeText") {
      targets.add(operation.path);
    }
    if (operation.type === "copyFile") {
      targets.add(operation.targetPath);
    }
    if (operation.type === "patchEnv") {
      targets.add(operation.envPath);
    }
  }

  return [...targets].map((targetPath) => ({
    path: targetPath,
    existed: fs.existsSync(targetPath),
    ...(fs.existsSync(targetPath) ? { content: fs.readFileSync(targetPath) } : {}),
  }));
}

function restoreSnapshots(snapshots: FileSnapshot[]): void {
  for (const snapshot of [...snapshots].reverse()) {
    if (!snapshot.existed) {
      fs.rmSync(snapshot.path, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(snapshot.path), { recursive: true });
    fs.writeFileSync(snapshot.path, snapshot.content ?? Buffer.alloc(0));
  }
}

function hasValidEncryptionKey(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return Buffer.from(value, "base64").length === 32 || Buffer.from(value, "hex").length === 32;
}
