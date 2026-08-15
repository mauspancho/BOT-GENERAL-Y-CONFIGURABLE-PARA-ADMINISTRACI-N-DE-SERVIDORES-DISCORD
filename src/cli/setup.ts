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
import { GuildConfigEditSession } from "../installer/configEdit/GuildConfigEditSession.js";
import { formatConfigDiff } from "../installer/configEdit/configDiff.js";
import {
  applyConfigEditTransaction,
  shouldEnsureRulesPanel,
  shouldRegisterCommands,
} from "../installer/configEdit/setupTransaction.js";
import type { PlannedFileOperation } from "../installer/configEdit/plannedFileOperations.js";
import {
  patchCommunityName,
  patchGeneralAlerts,
  patchManagedRulesContent,
  patchRulesBehavior,
  patchRulesExternalPath,
  patchRulesImport,
  patchTheIsleGuide,
  patchTikTokAlerts,
  patchWelcome,
  patchCategoryName,
  patchChannel,
  ensureLogicalChannel,
} from "../installer/configEdit/sectionPatches.js";
import { isManagedRulesPath, readRulesForDisplay } from "../installer/configEdit/rulesStorage.js";
import { readServerConfig } from "../core/config/configStore.js";
import {
  canKeepTikTokDeveloperCredentials,
  hasValidTikTokEncryptionKey,
} from "../installer/configEdit/tiktokDeveloperSetup.js";

async function main(): Promise<void> {
  const configManager = new GuildConfigManager();
  await resolveLegacyConflict(configManager);
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
        { name: "Configurar integracion TikTok Developer", value: "tiktok-developer" },
        { name: "Crear o modificar estructura Discord", value: "structure" },
        { name: "Validar servidores", value: "validate" },
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
      await runModifyServer(configManager);
    }
    if (option === "tiktok-developer") {
      await configureTikTokDeveloperGlobal();
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
  const result = await buildConfigUntilApproved(guild, existingConfig);
  if (!result) {
    await client.destroy();
    return;
  }
  const { config, fileOperations } = result;
  const pendingFileOperations = [...fileOperations];
  if (config.modules.tiktokAlerts) {
    pendingFileOperations.push(...(await collectTikTokDeveloperFileOperations()));
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

  createBackup("pre-setup-change");
  const { applyPlannedFileOperations } = await import("../installer/configEdit/plannedFileOperations.js");
  applyPlannedFileOperations(pendingFileOperations);
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

async function configureTikTokDeveloperGlobal(): Promise<void> {
  const fileOperations = await collectTikTokDeveloperFileOperations();
  if (fileOperations.length === 0) {
    console.log("No hay cambios para aplicar.");
    return;
  }

  const shouldApply = await confirm({ message: "Aplicar cambios de TikTok Developer?", default: false });
  if (!shouldApply) {
    console.log("Cancelado. No se aplico ningun cambio.");
    return;
  }

  createBackup("pre-tiktok-developer-change");
  const { applyPlannedFileOperations } = await import("../installer/configEdit/plannedFileOperations.js");
  applyPlannedFileOperations(fileOperations);
  console.log("Integracion TikTok Developer actualizada.");
}

async function collectTikTokDeveloperFileOperations(): Promise<PlannedFileOperation[]> {
  const current = readEnvFile().values;
  printTikTokDeveloperStatus(current);
  const values: Record<string, string> = {};

  const action = await select<"keep" | "modify">({
    message: "Credenciales TikTok Developer:",
    choices: canKeepTikTokDeveloperCredentials(current)
      ? [
          { name: "Mantener credenciales existentes", value: "keep" },
          { name: "Modificar credenciales", value: "modify" },
        ]
      : [{ name: "Configurar credenciales", value: "modify" }],
  });

  if (action === "modify") {
    values.TIKTOK_CLIENT_KEY = await input({
      message: "TikTok Client Key:",
      default: current.get("TIKTOK_CLIENT_KEY"),
      validate: (value) => value.trim().length > 0 || "TikTok Client Key es obligatorio.",
    });
    values.TIKTOK_CLIENT_SECRET = await password({
      message: "TikTok Client Secret:",
      mask: "*",
      validate: (value) => value.trim().length > 0 || "TikTok Client Secret es obligatorio.",
    });
  }

  values.TIKTOK_REDIRECT_URI = await input({
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
  values.TIKTOK_CALLBACK_HOST = await input({
    message: "TikTok Callback host:",
    default: current.get("TIKTOK_CALLBACK_HOST") ?? "127.0.0.1",
    validate: (value) => value.trim().length > 0 || "Callback host es obligatorio.",
  });
  values.TIKTOK_CALLBACK_PORT = await input({
    message: "TikTok Callback port:",
    default: current.get("TIKTOK_CALLBACK_PORT") ?? "8787",
    validate(value) {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? true : "Puerto invalido.";
    },
  });

  return [{ type: "patchEnv", envPath: ".env", values, ensureTikTokEncryptionKey: true }];
}

function printTikTokDeveloperStatus(current: Map<string, string>): void {
  console.log("\nTikTok Developer");
  console.log(`Client Key: ${current.has("TIKTOK_CLIENT_KEY") ? "configurado" : "no configurado"}`);
  console.log(`Client Secret: ${current.has("TIKTOK_CLIENT_SECRET") ? "configurado" : "no configurado"}`);
  console.log(`Redirect URI: ${current.get("TIKTOK_REDIRECT_URI") ?? "https://tiktok.linuxred.lat/tiktok/callback"}`);
  console.log(`Callback: ${current.get("TIKTOK_CALLBACK_HOST") ?? "127.0.0.1"}:${current.get("TIKTOK_CALLBACK_PORT") ?? "8787"}`);
  console.log(`Encryption Key: ${hasValidTikTokEncryptionKey(current) ? "configurada" : "no configurada"}\n`);
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

async function runModifyServer(configManager: GuildConfigManager): Promise<void> {
  const guildId = await selectConfiguredGuild(configManager);
  const originalConfig = configManager.get(guildId);
  const session = new GuildConfigEditSession(originalConfig);
  const fileOperations: PlannedFileOperation[] = [];
  let applyDiscordStructure = false;
  let done = false;

  while (!done) {
    const action = await select({
      message: `Modificar servidor: ${session.getWorking().communityName}`,
      choices: [
        { name: "Modulos", value: "modules" },
        { name: "Alertas al canal general", value: "general-alerts" },
        { name: "TikTok Alerts", value: "tiktok-alerts" },
        { name: "Reglas", value: "rules" },
        { name: "Bienvenida", value: "welcome" },
        { name: "The Isle Guide", value: "the-isle" },
        { name: "Estructura Discord", value: "structure" },
        { name: "Nombre de comunidad", value: "community-name" },
        { name: "Mostrar configuracion", value: "show" },
        { name: "Aplicar cambios", value: "apply" },
        { name: "Volver", value: "back" },
      ],
    });

    if (action === "modules") {
      applyDiscordStructure = (await editModules(session)) || applyDiscordStructure;
    }
    if (action === "general-alerts") {
      await editGeneralAlerts(session);
    }
    if (action === "tiktok-alerts") {
      const tiktokFileOps = await editTikTokAlerts(session);
      fileOperations.push(...tiktokFileOps);
    }
    if (action === "rules") {
      fileOperations.push(...(await editRules(session)));
    }
    if (action === "welcome") {
      await editWelcome(session);
    }
    if (action === "the-isle") {
      await editTheIsleGuide(session);
    }
    if (action === "structure") {
      await editStructure(session);
      applyDiscordStructure = true;
    }
    if (action === "community-name") {
      await editCommunityName(session);
    }
    if (action === "show") {
      console.log(JSON.stringify(session.getWorking(), null, 2));
    }
    if (action === "apply") {
      await applyModifySession(configManager, session, fileOperations, applyDiscordStructure);
      done = true;
    }
    if (action === "back") {
      session.discard();
      console.log("Cancelado. No se aplico ningun cambio.");
      done = true;
    }
  }
}

async function editModules(session: GuildConfigEditSession): Promise<boolean> {
  const config = session.getWorking();
  const selectedModules = await import("@inquirer/prompts").then(({ checkbox }) =>
    checkbox({
      message: "Modulos activos:",
      choices: [
        { name: "Bienvenida", value: "welcome", checked: config.modules.welcome },
        { name: "Reglas", value: "rules", checked: config.modules.rules },
        { name: "Logs", value: "logs", checked: config.modules.logs },
        { name: "Alertas al canal general", value: "generalAlerts", checked: config.modules.generalAlerts },
        { name: "Alertas automaticas de TikTok", value: "tiktokAlerts", checked: config.modules.tiktokAlerts },
        { name: "Self-roles", value: "selfRoles", checked: config.modules.selfRoles },
        { name: "Anuncios", value: "announcements", checked: config.modules.announcements },
        { name: "Tickets", value: "tickets", checked: config.modules.tickets },
        { name: "Sugerencias", value: "suggestions", checked: config.modules.suggestions },
        { name: "Moderacion", value: "moderation", checked: config.modules.moderation },
        { name: "The Isle Evrima Guide", value: "theIsleGuide", checked: config.modules.theIsleGuide },
      ],
    }),
  );
  const selected = new Set<string>(selectedModules);
  for (const key of Object.keys(config.modules) as Array<keyof typeof config.modules>) {
    config.modules[key] = selected.has(key);
  }
  config.rules.enabled = config.modules.rules;
  config.tiktokAlerts.enabled = config.modules.tiktokAlerts;
  config.theIsleGuide.enabled = config.modules.theIsleGuide;
  session.markChanged("modules");
  return false;
}

async function editGeneralAlerts(session: GuildConfigEditSession): Promise<void> {
  const enabled = await confirm({ message: "Activar alertas al canal general?", default: session.getWorking().modules.generalAlerts });
  patchGeneralAlerts(session.getWorking(), enabled);
  session.markChanged("generalAlerts");
}

async function editTikTokAlerts(session: GuildConfigEditSession): Promise<PlannedFileOperation[]> {
  const config = session.getWorking();
  const currentEnv = readEnvFile().values;
  console.log("\nTikTok Alerts");
  console.log(`Estado del modulo: ${config.modules.tiktokAlerts ? "activo" : "inactivo"}`);
  console.log("Cuenta conectada: consultar con /tiktok estado");
  console.log(`Polling: ${config.tiktokAlerts.pollingIntervalSeconds}`);
  console.log(`Mencion: ${config.tiktokAlerts.mention}`);
  printTikTokDeveloperStatus(currentEnv);

  const action = await select<"enable" | "disable" | "polling" | "mention" | "status" | "back">({
    message: "TikTok Alerts:",
    choices: [
      { name: "Activar modulo", value: "enable" },
      { name: "Desactivar modulo", value: "disable" },
      { name: "Cambiar polling", value: "polling" },
      { name: "Cambiar mencion", value: "mention" },
      { name: "Mostrar estado", value: "status" },
      { name: "Volver", value: "back" },
    ],
  });

  if (action === "back" || action === "status") {
    return [];
  }

  const fileOperations: PlannedFileOperation[] = [];
  if (action === "enable") {
    const hasDeveloperCredentials = currentEnv.has("TIKTOK_CLIENT_KEY") && currentEnv.has("TIKTOK_CLIENT_SECRET");
    if (!hasDeveloperCredentials) {
      console.log("El modulo TikTok Alerts esta habilitado para este servidor, pero la integracion TikTok Developer todavia no esta configurada.");
      const credentialAction = await select<"configure" | "disabled" | "cancel">({
        message: "Que desea hacer?",
        choices: [
          { name: "Configurar TikTok Developer ahora", value: "configure" },
          { name: "Mantener modulo desactivado", value: "disabled" },
          { name: "Cancelar", value: "cancel" },
        ],
      });
      if (credentialAction === "cancel" || credentialAction === "disabled") {
        return [];
      }
      fileOperations.push(...(await collectTikTokDeveloperFileOperations()));
    }
    patchTikTokAlerts(config, { enabled: true });
  }
  if (action === "disable") {
    patchTikTokAlerts(config, { enabled: false });
  }
  if (action === "polling") {
    const pollingIntervalSeconds = Number(
      await input({
        message: "Intervalo de comprobacion TikTok (segundos):",
        default: String(config.tiktokAlerts.pollingIntervalSeconds),
        validate(value) {
          const parsed = Number(value);
          return Number.isInteger(parsed) && parsed >= 60 ? true : "Use un entero de al menos 60 segundos.";
        },
      }),
    );
    patchTikTokAlerts(config, { pollingIntervalSeconds });
  }
  if (action === "mention") {
    const mention = await select<ServerConfig["tiktokAlerts"]["mention"]>({
      message: "Mencion por defecto TikTok:",
      choices: [
        { name: "ninguna", value: "ninguna" },
        { name: "everyone", value: "everyone" },
        { name: "here", value: "here" },
      ],
      default: config.tiktokAlerts.mention,
    });
    patchTikTokAlerts(config, { mention });
  }
  session.markChanged("tiktokAlerts");
  return fileOperations;
}

async function editRules(session: GuildConfigEditSession): Promise<PlannedFileOperation[]> {
  const config = session.getWorking();
  console.log("\nReglas actuales");
  console.log(`Estado: ${config.rules.enabled ? "activo" : "inactivo"}`);
  console.log(`Ruta: ${config.rules.sourcePath}`);
  console.log(`Version: ${config.rules.version}`);
  console.log(`Reaceptacion: ${config.rules.requireReacceptOnRulesChange}`);
  console.log(`Accion al rechazar: ${config.rules.rejectAction}`);

  const action = await select<"keep" | "external" | "import" | "edit" | "reject" | "reaccept" | "disable" | "back">({
    message: "Reglas:",
    choices: [
      { name: "Mantener sin cambios", value: "keep" },
      { name: "Usar archivo externo", value: "external" },
      { name: "Importar archivo al almacenamiento del guild", value: "import" },
      { name: "Editar reglas administradas", value: "edit" },
      { name: "Cambiar comportamiento de rechazo", value: "reject" },
      { name: "Cambiar reaceptacion", value: "reaccept" },
      { name: "Desactivar reglas", value: "disable" },
      { name: "Volver", value: "back" },
    ],
  });

  if (action === "keep" || action === "back") {
    return [];
  }
  if (action === "external") {
    const sourcePath = await input({ message: "Ruta del archivo externo de reglas:" });
    patchRulesExternalPath(config, sourcePath);
    session.markChanged("rules");
    return [];
  }
  if (action === "import") {
    const sourcePath = await input({ message: "Ruta del archivo a importar:" });
    const result = patchRulesImport(config, sourcePath);
    session.markChanged("rules");
    return result.fileOperations;
  }
  if (action === "edit") {
    if (!isManagedRulesPath(config.guildId, config.rules.sourcePath)) {
      console.log("La ruta actual es externa. No se editara silenciosamente; importela primero al almacenamiento del guild.");
      return [];
    }
    const currentContent = readRulesForDisplay(config.rules.sourcePath) ?? "# Reglas\n";
    const content = await import("@inquirer/prompts").then(({ editor }) =>
      editor({ message: "Editar reglas administradas:", default: currentContent }),
    );
    const result = patchManagedRulesContent(config, content);
    session.markChanged("rules");
    return result.fileOperations;
  }
  if (action === "reject") {
    const rejectAction = await select<ServerConfig["rules"]["rejectAction"]>({
      message: "Que ocurre si un usuario rechaza las reglas?",
      choices: [
        { name: "Mostrar advertencia", value: "warn" },
        { name: "No realizar ninguna accion", value: "none" },
        { name: "Expulsar del servidor", value: "kick" },
        { name: "Mantener rol pendiente", value: "keep_pending" },
      ],
    });
    patchRulesBehavior(config, { rejectAction });
  }
  if (action === "reaccept") {
    const requireReacceptOnRulesChange = await confirm({
      message: "Requerir reaceptacion cuando cambien las reglas?",
      default: config.rules.requireReacceptOnRulesChange,
    });
    patchRulesBehavior(config, { requireReacceptOnRulesChange });
  }
  if (action === "disable") {
    patchRulesBehavior(config, { enabled: false });
  }
  session.markChanged("rules");
  return [];
}

async function editWelcome(session: GuildConfigEditSession): Promise<void> {
  const config = session.getWorking();
  const channelEnabled = await confirm({ message: "Enviar bienvenida en canal?", default: config.welcome.channelEnabled });
  const dmEnabled = await confirm({ message: "Enviar bienvenida por DM?", default: config.welcome.dmEnabled });
  const message = await input({ message: "Mensaje de bienvenida:", default: config.welcome.message });
  patchWelcome(config, { channelEnabled, dmEnabled, message });
  session.markChanged("welcome");
}

async function editTheIsleGuide(session: GuildConfigEditSession): Promise<void> {
  const config = session.getWorking();
  const action = await select<"disable" | "path" | "back">({
    message: "The Isle Guide:",
    choices: [
      { name: "Desactivar modulo", value: "disable" },
      { name: "Cambiar ruta", value: "path" },
      { name: "Volver", value: "back" },
    ],
  });
  if (action === "back") {
    return;
  }
  if (action === "disable") {
    patchTheIsleGuide(config, { enabled: false });
  }
  if (action === "path") {
    const sourcePath = await input({ message: "Ruta del archivo The Isle:", default: config.theIsleGuide.sourcePath });
    patchTheIsleGuide(config, { enabled: true, sourcePath });
  }
  session.markChanged("theIsleGuide");
}

async function editStructure(session: GuildConfigEditSession): Promise<void> {
  const config = session.getWorking();
  console.log(formatInstallationTree(config));
  const action = await select<"category" | "channel" | "add-channel" | "back">({
    message: "Estructura Discord:",
    choices: [
      { name: "Modificar categoria", value: "category" },
      { name: "Modificar canal", value: "channel" },
      { name: "Agregar canal logico", value: "add-channel" },
      { name: "Volver", value: "back" },
    ],
  });
  if (action === "back") {
    return;
  }
  if (action === "category") {
    const key = await select({
      message: "Categoria:",
      choices: Object.entries(config.categories).map(([key, category]) => ({ name: `${key}: ${category.name}`, value: key })),
    });
    const name = await input({ message: "Nombre:", default: config.categories[key]?.name });
    patchCategoryName(config, key, name);
  }
  if (action === "channel") {
    const key = await select({
      message: "Canal:",
      choices: Object.entries(config.channels).map(([key, channel]) => ({ name: `${key}: ${channel.name} (${channel.id ?? "sin id"})`, value: key })),
    });
    const current = config.channels[key]!;
    const name = await input({ message: "Nombre:", default: current.name });
    patchChannel(config, key, { name });
  }
  if (action === "add-channel") {
    const key = await input({ message: "Clave logica del canal:" });
    const name = await input({ message: "Nombre del canal:" });
    ensureLogicalChannel(config, key, { name, function: "custom" });
  }
  session.markChanged("structure");
}

async function editCommunityName(session: GuildConfigEditSession): Promise<void> {
  const communityName = await input({ message: "Nombre de la comunidad:", default: session.getWorking().communityName });
  patchCommunityName(session.getWorking(), communityName);
  session.markChanged("communityName");
}

async function applyModifySession(
  configManager: GuildConfigManager,
  session: GuildConfigEditSession,
  fileOperations: PlannedFileOperation[],
  applyDiscordStructure: boolean,
): Promise<void> {
  if (!session.hasChanges() && fileOperations.length === 0) {
    console.log("No hay cambios para aplicar.");
    return;
  }

  console.log("\nCAMBIOS PROPUESTOS\n");
  console.log(formatConfigDiff(session.getOriginal(), session.getWorking()));
  const shouldApply = await confirm({ message: "Aplicar estos cambios?", default: false });
  if (!shouldApply) {
    session.discard();
    console.log("Cancelado. No se aplico ningun cambio.");
    return;
  }

  const needsDiscord = applyDiscordStructure || shouldRegisterCommands(session.getOriginal(), session.getWorking()) || shouldEnsureRulesPanel(session.getOriginal(), session.getWorking(), session.sections());
  const env = needsDiscord ? loadEnv() : undefined;
  const client = needsDiscord ? createDiscordClient() : undefined;
  const guild = client ? await loginAndFetchGuild(client, env!.DISCORD_TOKEN, session.guildId) : undefined;
  const database = needsDiscord ? await openDatabase(getDatabasePath()) : undefined;

  const result = await applyConfigEditTransaction({
    session,
    configManager,
    backup: () => createBackup("pre-config-edit"),
    fileOperations,
    applyDiscordStructure,
    auditPath: "logs/setup-audit.jsonl",
    env: buildPrecheckEnv(fileOperations),
    ...(guild ? { guild } : {}),
    ...(env ? { registerCommands: (config: ServerConfig) => registerGuildCommands(env.DISCORD_TOKEN, env.DISCORD_CLIENT_ID, config) } : {}),
    ...(client && database
      ? { ensureRulesPanel: (config: ServerConfig) => ensureRulesPanel(client, config, new PersistentMessageRepository(database)) }
      : {}),
  });

  database?.close();
  await client?.destroy();
  console.log(result.applied ? "Cambios aplicados." : "No hay cambios para aplicar.");
}

function buildPrecheckEnv(fileOperations: PlannedFileOperation[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const operation of fileOperations) {
    if (operation.type !== "patchEnv") {
      continue;
    }
    Object.assign(env, operation.values);
    if (operation.ensureTikTokEncryptionKey && !hasValidTikTokEncryptionKey(new Map(Object.entries(env) as Array<[string, string]>))) {
      env.TIKTOK_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    }
  }
  return env;
}

async function loginAndFetchGuild(client: ReturnType<typeof createDiscordClient>, token: string, guildId: string) {
  await client.login(token);
  if (!client.isReady()) {
    await once(client, Events.ClientReady);
  }
  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();
  await guild.roles.fetch();
  return guild;
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

async function resolveLegacyConflict(configManager: GuildConfigManager): Promise<void> {
  const conflict = configManager.findLegacyConflict();
  if (!conflict) {
    return;
  }

  let resolved = false;
  while (!resolved) {
    const action = await select<"compare" | "multi" | "legacy" | "cancel">({
      message: "Se encontraron dos configuraciones para este servidor:",
      choices: [
        { name: "Comparar", value: "compare" },
        { name: "Usar configuracion multi-guild actual", value: "multi" },
        { name: "Importar/restaurar legacy", value: "legacy" },
        { name: "Cancelar", value: "cancel" },
      ],
    });

    if (action === "compare") {
      const legacy = readServerConfig(conflict.legacyPath);
      const current = readServerConfig(conflict.guildPath);
      console.log(formatConfigDiff(current, legacy));
      continue;
    }

    if (action === "multi") {
      console.log("Se mantiene la configuracion multi-guild actual.");
      resolved = true;
      continue;
    }

    if (action === "legacy") {
      const shouldImport = await confirm({ message: "Crear backup e importar legacy sobre la config multi-guild?", default: false });
      if (!shouldImport) {
        continue;
      }
      createBackup("pre-legacy-import");
      configManager.importLegacyConfig(conflict.guildId);
      console.log("Config legacy importada.");
      resolved = true;
      continue;
    }

    throw new Error("Setup cancelado por conflicto legacy/multi-guild.");
  }
}

async function buildConfigUntilApproved(
  guild: Guild,
  existingConfig?: ServerConfig,
): Promise<Awaited<ReturnType<typeof buildInstallationConfig>> | undefined> {
  let retry = true;

  while (retry) {
    const result = await buildInstallationConfig(guild, existingConfig);
    const preflight = preflightStructurePlan(guild, result.config);
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
    console.log(formatInstallationTree(result.config));

    const action = await select<"apply" | "modify" | "cancel">({
      message: "Aplicar esta configuracion?",
      choices: [
        { name: "Aplicar configuracion", value: "apply" },
        { name: "Modificar estructura", value: "modify" },
        { name: "Cancelar instalacion", value: "cancel" },
      ],
    });

    if (action === "apply") {
      return result;
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
