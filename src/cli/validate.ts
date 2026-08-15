import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { ChannelType, Events, type Guild, type GuildBasedChannel } from "discord.js";
import { z } from "zod";
import { envSchema } from "../core/config/env.js";
import { GuildConfigManager } from "../core/config/guildConfigManager.js";
import { getDatabasePath } from "../core/config/paths.js";
import type { ServerConfig } from "../core/config/schema.js";
import { openDatabase } from "../core/database/sqlite.js";
import { createDiscordClient } from "../core/discord/client.js";
import {
  guildSupportsAnnouncementChannels,
  toDiscordChannelType,
  validateBotPermissions,
} from "../installer/discord/setupDiscord.js";
import { loadRulesFile } from "../services/rulesContentService.js";
import {
  isTheIsleGuideEnabled,
  loadConfiguredTheIsleGuideFile,
  resolveTheIsleGuidePath,
} from "../modules/theIsleGuide/theIsleGuideConfig.js";
import { loadTikTokRuntimeConfig } from "../modules/tiktokAlerts/tiktokEnv.js";

interface Check {
  name: string;
  ok: boolean;
  message?: string | undefined;
  action?: string | undefined;
}

export async function runValidation(): Promise<Check[]> {
  const checks: Check[] = [];
  console.log("Discord Community Bot - Validation\n");

  const envParsed = envSchema.safeParse(process.env);
  checks.push({
    name: "Environment",
    ok: envParsed.success,
    message: envParsed.success ? undefined : z.prettifyError(envParsed.error),
    action: "Revise .env y .env.example.",
  });

  let configs: ServerConfig[] = [];
  try {
    const configManager = new GuildConfigManager();
    configManager.migrateLegacyConfig();
    configs = configManager.list();
    checks.push({
      name: "Configuration",
      ok: configs.length > 0,
      message: configs.length > 0 ? `${configs.length} servidor(es) configurado(s).` : "No hay servidores configurados.",
      action: configs.length > 0 ? undefined : "Run: npm run setup",
    });
  } catch (error) {
    checks.push({
      name: "Configuration",
      ok: false,
      message: error instanceof Error ? error.message : "Configuracion invalida.",
      action: "Run: npm run setup",
    });
  }

  try {
    const database = await openDatabase(getDatabasePath());
    database.close();
    checks.push({ name: "Database", ok: true });
  } catch (error) {
    checks.push({
      name: "Database",
      ok: false,
      message: error instanceof Error ? error.message : "SQLite no disponible.",
    });
  }

  for (const config of configs) {
    if (config.rules.enabled) {
      try {
        loadRulesFile(config.rules.sourcePath);
        checks.push({ name: `Rules file ${config.guildId}`, ok: true });
      } catch (error) {
        checks.push({
          name: `Rules file ${config.guildId}`,
          ok: false,
          message: error instanceof Error ? error.message : "Archivo de reglas invalido.",
          action: "Run: npm run setup",
        });
      }
    }

    if (isTheIsleGuideEnabled(config)) {
      try {
        loadConfiguredTheIsleGuideFile(config);
        checks.push({ name: `The Isle guide file ${config.guildId}`, ok: true, message: resolveTheIsleGuidePath(config) });
      } catch (error) {
        checks.push({
          name: `The Isle guide file ${config.guildId}`,
          ok: false,
          message: error instanceof Error ? error.message : "Archivo The Isle invalido.",
          action: "Run: npm run setup",
        });
      }
    }

    if (config.modules.tiktokAlerts) {
      try {
        loadTikTokRuntimeConfig();
        checks.push({ name: `TikTok credentials ${config.guildId}`, ok: true, message: "Client Secret: configurado" });
      } catch (error) {
        checks.push({
          name: `TikTok credentials ${config.guildId}`,
          ok: false,
          message: error instanceof Error ? error.message : "Configuracion TikTok invalida.",
          action: "Run: npm run setup",
        });
      }

      checks.push({
        name: `TikTok generalAlerts dependency ${config.guildId}`,
        ok: config.modules.generalAlerts,
        message: config.modules.generalAlerts ? undefined : "tiktokAlerts requiere generalAlerts activo.",
        action: config.modules.generalAlerts ? undefined : "Run: npm run setup",
      });
      checks.push({
        name: `TikTok general channel ${config.guildId}`,
        ok: Boolean(config.channels.general?.id),
        message: config.channels.general?.id ? undefined : "Falta config.channels.general.id.",
        action: "Run: npm run setup",
      });
    }
  }

  if (envParsed.success && configs.length > 0) {
    const client = createDiscordClient();
    try {
      await client.login(envParsed.data.DISCORD_TOKEN);
      if (!client.isReady()) {
        await once(client, Events.ClientReady);
      }

      checks.push({ name: "Discord token", ok: true });
      for (const config of configs) {
        const guild = await client.guilds.fetch(config.guildId);
        checks.push({ name: `Guild ${config.guildId}`, ok: true });
        await guild.channels.fetch();
        await guild.roles.fetch();

        for (const [key, category] of Object.entries(config.categories)) {
          const exists = category.id ? await guild.channels.fetch(category.id).catch(() => null) : null;
          const isCategory = Boolean(exists && !exists.isThread() && exists.type === ChannelType.GuildCategory);
          checks.push({
            name: `Category ${config.guildId}/${key}`,
            ok: isCategory,
            message: isCategory ? undefined : `Categoria ${category.id ?? category.name} no existe o no es una categoria.`,
            action: "Run: npm run setup",
          });
        }

        for (const [key, channel] of Object.entries(config.channels)) {
          const exists = channel.id ? await guild.channels.fetch(channel.id).catch(() => null) : null;
          const validType = channelMatchesConfigType(guild, exists, channel.type);
          checks.push({
            name: `Channel ${config.guildId}/${key}`,
            ok: validType,
            message: validType ? undefined : `Canal ${channel.id ?? channel.name} no existe o no es de tipo ${channel.type}.`,
            action: "Run: npm run setup",
          });
        }

        for (const [key, role] of Object.entries(config.roles)) {
          if (!role.enabled) {
            continue;
          }
          const exists = role.id ? await guild.roles.fetch(role.id).catch(() => null) : null;
          checks.push({
            name: `Role ${config.guildId}/${key}`,
            ok: Boolean(exists),
            message: exists ? undefined : `Rol ${role.id ?? role.name} no existe.`,
            action: "Run: npm run setup",
          });
        }

        const missing = await validateBotPermissions(guild, config);
        checks.push({
          name: `Permissions ${config.guildId}`,
          ok: missing.length === 0,
          message: missing.map((permission) => permission.name).join(", "),
          action: missing.length > 0 ? "Ajuste permisos del bot en Discord." : undefined,
        });
      }
    } catch (error) {
      checks.push({
        name: "Discord connectivity",
        ok: false,
        message: error instanceof Error ? error.message : "No se pudo conectar a Discord.",
      });
    } finally {
      await client.destroy();
    }
  }

  for (const check of checks) {
    console.log(`[${check.ok ? "OK" : "ERROR"}] ${check.name}${check.message ? ` - ${check.message}` : ""}`);
    if (!check.ok && check.action) {
      console.log(`[ACTION] ${check.action}`);
    }
  }

  console.log(checks.every((check) => check.ok) ? "\nValidation successful." : "\nValidation failed.");
  return checks;
}

function channelMatchesConfigType(
  guild: Guild,
  channel: GuildBasedChannel | null,
  expectedType: ServerConfig["channels"][string]["type"],
): boolean {
  if (!channel || channel.isThread()) {
    return false;
  }
  return channel.type === toDiscordChannelType(expectedType, guildSupportsAnnouncementChannels(guild));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidation();
}
