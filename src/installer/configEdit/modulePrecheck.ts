import type { ServerConfig } from "../../core/config/schema.js";
import { hasTikTokCredentials } from "../../modules/tiktokAlerts/tiktokEnv.js";

export function validateModuleDependencies(config: ServerConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const errors: string[] = [];

  if (config.modules.generalAlerts && !config.channels.general?.id) {
    errors.push("generalAlerts requiere config.channels.general.id.");
  }

  if (config.modules.tiktokAlerts) {
    if (!config.modules.generalAlerts) {
      errors.push("tiktokAlerts requiere modules.generalAlerts=true.");
    }
    if (!config.channels.general?.id) {
      errors.push("tiktokAlerts requiere config.channels.general.id.");
    }
    if (!hasTikTokCredentials(env)) {
      errors.push("tiktokAlerts requiere credenciales TikTok Developer completas y TIKTOK_TOKEN_ENCRYPTION_KEY valida.");
    }
  }

  return errors;
}
