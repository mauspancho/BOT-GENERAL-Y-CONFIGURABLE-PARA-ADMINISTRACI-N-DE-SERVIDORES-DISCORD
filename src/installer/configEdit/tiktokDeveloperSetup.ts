import { parseEncryptionKey } from "../../modules/tiktokAlerts/tiktokEnv.js";

export function canKeepTikTokDeveloperCredentials(current: Map<string, string>): boolean {
  return Boolean(current.get("TIKTOK_CLIENT_KEY") && current.get("TIKTOK_CLIENT_SECRET"));
}

export function hasValidTikTokEncryptionKey(current: Map<string, string>): boolean {
  const value = current.get("TIKTOK_TOKEN_ENCRYPTION_KEY");
  if (!value) {
    return false;
  }
  try {
    parseEncryptionKey(value);
    return true;
  } catch {
    return false;
  }
}
