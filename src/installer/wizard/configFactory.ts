import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { ChannelType } from "discord.js";
import type { Guild } from "discord.js";
import { CONFIG_VERSION, createDefaultModules, type ServerConfig } from "../../core/config/schema.js";
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
    ],
  });

  const selectedModuleSet = new Set<string>(selectedModules);
  for (const key of Object.keys(modules) as Array<keyof typeof modules>) {
    modules[key] = selectedModuleSet.has(key);
  }

  const base =
    installMode === "quick" ? await quickConfig(guild, communityName, modules) : await customConfig(guild, communityName, modules);

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
  const information = await input({ message: "Categoria informacion:", default: "INFORMACION" });
  const community = await input({ message: "Categoria comunidad:", default: "COMUNIDAD" });
  const administration = await input({ message: "Categoria administracion:", default: "ADMINISTRACION" });

  const config: Omit<ServerConfig, "welcome" | "rules"> = {
    version: CONFIG_VERSION,
    guildId: guild.id,
    communityName,
    locale: "es",
    categories: {
      information: { name: information },
      community: { name: community },
      administration: { name: administration },
    },
    channels: {
      welcome: {
        name: await input({ message: "Canal bienvenida:", default: "bienvenida" }),
        type: "text",
        categoryKey: "information",
        function: "welcome",
        readOnlyForMembers: true,
      },
      rules: {
        name: await input({ message: "Canal reglas:", default: "reglas" }),
        type: "text",
        categoryKey: "information",
        function: "rules",
        readOnlyForMembers: true,
      },
      announcements: {
        name: await input({ message: "Canal anuncios:", default: "anuncios" }),
        type: "announcement",
        categoryKey: "information",
        function: "announcements",
        readOnlyForMembers: true,
      },
      roles: {
        name: await input({ message: "Canal roles:", default: "roles" }),
        type: "text",
        categoryKey: "information",
        function: "roles",
        readOnlyForMembers: true,
      },
      general: {
        name: await input({ message: "Canal general:", default: "general" }),
        type: "text",
        categoryKey: "community",
        function: "general",
        readOnlyForMembers: false,
      },
      logs: {
        name: await input({ message: "Canal logs:", default: "logs" }),
        type: "text",
        categoryKey: "administration",
        function: "logs",
        readOnlyForMembers: true,
      },
    },
    roles: {
      pending: makeRole(await input({ message: "Rol pendiente:", default: "Sin verificar" })),
      member: makeRole(await input({ message: "Rol miembro:", default: "Miembro" })),
    },
    modules,
  };

  await maybeReuseResources(guild, config);
  return config;
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

  for (const logical of ["welcome", "rules", "general", "logs"] as const) {
    const enabled = logical === "welcome" ? modules.welcome : logical === "rules" ? modules.rules : logical === "logs" ? modules.logs : true;
    if (!enabled) {
      continue;
    }

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

  config.roles.pending = makeRole(await input({ message: "Rol pendiente:", default: "Sin verificar" }));
  config.roles.member = makeRole(await input({ message: "Rol miembro:", default: "Miembro" }));

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
