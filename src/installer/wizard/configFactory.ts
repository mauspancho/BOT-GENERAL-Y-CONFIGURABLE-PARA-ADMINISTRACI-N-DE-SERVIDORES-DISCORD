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
import { configureRules } from "./rulesWizard.js";

type ResourceMode = "create" | "existing" | "disabled";

export async function buildInstallationConfig(guild: Guild): Promise<ServerConfig> {
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

  const modules = createDefaultModules();
  const selectedModules = await checkbox({
    message: "Modulos activos:",
    choices: [
      { name: "Bienvenida", value: "welcome", checked: modules.welcome },
      { name: "Reglas", value: "rules", checked: modules.rules },
      { name: "Logs", value: "logs", checked: modules.logs },
      { name: "Self-roles (base Fase 2)", value: "selfRoles", checked: false },
      { name: "Anuncios", value: "announcements", checked: modules.announcements },
      { name: "Tickets (base Fase 2)", value: "tickets", checked: modules.tickets },
      { name: "Sugerencias (base Fase 2)", value: "suggestions", checked: modules.suggestions },
      { name: "Moderacion (base Fase 2)", value: "moderation", checked: modules.moderation },
    ],
  });

  const selectedModuleSet = new Set<string>(selectedModules);
  for (const key of Object.keys(modules) as Array<keyof typeof modules>) {
    modules[key] = selectedModuleSet.has(key);
  }

  const base =
    installMode === "quick"
      ? await quickConfig(guild, communityName, modules)
      : await customConfig(guild, communityName, modules);

  const rulesPath = modules.rules ? await configureRules() : "./data/rules.md";
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
    ...base,
    welcome,
    rules: {
      enabled: modules.rules,
      sourcePath: rulesPath,
      version: 1,
      requireReacceptOnRulesChange: false,
      rejectAction,
    },
  };
}

async function quickConfig(
  guild: Guild,
  communityName: string,
  modules: ServerConfig["modules"],
): Promise<Omit<ServerConfig, "welcome" | "rules">> {
  const promptValues: QuickInstallPromptValues = {
    informationCategory: needsInformationCategory(modules)
      ? await input({ message: "Categoria informacion:", default: "INFORMACION" })
      : "INFORMACION",
    communityCategory: await input({ message: "Categoria comunidad:", default: "COMUNIDAD" }),
    administrationCategory: modules.logs
      ? await input({ message: "Categoria administracion:", default: "ADMINISTRACION" })
      : "ADMINISTRACION",
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
    logsChannel: modules.logs ? await input({ message: "Canal logs:", default: "logs" }) : "logs",
    pendingRole: modules.rules
      ? await input({ message: "Rol pendiente:", default: "Sin verificar" })
      : "Sin verificar",
    memberRole: modules.rules ? await input({ message: "Rol miembro:", default: "Miembro" }) : "Miembro",
  };

  const config = createQuickInstallConfig(guild.id, communityName, modules, promptValues);

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
  pendingRole: string;
  memberRole: string;
}

export function createQuickInstallConfig(
  guildId: string,
  communityName: string,
  modules: ServerConfig["modules"],
  values: QuickInstallPromptValues,
): Omit<ServerConfig, "welcome" | "rules"> {
  const categories: Record<string, { name: string; id?: string }> = {
    community: { name: values.communityCategory },
  };
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

  if (modules.logs) {
    categories.administration = { name: values.administrationCategory };
  }

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

  if (modules.logs) {
    channels.logs = {
      name: values.logsChannel,
      type: "text",
      categoryKey: "administration",
      function: "logs",
      readOnlyForMembers: true,
    };
  }

  return {
    version: CONFIG_VERSION,
    guildId,
    communityName,
    locale: "es",
    categories,
    channels,
    roles,
    modules,
  };
}

function needsInformationCategory(modules: ServerConfig["modules"]): boolean {
  return modules.welcome || modules.rules || modules.announcements || modules.selfRoles;
}

function rulesNeedVerificationRoles(modules: ServerConfig["modules"]): boolean {
  return modules.rules;
}

function enabledCustomLogicalChannels(modules: ServerConfig["modules"]): Array<ChannelConfig["function"]> {
  const channels: Array<ChannelConfig["function"]> = ["general"];
  if (modules.welcome) {
    channels.push("welcome");
  }
  if (modules.rules) {
    channels.push("rules");
  }
  if (modules.announcements) {
    channels.push("announcements");
  }
  if (modules.selfRoles) {
    channels.push("roles");
  }
  if (modules.tickets) {
    channels.push("tickets");
  }
  if (modules.suggestions) {
    channels.push("suggestions");
  }
  if (modules.logs) {
    channels.push("logs");
  }
  return channels;
}

async function customConfig(
  guild: Guild,
  communityName: string,
  modules: ServerConfig["modules"],
): Promise<Omit<ServerConfig, "welcome" | "rules">> {
  const config: Omit<ServerConfig, "welcome" | "rules"> = {
    version: CONFIG_VERSION,
    guildId: guild.id,
    communityName,
    locale: "es",
    categories: {},
    channels: {},
    roles: {},
    modules,
  };

  let addCategory = true;
  while (addCategory) {
    const key = await input({ message: "Identificador logico de categoria:", default: `category${Object.keys(config.categories).length + 1}` });
    const name = await input({ message: "Nombre fisico de categoria:" });
    config.categories[key] = { name };
    addCategory = await confirm({ message: "Agregar otra categoria?", default: false });
  }

  for (const logical of enabledCustomLogicalChannels(modules)) {
    const name = await input({ message: `Nombre del canal para ${logical}:`, default: logical });
    const categoryKeys = Object.keys(config.categories);
    const categoryKey =
      categoryKeys.length > 0
        ? await select({
            message: `Categoria para ${name}:`,
            choices: categoryKeys.map((key) => ({ name: config.categories[key]?.name ?? key, value: key })),
          })
        : undefined;
    config.channels[logical] = {
      name,
      type: "text",
      categoryKey,
      function: logical,
      readOnlyForMembers: logical !== "general",
    };
  }

  if (rulesNeedVerificationRoles(modules)) {
    config.roles.pending = makeRole(await input({ message: "Rol pendiente:", default: "Sin verificar" }));
    config.roles.member = makeRole(await input({ message: "Rol miembro:", default: "Miembro" }));
  }

  await maybeReuseResources(guild, config);
  return config;
}

async function maybeReuseResources(guild: Guild, config: Omit<ServerConfig, "welcome" | "rules">): Promise<void> {
  for (const [key, category] of Object.entries(config.categories)) {
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
    const mode = await select<ResourceMode>({
      message: `Canal "${channel.name}" (${channel.function})`,
      choices: [
        { name: "Crear nuevo canal", value: "create" },
        { name: "Utilizar canal existente", value: "existing" },
      ],
    });
    if (mode === "existing") {
      const channels = listReusableChannels(guild);
      const selected = await select({
        message: "Seleccione canal:",
        choices: channels.map((channelOption) => ({ name: `#${channelOption.name}`, value: channelOption.id })),
      });
      const selectedChannel = channels.find((channelOption) => channelOption.id === selected);
      config.channels[key] = { ...channel, name: selectedChannel?.name ?? channel.name, id: selected };
    }
  }

  for (const [key, role] of Object.entries(config.roles)) {
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
