import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeTextFileAtomic } from "../../core/config/configStore.js";

export interface EnvFileValues {
  token?: string;
  clientId?: string;
  tiktokClientKey?: string;
  tiktokClientSecret?: string;
  tiktokRedirectUri?: string;
  tiktokCallbackHost?: string;
  tiktokCallbackPort?: number;
  ensureTikTokEncryptionKey?: boolean;
  ensureRuntimeDefaults?: boolean;
}

export function writeEnvFile(values: EnvFileValues, envPath = path.resolve(process.cwd(), ".env")): void {
  const existing = readEnvFile(envPath);
  const next = new Map(existing.values);

  setManagedValue(next, "DISCORD_TOKEN", values.token);
  setManagedValue(next, "DISCORD_CLIENT_ID", values.clientId);
  const shouldEnsureRuntimeDefaults = values.ensureRuntimeDefaults ?? Boolean(values.token || values.clientId);
  if (shouldEnsureRuntimeDefaults) {
    if (!next.has("NODE_ENV")) {
      next.set("NODE_ENV", "production");
    }
    if (!next.has("CONFIG_PATH")) {
      next.set("CONFIG_PATH", "./config/server.json");
    }
    if (!next.has("DATABASE_PATH")) {
      next.set("DATABASE_PATH", "./data/bot.sqlite");
    }
    if (!next.has("LOG_LEVEL")) {
      next.set("LOG_LEVEL", "info");
    }
  }

  setManagedValue(next, "TIKTOK_CLIENT_KEY", values.tiktokClientKey);
  setManagedValue(next, "TIKTOK_CLIENT_SECRET", values.tiktokClientSecret);
  setManagedValue(next, "TIKTOK_REDIRECT_URI", values.tiktokRedirectUri);
  setManagedValue(next, "TIKTOK_CALLBACK_HOST", values.tiktokCallbackHost);
  setManagedValue(next, "TIKTOK_CALLBACK_PORT", values.tiktokCallbackPort?.toString());
  if (values.ensureTikTokEncryptionKey && !next.has("TIKTOK_TOKEN_ENCRYPTION_KEY")) {
    next.set("TIKTOK_TOKEN_ENCRYPTION_KEY", crypto.randomBytes(32).toString("base64"));
  }

  writeTextFileAtomic(envPath, serializeEnvFile(existing.order, next));
}

export function readEnvFile(envPath = path.resolve(process.cwd(), ".env")): {
  values: Map<string, string>;
  order: string[];
} {
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
    const value = trimmed.slice(index + 1);
    if (key) {
      values.set(key, value);
      order.push(key);
    }
  }

  return { values, order };
}

function setManagedValue(values: Map<string, string>, key: string, value: string | undefined): void {
  if (value === undefined) {
    return;
  }

  values.set(key, value);
}

function serializeEnvFile(order: string[], values: Map<string, string>): string {
  const keys = [...order];
  for (const key of values.keys()) {
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }

  return `${keys.map((key) => `${key}=${values.get(key) ?? ""}`).join("\n")}\n`;
}
