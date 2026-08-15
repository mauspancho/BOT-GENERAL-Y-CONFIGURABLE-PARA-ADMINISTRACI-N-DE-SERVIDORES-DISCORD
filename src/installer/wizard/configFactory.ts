import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { ChannelType } from "discord.js";
import type { Guild } from "discord.js";
import {
  CONFIG_VERSION,
  createDefaultModules,
  type ChannelConfig,
  type RoleConfig,
  type ServerConfig,
} from "../../core/config/schema.js";
import { listReusableChannels, listReusableRoles, makeRole } from "../discord/setupDiscord.js";
import { applyInventoryToConfig, scanGuildInventory } from "../discord/guildInventory.js";
import { buildCustomInstallationStructure } from "./categoryWizard.js";
import { configureRules } from "./rulesWizard.js";
import { ensureAutomaticInfrastructure, type StructureConfig } from "./installationPlan.js";
import type { PlannedFileOperation } from "../configEdit/plannedFileOperations.js";
import {
  createTheIsleGuideConfig,
  LEGACY_THE_ISLE_GUIDE_SOURCE_PATH,
  validateTheIsleGuideSourcePath,
  type TheIsleGuideValidationSummary,
} from "../../modules/theIsleGuide/theIsleGuideConfig.js";

type ResourceMode = "create" | "existing" | "disabled";

export interface InstallationConfigResult {
  config: ServerConfig;
  fileOperations: PlannedFileOperation[];
}

export async function buildInstallationConfig(guild: Guild, existingConfig?: ServerConfig): Promise<InstallationConfigResult> {
  const communityName = await input({
    message: "Nombre de la comunidad:",
    default: guild.name,
  });

  const installMode = await select({
    message: "Tipo de instalacion",
    choices: [
      { name: "Instalacion rapida", value: "quick" },
      { name: "Instalacion personalizada", value: "custom" },
    ],
  });

  const modules = { ...createDefaultModules(), ...existingConfig?.modules };
  const selectedModules = await checkbox({
    message: "Modulos activos:",
    choices: [
      { name: "Bienvenida", value: "welcome", checked: modules.welcome },
      { name: "Reglas", value: "rules", checked: modules.rules },
      { name: "Logs", value: "logs", checked: modules.logs },
      { name: "Alertas al canal general", value: "generalAlerts", checked: modules.generalAlerts },
      { name: "Alertas automaticas de TikTok", value: "tiktokAlerts", checked: modules.tiktokAlerts },
      { name: "Self-roles (base Fase 2)", value: "selfRoles", checked: modules.selfRoles },
      { name: "Anuncios", value: "announcements", checked: modules.announcements },
      { name: "Tickets (base Fase 2)", value: "tickets", checked: modules.tickets },
      { name: "Sugerencias (base Fase 2)", value: "suggestions", checked: modules.suggestions },
      { name: "Moderacion (base Fase 2)", value: "moderation", checked: modules.moderation },
      { name: "The Isle Evrima Guide", value: "theIsleGuide", checked: modules.theIsleGuide },
    ],
  });

  const selectedModuleSet = new Set<string>(selectedModules);
  for (const key of Object.keys(modules) as Array<keyof typeof modules>) {
    modules[key] = selectedModuleSet.has(key);
  }

  const theIsleGuide = await configureTheIsleGuide(modules, existingConfig?.theIsleGuide.sourcePath);
  const tiktokAlerts = await configureTikTokAlerts(modules, existingConfig?.tiktokAlerts);

  const base =
    installMode === "quick"
      ? await quickConfig(guild, communityName, modules, theIsleGuide.sourcePath)
      : await buildCustomInstallationStructure(guild, communityName, modules);

  const rulesPlan = modules.rules ? await configureRules(guild.id) : undefined;
  const welcome = {
    channelEnabled: modules.welcome
      ? await confirm({ message: "Enviar bienvenida en canal?", default: true })
      : false,
    dmEnabled: modules.welcome
      ? await confirm({ message: "Enviar bienvenida por DM?", default: false })
      : false,
    message: modules.welcome
      ? await input({
          message: "Mensaje de bienvenida:",
          default: "Bienvenido {user} a {server}!",
        })
      : "Bienvenido {user} a {server}!",
  };

  const rejectAction = modules.rules
    ? await select({
        message: "Que ocurre si un usuario rechaza las reglas?",
        choices: [
          { name: "Mostrar advertencia", value: "warn" },
          { name: "No realizar ninguna accion", value: "none" },
          { name: "Expulsar del servidor", value: "kick" },
          { name: "Mantener rol pendiente", value: "keep_pending" },
        ],
      })
    : "warn";

  return {
    config: {
    ...base,
    welcome,
    rules: {
      enabled: modules.rules,
      sourcePath: rulesPlan?.sourcePath ?? `./data/guilds/${guild.id}/rules.md`,
      version: 1,
      requireReacceptOnRulesChange: false,
      rejectAction,
    },
    theIsleGuide,
    tiktokAlerts,
    },
    fileOperations: rulesPlan?.fileOperations ?? [],
  };
}

async function quickConfig(
  guild: Guild,
  communityName: string,
  modules: ServerConfig["modules"],
  theIsleGuideSourcePath: string | undefined,
): Promise<Omit<ServerConfig, "welcome" | "rules">> {
  const promptValues: QuickInstallPromptValues = {
    informationCategory: needsInformationCategory(modules)
      ? await input({ message: "Categoria informacion:", default: "INFORMACION" })
      : "INFORMACION",
    communityCategory: await input({ message: "Categoria comunidad:", default: "COMUNIDAD" }),
    administrationCategory: "ADMINISTRACION",
    welcomeChannel: modules.welcome
      ? await input({ message: "Canal bienvenida:", default: "bienvenida" })
      : "bienvenida",
    rulesChannel: modules.rules ? await input({ message: "Canal reglas:", default: "reglas" }) : "reglas",
    announcementsChannel: modules.announcements
      ? await input({ message: "Canal anuncios:", default: "anuncios" })
      : "anuncios",
    selfRolesChannel: modules.selfRoles
      ? await input({ message: "Canal roles:", default: "roles" })
      : "roles",
    generalChannel: await input({ message: "Canal general:", default: "general" }),
    logsChannel: "logs",
    theIsleGuideChannel: modules.theIsleGuide
      ? await input({ message: "Canal guia The Isle:", default: "mutaciones" })
      : "mutaciones",
    theIsleGuideSourcePath,
    pendingRole: modules.rules
      ? await input({ message: "Rol pendiente:", default: "Sin verificar" })
      : "Sin verificar",
    memberRole: modules.rules ? await input({ message: "Rol miembro:", default: "Miembro" }) : "Miembro",
  };

  const config = createQuickInstallConfig(guild.id, communityName, modules, promptValues);
  ensureAutomaticInfrastructure(config);
  const inventoryResult = applyInventoryToConfig(config, scanGuildInventory(guild));
  printInventorySummary(inventoryResult);

  await maybeReuseResources(guild, config);
  return config;
}

export interface QuickInstallPromptValues {
  informationCategory: string;
  communityCategory: string;
  administrationCategory: string;
  welcomeChannel: string;
  rulesChannel: string;
  announcementsChannel: string;
  selfRolesChannel: string;
  generalChannel: string;
  logsChannel: string;
  theIsleGuideChannel: string;
  theIsleGuideSourcePath?: string | undefined;
  pendingRole: string;
  memberRole: string;
}

export function createQuickInstallConfig(
  guildId: string,
  communityName: string,
  modules: ServerConfig["modules"],
  values: QuickInstallPromptValues,
): Omit<ServerConfig, "welcome" | "rules"> {
  const categories: Record<string, { name: string; id?: string }> = {};
  const channels: Record<string, ChannelConfig> = {
    general: {
      name: values.generalChannel,
      type: "text",
      categoryKey: "community",
      function: "general",
      readOnlyForMembers: false,
    },
  };
  const roles: Record<string, RoleConfig> = {};

  if (needsInformationCategory(modules)) {
    categories.information = { name: values.informationCategory };
  }

  categories.community = { name: values.communityCategory };

  if (modules.welcome) {
    channels.welcome = {
      name: values.welcomeChannel,
      type: "text",
      categoryKey: "information",
      function: "welcome",
      readOnlyForMembers: true,
    };
  }

  if (modules.rules) {
    channels.rules = {
      name: values.rulesChannel,
      type: "text",
      categoryKey: "information",
      function: "rules",
      readOnlyForMembers: true,
    };
    roles.pending = makeRole(values.pendingRole);
    roles.member = makeRole(values.memberRole);
  }

  if (modules.announcements) {
    channels.announcements = {
      name: values.announcementsChannel,
      type: "text",
      categoryKey: "information",
      function: "announcements",
      readOnlyForMembers: true,
    };
  }

  if (modules.selfRoles) {
    channels.roles = {
      name: values.selfRolesChannel,
      type: "text",
      categoryKey: "information",
      function: "roles",
      readOnlyForMembers: true,
    };
  }

  if (modules.theIsleGuide) {
    channels.theIsleGuide = {
      name: values.theIsleGuideChannel,
      type: "text",
      categoryKey: "information",
      function: "theIsleGuide",
      readOnlyForMembers: true,
    };
  }

  const config: StructureConfig = {
    version: CONFIG_VERSION,
    guildId,
    communityName,
    locale: "es",
    categories,
    channels,
    roles,
    modules,
    theIsleGuide: createTheIsleGuideConfig(modules, values.theIsleGuideSourcePath),
    tiktokAlerts: defaultTikTokAlertsConfig(modules.tiktokAlerts),
  };
  ensureAutomaticInfrastructure(config);
  return config;
}

export async function configureTikTokAlerts(
  modules: ServerConfig["modules"],
  currentConfig?: ServerConfig["tiktokAlerts"],
): Promise<ServerConfig["tiktokAlerts"]> {
  if (!modules.tiktokAlerts) {
    return defaultTikTokAlertsConfig(false);
  }

  if (currentConfig?.enabled) {
    console.log("\nConfiguracion TikTok actual:");
    console.log(`  Polling: ${currentConfig.pollingIntervalSeconds} segundos`);
    console.log(`  Mencion: ${currentConfig.mention}`);
    const action = await select<"keep" | "modify" | "disable">({
      message: "Configuracion TikTok Alerts:",
      choices: [
        { name: "Mantener", value: "keep" },
        { name: "Modificar", value: "modify" },
        { name: "Desactivar modulo", value: "disable" },
      ],
    });

    if (action === "keep") {
      return currentConfig;
    }

    if (action === "disable") {
      modules.tiktokAlerts = false;
      return defaultTikTokAlertsConfig(false);
    }
  }

  const pollingIntervalSeconds = Number(
    await input({
      message: "Intervalo de comprobacion TikTok (segundos):",
      default: String(currentConfig?.pollingIntervalSeconds ?? 300),
      validate(value) {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= 60 ? true : "Use un entero de al menos 60 segundos.";
      },
    }),
  );
  const mention = await select<ServerConfig["tiktokAlerts"]["mention"]>({
    message: "Mencion por defecto TikTok:",
    choices: [
      { name: "ninguna", value: "ninguna" },
      { name: "everyone", value: "everyone" },
      { name: "here", value: "here" },
    ],
    default: currentConfig?.mention ?? "ninguna",
  });

  return {
    enabled: true,
    pollingIntervalSeconds,
    mention,
  };
}

function defaultTikTokAlertsConfig(enabled: boolean): ServerConfig["tiktokAlerts"] {
  return {
    enabled,
    pollingIntervalSeconds: 300,
    mention: "ninguna",
  };
}

export async function configureTheIsleGuide(
  modules: ServerConfig["modules"],
  currentSourcePath?: string,
): Promise<ServerConfig["theIsleGuide"]> {
  if (!modules.theIsleGuide) {
    return { enabled: false };
  }

  if (currentSourcePath) {
    console.log("\nRuta actual The Isle:");
    console.log(`  ${currentSourcePath}`);
    const action = await select<"keep" | "change" | "disable">({
      message: "Configuracion The Isle Guide:",
      choices: [
        { name: "Mantener ruta actual", value: "keep" },
        { name: "Cambiar ruta", value: "change" },
        { name: "Desactivar modulo", value: "disable" },
      ],
    });

    if (action === "keep") {
      try {
        validateTheIsleGuideSourcePath(currentSourcePath);
        return { enabled: true, sourcePath: currentSourcePath };
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Ruta The Isle actual invalida.");
        console.error("Seleccione una ruta valida para continuar.");
      }
    }

    if (action === "disable") {
      modules.theIsleGuide = false;
      return { enabled: false };
    }
  }

  return askForTheIsleGuideSourcePath(currentSourcePath ?? LEGACY_THE_ISLE_GUIDE_SOURCE_PATH);
}

async function askForTheIsleGuideSourcePath(defaultPath: string): Promise<ServerConfig["theIsleGuide"]> {
  while (true) {
    const sourcePath = await input({
      message: "Ruta del archivo de dinosaurios:",
      default: defaultPath,
      validate(value) {
        try {
          validateTheIsleGuideSourcePath(value);
          return true;
        } catch (error) {
          return error instanceof Error ? error.message : "Archivo The Isle invalido.";
        }
      },
    });

    const summary = validateTheIsleGuideSourcePath(sourcePath);
    printTheIsleGuideValidationSummary(summary);

    const action = await select<"use" | "change" | "cancel">({
      message: "Usar este archivo?",
      choices: [
        { name: "Si", value: "use" },
        { name: "Cambiar ruta", value: "change" },
        { name: "Cancelar", value: "cancel" },
      ],
    });

    if (action === "use") {
      return { enabled: true, sourcePath: summary.sourcePath };
    }

    if (action === "cancel") {
      throw new Error("Configuracion The Isle cancelada.");
    }
  }
}

function printTheIsleGuideValidationSummary(summary: TheIsleGuideValidationSummary): void {
  console.log("\nArchivo valido.");
  console.log("\nRuta:");
  console.log(`  ${summary.sourcePath}`);
  console.log("\nRuta resuelta:");
  console.log(`  ${summary.resolvedPath}`);
  console.log("\nVersion Evrima:");
  console.log(`  ${summary.data.gameVersion}`);
  console.log("\nEspecies encontradas:");
  console.log(`  ${summary.totalSpecies}`);
  console.log("\nEspecies activas:");
  console.log(`  ${summary.activeSpecies}`);
  console.log("\nCarnivoros:");
  console.log(`  ${summary.countsByType.carnivore}`);
  console.log("\nHerbivoros:");
  console.log(`  ${summary.countsByType.herbivore}`);
  console.log("\nOmnivoros:");
  console.log(`  ${summary.countsByType.omnivore}\n`);
}

function needsInformationCategory(modules: ServerConfig["modules"]): boolean {
  return modules.welcome || modules.rules || modules.announcements || modules.selfRoles || modules.theIsleGuide;
}

async function maybeReuseResources(guild: Guild, config: Omit<ServerConfig, "welcome" | "rules">): Promise<void> {
  for (const [key, category] of Object.entries(config.categories)) {
    if (category.id) {
      console.log(`REUSED category ${category.name} (${category.id})`);
      continue;
    }
    if (key === "administration" && config.modules.logs) {
      continue;
    }
    const mode = await select<ResourceMode>({
      message: `Categoria "${category.name}"`,
      choices: [
        { name: "Crear nueva categoria", value: "create" },
        { name: "Utilizar categoria existente", value: "existing" },
      ],
    });
    if (mode === "existing") {
      const categories = [...guild.channels.cache.values()].filter(
        (channel) => channel.type === ChannelType.GuildCategory,
      );
      const selected = await select({
        message: "Seleccione categoria:",
        choices: categories.map((channel) => ({ name: channel.name, value: channel.id })),
      });
      const selectedCategory = categories.find((categoryOption) => categoryOption.id === selected);
      config.categories[key] = { name: selectedCategory?.name ?? category.name, id: selected };
    }
  }

  for (const [key, channel] of Object.entries(config.channels)) {
    if (channel.id) {
      console.log(`REUSED channel #${channel.name} (${channel.id})`);
      continue;
    }
    if (channel.function === "logs") {
      continue;
    }
    const mode = await select<ResourceMode>({
      message: `Canal "${channel.name}" (${channel.function})`,
      choices: [
        { name: "Crear nuevo canal", value: "create" },
        { name: "Utilizar canal existente", value: "existing" },
      ],
    });
    if (mode === "existing") {
      const channels = listReusableChannels(guild).filter(
        (channelOption) => channelOption.type !== ChannelType.GuildCategory,
      );
      const selected = await select({
        message: "Seleccione canal:",
        choices: channels.map((channelOption) => ({ name: `#${channelOption.name}`, value: channelOption.id })),
      });
      const selectedChannel = channels.find((channelOption) => channelOption.id === selected);
      config.channels[key] = { ...channel, name: selectedChannel?.name ?? channel.name, id: selected };
    }
  }

  for (const [key, role] of Object.entries(config.roles)) {
    if (!role.enabled) {
      continue;
    }
    if (role.id) {
      console.log(`REUSED role ${role.name} (${role.id})`);
      continue;
    }
    const mode = await select<ResourceMode>({
      message: `Rol "${role.name}"`,
      choices: [
        { name: "Crear nuevo rol", value: "create" },
        { name: "Utilizar rol existente", value: "existing" },
        { name: "Desactivar este rol", value: "disabled" },
      ],
    });
    if (mode === "existing") {
      const roles = listReusableRoles(guild);
      const selected = await select({
        message: "Seleccione rol:",
        choices: roles.map((roleOption) => ({ name: roleOption.name, value: roleOption.id })),
      });
      const selectedRole = roles.find((roleOption) => roleOption.id === selected);
      config.roles[key] = { ...role, name: selectedRole?.name ?? role.name, id: selected };
    }
    if (mode === "disabled") {
      config.roles[key] = { ...role, enabled: false };
    }
  }
}

function printInventorySummary(result: ReturnType<typeof applyInventoryToConfig>): void {
  for (const reused of result.reused) {
    console.log(`Detectado y reutilizado: ${reused}`);
  }
  for (const ambiguous of result.ambiguous) {
    console.log(`Coincidencia ambigua, requiere seleccion manual: ${ambiguous}`);
  }
}
