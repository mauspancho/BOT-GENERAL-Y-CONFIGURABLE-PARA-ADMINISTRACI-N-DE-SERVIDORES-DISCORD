import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { Events } from "discord.js";
import { z } from "zod";
import { envSchema } from "../core/config/env.js";
import { getConfigPath, getDatabasePath } from "../core/config/paths.js";
import { readServerConfig } from "../core/config/configStore.js";
import { openDatabase } from "../core/database/sqlite.js";
import { createDiscordClient } from "../core/discord/client.js";
import { validateBotPermissions } from "../installer/discord/setupDiscord.js";
import { loadRulesFile } from "../services/rulesContentService.js";
import {
  isTheIsleGuideEnabled,
  loadConfiguredTheIsleGuideFile,
  resolveTheIsleGuidePath,
} from "../modules/theIsleGuide/theIsleGuideConfig.js";

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

  let config: ReturnType<typeof readServerConfig> | undefined;
  try {
    config = readServerConfig(getConfigPath());
    checks.push({ name: "Configuration", ok: true });
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

  if (config?.rules.enabled) {
    try {
      loadRulesFile(config.rules.sourcePath);
      checks.push({ name: "Rules file", ok: true });
    } catch (error) {
      checks.push({
        name: "Rules file",
        ok: false,
        message: error instanceof Error ? error.message : "Archivo de reglas invalido.",
        action: "Run: npm run setup",
      });
    }
  }

  if (config && isTheIsleGuideEnabled(config)) {
    try {
      loadConfiguredTheIsleGuideFile(config);
      checks.push({ name: "The Isle guide file", ok: true, message: resolveTheIsleGuidePath(config) });
    } catch (error) {
      checks.push({
        name: "The Isle guide file",
        ok: false,
        message: error instanceof Error ? error.message : "Archivo The Isle invalido.",
        action: "Run: npm run setup",
      });
    }
  }

  if (envParsed.success && config) {
    const client = createDiscordClient();
    try {
      await client.login(envParsed.data.DISCORD_TOKEN);
      if (!client.isReady()) {
        await once(client, Events.ClientReady);
      }

      checks.push({ name: "Discord token", ok: true });
      const guild = await client.guilds.fetch(config.guildId);
      checks.push({ name: "Guild", ok: true });
      await guild.channels.fetch();
      await guild.roles.fetch();

      for (const [key, category] of Object.entries(config.categories)) {
        const exists = category.id ? await guild.channels.fetch(category.id).catch(() => null) : null;
        checks.push({
          name: `Category ${key}`,
          ok: Boolean(exists),
          message: exists ? undefined : `Categoria ${category.id ?? category.name} no existe.`,
          action: "Run: npm run setup",
        });
      }

      for (const [key, channel] of Object.entries(config.channels)) {
        const exists = channel.id ? await guild.channels.fetch(channel.id).catch(() => null) : null;
        checks.push({
          name: `Channel ${key}`,
          ok: Boolean(exists),
          message: exists ? undefined : `Canal ${channel.id ?? channel.name} no existe.`,
          action: "Run: npm run setup",
        });
      }

      for (const [key, role] of Object.entries(config.roles)) {
        if (!role.enabled) {
          continue;
        }
        const exists = role.id ? await guild.roles.fetch(role.id).catch(() => null) : null;
        checks.push({
          name: `Role ${key}`,
          ok: Boolean(exists),
          message: exists ? undefined : `Rol ${role.id ?? role.name} no existe.`,
          action: "Run: npm run setup",
        });
      }

      const missing = await validateBotPermissions(guild, config);
      checks.push({
        name: "Permissions",
        ok: missing.length === 0,
        message: missing.map((permission) => permission.name).join(", "),
        action: missing.length > 0 ? "Ajuste permisos del bot en Discord." : undefined,
      });
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runValidation();
}
