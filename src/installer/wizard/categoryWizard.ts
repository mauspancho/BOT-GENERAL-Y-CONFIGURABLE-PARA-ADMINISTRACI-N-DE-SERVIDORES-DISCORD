import { input, select } from "@inquirer/prompts";
import { ChannelType, type Guild } from "discord.js";
import { addPlannedCategory, createEmptyStructureConfig, type StructureConfig } from "./installationPlan.js";
import { askChannelForCategory } from "./channelWizard.js";
import { formatInstallationTree } from "../../utils/formatPlan.js";
import { ensureVerificationRoles } from "./installationPlan.js";
import type { ServerConfig } from "../../core/config/schema.js";

type CategoryAction = "create" | "existing" | "finish";

export async function buildCustomInstallationStructure(
  guild: Guild,
  communityName: string,
  modules: ServerConfig["modules"],
): Promise<StructureConfig> {
  const config = createEmptyStructureConfig(guild.id, communityName, modules);
  while (true) {
    const action = await select<CategoryAction>({
      message: "Que desea hacer?",
      choices: [
        { name: "Crear nueva categoria", value: "create" },
        { name: "Utilizar categoria existente", value: "existing" },
        { name: "Terminar configuracion de categorias", value: "finish" },
      ],
    });

    if (action === "finish") {
      break;
    }

    const categoryKey =
      action === "create"
        ? await askNewCategory(config)
        : await askExistingCategory(guild, config);

    if (!categoryKey) {
      continue;
    }

    let continueChannels = true;
    while (continueChannels) {
      const channelAction = await askChannelForCategory(guild, config, categoryKey);
      continueChannels = channelAction !== "finish";
    }

    console.log("\n========================================");
    console.log("ESTRUCTURA ACTUAL");
    console.log("========================================");
    console.log(formatInstallationTree(toPreviewConfig(config)));
    console.log("========================================\n");
  }

  ensureVerificationRoles(config, {
    pendingRole: await maybeAskRoleName(modules.rules, "Rol pendiente:", "Sin verificar"),
    memberRole: await maybeAskRoleName(modules.rules, "Rol miembro:", "Miembro"),
  });

  return config;
}

async function askNewCategory(config: StructureConfig): Promise<string> {
  const name = await input({ message: "Nombre de la categoria:" });
  return addPlannedCategory(config, { name });
}

async function askExistingCategory(guild: Guild, config: StructureConfig): Promise<string | undefined> {
  const categories = [...guild.channels.cache.values()].filter(
    (channel) => channel.type === ChannelType.GuildCategory,
  );

  if (categories.length === 0) {
    console.log("No hay categorias existentes disponibles.");
    return undefined;
  }

  const selectedId = await select({
    message: "Seleccione categoria existente:",
    choices: categories.map((category) => ({ name: category.name, value: category.id })),
  });
  const selected = categories.find((category) => category.id === selectedId);
  if (!selected) {
    return undefined;
  }

  return addPlannedCategory(config, { name: selected.name, id: selected.id });
}

async function maybeAskRoleName(enabled: boolean, message: string, fallback: string): Promise<string> {
  if (!enabled) {
    return fallback;
  }

  return input({ message, default: fallback });
}

function toPreviewConfig(config: StructureConfig): ServerConfig {
  return {
    ...config,
    rules: {
      enabled: config.modules.rules,
      sourcePath: "./data/rules.md",
      version: 1,
      requireReacceptOnRulesChange: false,
      rejectAction: "warn",
    },
    welcome: {
      channelEnabled: config.modules.welcome,
      dmEnabled: false,
      message: "Bienvenido {user} a {server}!",
    },
  };
}
