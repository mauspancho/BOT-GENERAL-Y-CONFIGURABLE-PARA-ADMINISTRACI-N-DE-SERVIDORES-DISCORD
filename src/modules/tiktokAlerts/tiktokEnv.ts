import { ConfigurationError } from "../../core/errors/AppError.js";
import type { TikTokRuntimeConfig } from "./tiktokTypes.js";

export const DEFAULT_TIKTOK_REDIRECT_URI = "https://tiktok.linuxred.lat/tiktok/callback";
export const DEFAULT_TIKTOK_CALLBACK_HOST = "127.0.0.1";
export const DEFAULT_TIKTOK_CALLBACK_PORT = 8787;

export function loadTikTokRuntimeConfig(env: NodeJS.ProcessEnv = process.env): TikTokRuntimeConfig {
  const clientKey = env.TIKTOK_CLIENT_KEY?.trim();
  const clientSecret = env.TIKTOK_CLIENT_SECRET?.trim();
  const redirectUri = env.TIKTOK_REDIRECT_URI?.trim() || DEFAULT_TIKTOK_REDIRECT_URI;
  const callbackHost = env.TIKTOK_CALLBACK_HOST?.trim() || DEFAULT_TIKTOK_CALLBACK_HOST;
  const callbackPort = Number(env.TIKTOK_CALLBACK_PORT ?? DEFAULT_TIKTOK_CALLBACK_PORT);
  const encryptionKeyRaw = env.TIKTOK_TOKEN_ENCRYPTION_KEY?.trim();

  if (!clientKey) {
    throw new ConfigurationError("TikTok Client Key no configurado.");
  }
  if (!clientSecret) {
    throw new ConfigurationError("TikTok Client Secret no configurado.");
  }
  validateRedirectUri(redirectUri);
  if (!callbackHost) {
    throw new ConfigurationError("TikTok callback host no configurado.");
  }
  if (!Number.isInteger(callbackPort) || callbackPort <= 0 || callbackPort > 65_535) {
    throw new ConfigurationError("TikTok callback port invalido.");
  }
  if (!encryptionKeyRaw) {
    throw new ConfigurationError("TIKTOK_TOKEN_ENCRYPTION_KEY no configurada.");
  }

  return {
    clientKey,
    clientSecret,
    redirectUri,
    callbackHost,
    callbackPort,
    encryptionKey: parseEncryptionKey(encryptionKeyRaw),
  };
}

export function hasTikTokCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET || !env.TIKTOK_TOKEN_ENCRYPTION_KEY) {
    return false;
  }
  try {
    parseEncryptionKey(env.TIKTOK_TOKEN_ENCRYPTION_KEY);
    return true;
  } catch {
    return false;
  }
}

export function parseEncryptionKey(value: string): Buffer {
  const base64 = Buffer.from(value, "base64");
  if (base64.length === 32) {
    return base64;
  }

  const hex = Buffer.from(value, "hex");
  if (hex.length === 32) {
    return hex;
  }

  throw new ConfigurationError("TIKTOK_TOKEN_ENCRYPTION_KEY debe tener 32 bytes en base64 o hex.");
}

function validateRedirectUri(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new Error("Redirect URI debe ser HTTPS.");
    }
  } catch (error) {
    throw new ConfigurationError(error instanceof Error ? error.message : "Redirect URI TikTok invalida.");
  }
}
