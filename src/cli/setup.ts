import { once } from "node:events";
import { confirm, select } from "@inquirer/prompts";
import { Events } from "discord.js";
import type { Guild } from "discord.js";
import { createDiscordClient } from "../core/discord/client.js";
import { getConfigPath, getDatabasePath } from "../core/config/paths.js";
import { configExists, readServerConfig, writeServerConfig } from "../core/config/configStore.js";
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
import { writeEnvFile } from "../installer/wizard/envWriter.js";
import { formatInstallationTree } from "../utils/formatPlan.js";
import { PersistentMessageRepository } from "../repositories/persistentMessageRepository.js";
import { ensureRulesPanel } from "../services/rulesPanelService.js";
import { registerGuildCommands } from "../commands/register.js";

async function main(): Promise<void> {
  console.log("========================================");
  console.log("      Discord Community Bot Setup");
  console.log("========================================");

  let exit = false;
  while (!exit) {
    const option = await select({
      message: "Seleccione una opcion:",
      choices: [
        { name: "Instalacion inicial", value: "install" },
        { name: "Modificar configuracion", value: "modify" },
        { name: "Crear o modificar estructura Discord", value: "structure" },
        { name: "Validar instalacion", value: "validate" },
        { name: "Crear backup", value: "backup" },
        { name: "Restaurar backup", value: "restore" },
        { name: "Mostrar configuracion", value: "show" },
        { name: "Salir", value: "exit" },
      ],
    });

    if (option === "install" || option === "modify") {
      await runInstall();
    }
    if (option === "structure") {
      await runStructureOnly();
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
      console.log(JSON.stringify(readServerConfig(getConfigPath()), null, 2));
    }
    if (option === "exit") {
      exit = true;
    }
  }
}

async function runInstall(): Promise<void> {
  const { password, input } = await import("@inquirer/prompts");
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

  const guildId = await select({
    message: "Seleccione servidor:",
    choices: guilds.map((guild) => ({ name: guild.name, value: guild.id })),
  });
  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();
  await guild.roles.fetch();

  const config = await buildInstallationConfig(guild);
  const preflight = preflightStructurePlan(guild, config);
  printPreflight(preflight);
  if (!preflight.ok) {
    await client.destroy();
    return;
  }

  console.log("\nSe realizaran los siguientes cambios:\n");
  console.log(formatInstallationTree(config));

  const shouldApply = await confirm({ message: "Aplicar estos cambios?", default: false });
  if (!shouldApply) {
    await client.destroy();
    return;
  }

  if (configExists(getConfigPath())) {
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
  writeServerConfig(getConfigPath(), config);
  const database = await openDatabase(getDatabasePath());
  await registerGuildCommands(token, clientId, config);
  await ensureRulesPanel(client, config, new PersistentMessageRepository(database));
  database.close();
  await client.destroy();

  console.log("\nInstalacion aplicada:");
  for (const change of changes) {
    console.log(`${change.action.toUpperCase()} ${change.resourceType} ${change.name}${change.id ? ` (${change.id})` : ""}`);
  }
  console.log("\nConfiguracion guardada en config/server.json.");
}

async function runStructureOnly(): Promise<void> {
  const env = loadEnv();
  const config = readServerConfig(getConfigPath());
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
  writeServerConfig(getConfigPath(), config);
  await client.destroy();
  console.log(`Cambios procesados: ${changes.length}`);
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
