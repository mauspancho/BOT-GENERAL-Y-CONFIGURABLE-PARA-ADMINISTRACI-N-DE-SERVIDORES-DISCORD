import { input, select } from "@inquirer/prompts";
import { ChannelType, type Guild } from "discord.js";
import { addPlannedCategory, createEmptyStructureConfig, type StructureConfig } from "./installationPlan.js";
import { askChannelForCategory } from "./channelWizard.js";
import { formatInstallationTree } from "../../utils/formatPlan.js";
import { ensureAutomaticInfrastructure, ensureVerificationRoles } from "./installationPlan.js";
import type { ServerConfig } from "../../core/config/schema.js";
import {
  applyInventoryToConfig,
  findCategoryCandidates,
  findChannelCandidates,
  findRoleCandidates,
  scanAndPersistGuildInventory,
  type GuildInventory,
} from "../discord/guildInventory.js";

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
  ensureAutomaticInfrastructure(config);
  const inventory = scanAndPersistGuildInventory(guild);
  const inventoryResult = applyInventoryToConfig(config, inventory);
  await resolveAmbiguousInventoryMatches(config, inventory, inventoryResult.ambiguous);

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

async function resolveAmbiguousInventoryMatches(
  config: StructureConfig,
  inventory: GuildInventory,
  ambiguous: string[],
): Promise<void> {
  for (const item of ambiguous) {
    const [resourceType, key] = item.split(":");
    if (!resourceType || !key) {
      continue;
    }

    if (resourceType === "category") {
      const category = config.categories[key];
      if (!category) {
        continue;
      }
      const match = findCategoryCandidates(inventory, key, category);
      const selected = await select<string>({
        message: `Coincidencia ambigua para categoria "${category.name}". Seleccione una opcion:`,
        choices: [
          ...match.candidates.map((candidate) => ({
            name: `Usar ${candidate.name} (${candidate.id})`,
            value: candidate.id,
          })),
          { name: "Crear nueva categoria", value: "create" },
        ],
      });
      if (selected !== "create") {
        const candidate = match.candidates.find((option) => option.id === selected);
        config.categories[key] = { name: candidate?.name ?? category.name, id: selected };
      }
      continue;
    }

    if (resourceType === "channel") {
      const channel = config.channels[key];
      if (!channel) {
        continue;
      }
      const match = findChannelCandidates(inventory, key, channel);
      const selected = await select<string>({
        message: `Coincidencia ambigua para canal "${channel.name}". Seleccione una opcion:`,
        choices: [
          ...match.candidates.map((candidate) => ({
            name: `Usar #${candidate.name} (${candidate.id})`,
            value: candidate.id,
          })),
          { name: "Crear nuevo canal", value: "create" },
        ],
      });
      if (selected !== "create") {
        const candidate = match.candidates.find((option) => option.id === selected);
        config.channels[key] = { ...channel, name: candidate?.name ?? channel.name, id: selected };
      }
      continue;
    }

    if (resourceType === "role") {
      const role = config.roles[key];
      if (!role?.enabled) {
        continue;
      }
      const match = findRoleCandidates(inventory, key, role);
      const selected = await select<string>({
        message: `Coincidencia ambigua para rol "${role.name}". Seleccione una opcion:`,
        choices: [
          ...match.candidates.map((candidate) => ({
            name: `Usar ${candidate.name} (${candidate.id})`,
            value: candidate.id,
          })),
          { name: "Crear nuevo rol", value: "create" },
        ],
      });
      if (selected !== "create") {
        const candidate = match.candidates.find((option) => option.id === selected);
        config.roles[key] = { ...role, name: candidate?.name ?? role.name, id: selected };
      }
    }
  }
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
    theIsleGuide: config.theIsleGuide,
    tiktokAlerts: config.tiktokAlerts,
  };
}
