import { once } from "node:events";
import { confirm, input, password, select } from "@inquirer/prompts";
import { Events } from "discord.js";
import type { Guild } from "discord.js";
import type { ServerConfig } from "../core/config/schema.js";
import { createDiscordClient } from "../core/discord/client.js";
import { GuildConfigManager } from "../core/config/guildConfigManager.js";
import { getDatabasePath } from "../core/config/paths.js";
import { loadEnv } from "../core/config/env.js";
import { openDatabase } from "../core/database/sqlite.js";
import { createBackup, listBackups, restoreBackup } from "../installer/backup/backupService.js";
import {
  applyStructurePlan,
  preflightStructurePlan,
  rollbackCreatedResources,
  StructureApplyError,
  validateBotPermissions,
} from "../installer/discord/setupDiscord.js";
import { buildInstallationConfig } from "../installer/wizard/configFactory.js";
import { readEnvFile, writeEnvFile } from "../installer/wizard/envWriter.js";
import { formatInstallationTree } from "../utils/formatPlan.js";
import { PersistentMessageRepository } from "../repositories/persistentMessageRepository.js";
import { ensureRulesPanel } from "../services/rulesPanelService.js";
import { registerGuildCommands } from "../commands/register.js";

async function main(): Promise<void> {
  const configManager = new GuildConfigManager();
  configManager.migrateLegacyConfig();
  console.log("========================================");
  console.log("      Discord Community Bot Setup");
  console.log("========================================");

  let exit = false;
  while (!exit) {
    const option = await select({
      message: "Seleccione una opcion:",
      choices: [
        { name: "Agregar/configurar servidor Discord", value: "install" },
        { name: "Modificar servidor existente", value: "modify" },
        { name: "Crear o modificar estructura Discord", value: "structure" },
        { name: "Validar servidor", value: "validate" },
        { name: "Mostrar servidores configurados", value: "show" },
        { name: "Crear backup", value: "backup" },
        { name: "Restaurar backup", value: "restore" },
        { name: "Salir", value: "exit" },
      ],
    });

    if (option === "install") {
      await runInstall(configManager, "add");
    }
    if (option === "modify") {
      await runInstall(configManager, "modify");
    }
    if (option === "structure") {
      await runStructureOnly(configManager);
    }
    if (option === "validate") {
      const { runValidation } = await import("./validate.js");
      await runValidation();
    }
    if (option === "backup") {
      const result = createBackup("setup-menu");
      console.log(`Backup creado: ${result.name}`);
    }
    if (option === "restore") {
      await runRestore();
    }
    if (option === "show") {
      showConfiguredGuilds(configManager);
    }
    if (option === "exit") {
      exit = true;
    }
  }
}

async function runInstall(configManager: GuildConfigManager, mode: "add" | "modify"): Promise<void> {
  const token = await password({ message: "Token del bot:", mask: "*" });
  const clientId = await input({ message: "Application / Client ID:" });
  writeEnvFile({ token, clientId });

  const client = createDiscordClient();
  await client.login(token);
  if (!client.isReady()) {
    await once(client, Events.ClientReady);
  }

  console.log("\nConexion Discord correcta.\n");
  const guilds = [...client.guilds.cache.values()];
  if (guilds.length === 0) {
    throw new Error("El bot no esta en ningun servidor Discord.");
  }

  const guildId =
    mode === "modify"
      ? await selectConfiguredGuild(configManager)
      : await select({
          message: "Seleccione servidor:",
          choices: guilds.map((guild) => ({ name: guild.name, value: guild.id })),
        });
  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();
  await guild.roles.fetch();

  const existingConfig = configManager.find(guildId);
  const config = await buildConfigUntilApproved(guild, existingConfig);
  if (!config) {
    await client.destroy();
    return;
  }
  await configureTikTokEnv(config.modules.tiktokAlerts);

  if (existingConfig) {
    createBackup("pre-setup-change");
  }

  const missing = await validateBotPermissions(guild, config);
  if (missing.length > 0) {
    for (const requirement of missing) {
      console.error(`ERROR: falta el permiso "${requirement.name}".`);
      console.error(`El bot necesita este permiso para ${requirement.reason}.`);
    }
    await client.destroy();
    return;
  }

  const changes = await applyStructurePlanSafely(guild, config);
  if (!changes) {
    await client.destroy();
    return;
  }
  configManager.save(config.guildId, config);
  const database = await openDatabase(getDatabasePath());
  await registerGuildCommands(token, clientId, config);
  await ensureRulesPanel(client, config, new PersistentMessageRepository(database));
  database.close();
  await client.destroy();

  console.log("\nInstalacion aplicada:");
  for (const change of changes) {
    console.log(`${change.action.toUpperCase()} ${change.resourceType} ${change.name}${change.id ? ` (${change.id})` : ""}`);
  }
  console.log(`\nConfiguracion guardada en ${configManager.pathFor(config.guildId)}.`);
}

async function configureTikTokEnv(enabled: boolean): Promise<void> {
  if (!enabled) {
    return;
  }

  const current = readEnvFile().values;
  const hasClientKey = Boolean(current.get("TIKTOK_CLIENT_KEY"));
  const hasClientSecret = Boolean(current.get("TIKTOK_CLIENT_SECRET"));
  console.log("\nConfiguracion TikTok:");
  console.log(`Client Key: ${hasClientKey ? "configurado" : "no configurado"}`);
  console.log(`Client Secret: ${hasClientSecret ? "configurado" : "no configurado"}`);
  console.log(`Redirect URI: ${current.get("TIKTOK_REDIRECT_URI") ?? "https://tiktok.linuxred.lat/tiktok/callback"}`);
  console.log(`Callback: ${current.get("TIKTOK_CALLBACK_HOST") ?? "127.0.0.1"}:${current.get("TIKTOK_CALLBACK_PORT") ?? "8787"}`);

  const credentialAction =
    hasClientKey && hasClientSecret
      ? await select<"keep" | "modify">({
          message: "Credenciales TikTok:",
          choices: [
            { name: "Mantener credenciales existentes", value: "keep" },
            { name: "Modificar credenciales", value: "modify" },
          ],
        })
      : "modify";

  const tiktokClientKey =
    credentialAction === "modify"
      ? await input({
          message: "TikTok Client Key:",
          validate: (value) => value.trim().length > 0 || "TikTok Client Key es obligatorio.",
        })
      : undefined;
  const tiktokClientSecret =
    credentialAction === "modify"
      ? await password({
          message: "TikTok Client Secret:",
          mask: "*",
          validate: (value) => value.trim().length > 0 || "TikTok Client Secret es obligatorio.",
        })
      : undefined;
  const tiktokRedirectUri = await input({
    message: "TikTok Redirect URI:",
    default: current.get("TIKTOK_REDIRECT_URI") ?? "https://tiktok.linuxred.lat/tiktok/callback",
    validate(value) {
      try {
        const url = new URL(value);
        return url.protocol === "https:" ? true : "Redirect URI debe ser HTTPS.";
      } catch {
        return "Redirect URI invalida.";
      }
    },
  });
  const tiktokCallbackHost = await input({
    message: "TikTok Callback host:",
    default: current.get("TIKTOK_CALLBACK_HOST") ?? "127.0.0.1",
    validate: (value) => value.trim().length > 0 || "Callback host es obligatorio.",
  });
  const tiktokCallbackPort = Number(
    await input({
      message: "TikTok Callback port:",
      default: current.get("TIKTOK_CALLBACK_PORT") ?? "8787",
      validate(value) {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
          ? true
          : "Puerto invalido.";
      },
    }),
  );

  writeEnvFile({
    ...(tiktokClientKey ? { tiktokClientKey } : {}),
    ...(tiktokClientSecret ? { tiktokClientSecret } : {}),
    tiktokRedirectUri,
    tiktokCallbackHost,
    tiktokCallbackPort,
    ensureTikTokEncryptionKey: true,
  });
}

async function runStructureOnly(configManager: GuildConfigManager): Promise<void> {
  const env = loadEnv();
  const guildId = await selectConfiguredGuild(configManager);
  const config = configManager.get(guildId);
  const client = createDiscordClient();
  await client.login(env.DISCORD_TOKEN);
  if (!client.isReady()) {
    await once(client, Events.ClientReady);
  }
  const guild = await client.guilds.fetch(config.guildId);
  await guild.channels.fetch();
  await guild.roles.fetch();

  const preflight = preflightStructurePlan(guild, config);
  printPreflight(preflight);
  if (!preflight.ok) {
    await client.destroy();
    return;
  }

  console.log(formatInstallationTree(config));
  const shouldApply = await confirm({ message: "Aplicar/reparar estructura faltante?", default: false });
  if (!shouldApply) {
    await client.destroy();
    return;
  }

  createBackup("pre-structure-change");
  const changes = await applyStructurePlanSafely(guild, config);
  if (!changes) {
    await client.destroy();
    return;
  }
  configManager.save(config.guildId, config);
  await client.destroy();
  console.log(`Cambios procesados: ${changes.length}`);
}

async function selectConfiguredGuild(configManager: GuildConfigManager): Promise<string> {
  const configs = configManager.list();
  if (configs.length === 0) {
    throw new Error("No hay servidores configurados.");
  }

  return select({
    message: "Seleccione servidor configurado:",
    choices: configs.map((config) => ({ name: `${config.communityName} (${config.guildId})`, value: config.guildId })),
  });
}

function showConfiguredGuilds(configManager: GuildConfigManager): void {
  const configs = configManager.list();
  if (configs.length === 0) {
    console.log("No hay servidores configurados.");
    return;
  }

  for (const config of configs) {
    console.log(`${config.communityName} (${config.guildId}) - ${configManager.pathFor(config.guildId)}`);
  }
}

async function buildConfigUntilApproved(
  guild: Guild,
  existingConfig?: ServerConfig,
): Promise<Awaited<ReturnType<typeof buildInstallationConfig>> | undefined> {
  let retry = true;

  while (retry) {
    const config = await buildInstallationConfig(guild, existingConfig);
    const preflight = preflightStructurePlan(guild, config);
    printPreflight(preflight);
    if (!preflight.ok) {
      const action = await select<"modify" | "cancel">({
        message: "La configuracion tiene errores. Que desea hacer?",
        choices: [
          { name: "Modificar estructura", value: "modify" },
          { name: "Cancelar instalacion", value: "cancel" },
        ],
      });
      if (action === "cancel") {
        return undefined;
      }
      continue;
    }

    console.log("\nSe aplicara la siguiente estructura:\n");
    console.log(formatInstallationTree(config));

    const action = await select<"apply" | "modify" | "cancel">({
      message: "Aplicar esta configuracion?",
      choices: [
        { name: "Aplicar configuracion", value: "apply" },
        { name: "Modificar estructura", value: "modify" },
        { name: "Cancelar instalacion", value: "cancel" },
      ],
    });

    if (action === "apply") {
      return config;
    }

    if (action === "cancel") {
      return undefined;
    }

    retry = true;
  }

  return undefined;
}

function printPreflight(result: Awaited<ReturnType<typeof preflightStructurePlan>>): void {
  for (const warning of result.warnings) {
    console.warn(`[WARN] ${warning}`);
  }

  for (const error of result.errors) {
    console.error(`[ERROR] ${error}`);
  }

  if (!result.ok) {
    console.error("No se aplico ningun cambio.");
  }
}

async function applyStructurePlanSafely(
  guild: Guild,
  config: Parameters<typeof applyStructurePlan>[1],
): Promise<Awaited<ReturnType<typeof applyStructurePlan>> | undefined> {
  try {
    return await applyStructurePlan(guild, config);
  } catch (error) {
    if (!(error instanceof StructureApplyError)) {
      throw error;
    }

    console.error("\nLa instalacion no pudo completarse.");
    if (error.createdResources.length > 0) {
      console.error("\nRecursos creados durante esta ejecucion:");
      for (const resource of error.createdResources) {
        console.error(`- ${resource.resourceType} ${resource.name}${resource.id ? ` (${resource.id})` : ""}`);
      }

      const shouldRollback = await confirm({
        message: "Revertir solamente los recursos creados en esta ejecucion?",
        default: false,
      });
      if (shouldRollback) {
        const reverted = await rollbackCreatedResources(guild, error.createdResources);
        console.log(`Recursos revertidos: ${reverted.length}`);
      }
    } else {
      console.error("No se crearon recursos antes del fallo.");
    }

    return undefined;
  }
}

async function runRestore(): Promise<void> {
  const backups = listBackups();
  if (backups.length === 0) {
    console.log("No hay backups disponibles.");
    return;
  }

  const selected = await select({
    message: "Backup seleccionado:",
    choices: backups.map((backup) => ({ name: backup, value: backup })),
  });

  console.log(`\nIncluye configuracion, reglas y base de datos cuando existan.`);
  console.log("No incluye token Discord ni .env.\n");
  const shouldRestore = await confirm({ message: "Restaurar?", default: false });
  if (!shouldRestore) {
    return;
  }

  const result = restoreBackup(selected);
  console.log(`Backup restaurado: ${result.name}`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Error desconocido en setup.");
  process.exit(1);
});
