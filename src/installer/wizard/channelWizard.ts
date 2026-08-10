import { input, select } from "@inquirer/prompts";
import { ChannelType, type Guild, type GuildBasedChannel } from "discord.js";
import type { ChannelConfig, LogicalChannelFunction, ServerConfig } from "../../core/config/schema.js";
import {
  addPlannedChannel,
  findChannelFunctionConflict,
  type ChannelDraft,
  type DuplicateFunctionResolution,
  type StructureConfig,
} from "./installationPlan.js";
import { guildSupportsAnnouncementChannels, listReusableChannels } from "../discord/setupDiscord.js";

export type ChannelWizardAction = "create" | "existing" | "finish";

const functionLabels: Record<LogicalChannelFunction, string> = {
  welcome: "Bienvenida",
  rules: "Reglas",
  announcements: "Avisos",
  roles: "Self Roles",
  general: "General",
  logs: "Logs",
  tickets: "Tickets",
  suggestions: "Sugerencias",
  custom: "Personalizado",
};

export async function askChannelForCategory(
  guild: Guild,
  config: StructureConfig,
  categoryKey: string,
): Promise<ChannelWizardAction> {
  const action = await select<ChannelWizardAction>({
    message: "Desea agregar un canal?",
    choices: [
      { name: "Crear nuevo canal", value: "create" },
      { name: "Utilizar canal existente", value: "existing" },
      { name: "Terminar esta categoria", value: "finish" },
    ],
  });

  if (action === "finish") {
    return action;
  }

  const draft = action === "create"
    ? await askNewChannel(guild, config)
    : await askExistingChannel(guild, config, categoryKey);

  if (!draft) {
    return action;
  }

  await addChannelWithConflictPrompt(config, categoryKey, draft);
  return action;
}

export function getAvailableChannelFunctions(
  modules: ServerConfig["modules"],
): LogicalChannelFunction[] {
  const functions: LogicalChannelFunction[] = ["general"];

  if (modules.welcome) {
    functions.push("welcome");
  }
  if (modules.rules) {
    functions.push("rules");
  }
  if (modules.announcements) {
    functions.push("announcements");
  }
  if (modules.selfRoles) {
    functions.push("roles");
  }
  if (modules.tickets) {
    functions.push("tickets");
  }
  if (modules.suggestions) {
    functions.push("suggestions");
  }
  if (modules.logs) {
    functions.push("logs");
  }

  functions.push("custom");
  return functions;
}

export function getAvailableChannelTypes(guild: Pick<Guild, "features">): ChannelConfig["type"][] {
  const types: ChannelConfig["type"][] = ["text", "voice"];
  if (guildSupportsAnnouncementChannels(guild)) {
    types.push("announcement");
  }
  return types;
}

export function inferChannelType(channel: GuildBasedChannel): ChannelConfig["type"] {
  if (channel.type === ChannelType.GuildVoice) {
    return "voice";
  }
  if (channel.type === ChannelType.GuildAnnouncement) {
    return "announcement";
  }
  return "text";
}

export function defaultReadOnlyForFunction(channelFunction: LogicalChannelFunction): boolean {
  return ["welcome", "rules", "announcements", "roles", "logs"].includes(channelFunction);
}

async function askNewChannel(guild: Guild, config: StructureConfig): Promise<ChannelDraft> {
  const name = await input({ message: "Nombre del canal:" });
  const type = await select<ChannelConfig["type"]>({
    message: "Tipo de canal:",
    choices: getAvailableChannelTypes(guild).map((value) => ({
      name: value === "text" ? "Texto" : value === "voice" ? "Voz" : "Anuncios",
      value,
    })),
  });
  const channelFunction = await askChannelFunction(config);
  const readOnlyForMembers = await askWriteAccess(channelFunction);

  return {
    name,
    type,
    function: channelFunction,
    readOnlyForMembers,
  };
}

async function askExistingChannel(
  guild: Guild,
  config: StructureConfig,
  categoryKey: string,
): Promise<ChannelDraft | undefined> {
  const category = config.categories[categoryKey];
  const categoryId = category?.id;
  if (!categoryId) {
    console.log("Para reutilizar canales dentro de una categoria, primero seleccione una categoria existente.");
    return undefined;
  }

  const reusableChannels = listReusableChannels(guild).filter((channel) => {
    if (channel.type === ChannelType.GuildCategory) {
      return false;
    }
    return "parentId" in channel ? channel.parentId === categoryId : true;
  });

  if (reusableChannels.length === 0) {
    console.log("No hay canales existentes compatibles para seleccionar.");
    return undefined;
  }

  const selectedId = await select({
    message: "Seleccione canal existente:",
    choices: reusableChannels.map((channel) => ({ name: `#${channel.name}`, value: channel.id })),
  });
  const selected = reusableChannels.find((channel) => channel.id === selectedId);
  if (!selected) {
    return undefined;
  }

  const channelFunction = await askChannelFunction(config);
  const readOnlyForMembers = await askWriteAccess(channelFunction);

  return {
    id: selected.id,
    name: selected.name,
    type: inferChannelType(selected),
    function: channelFunction,
    readOnlyForMembers,
  };
}

async function askChannelFunction(config: StructureConfig): Promise<LogicalChannelFunction> {
  return select<LogicalChannelFunction>({
    message: "Funcion del canal:",
    choices: getAvailableChannelFunctions(config.modules).map((value) => ({
      name: functionLabels[value],
      value,
    })),
  });
}

async function askWriteAccess(channelFunction: LogicalChannelFunction): Promise<boolean> {
  const access = await select<"members" | "readonly">({
    message: "Quien puede escribir?",
    choices: [
      {
        name: "Todos los miembros",
        value: "members",
        description: "Los miembros pueden enviar mensajes.",
      },
      {
        name: "Solo administradores/bot",
        value: "readonly",
        description: "Los miembros pueden ver, pero no escribir.",
      },
    ],
    default: defaultReadOnlyForFunction(channelFunction) ? "readonly" : "members",
  });

  return access === "readonly";
}

async function addChannelWithConflictPrompt(
  config: StructureConfig,
  categoryKey: string,
  draft: ChannelDraft,
): Promise<void> {
  const conflict = findChannelFunctionConflict(config, draft.function);
  let resolution: DuplicateFunctionResolution = "cancel";

  if (conflict) {
    console.log(`Ya existe un canal configurado para ${functionLabels[conflict.function]}: #${conflict.existingName}`);
    resolution = await select<DuplicateFunctionResolution>({
      message: "Que desea hacer?",
      choices: [
        { name: "Utilizar el nuevo canal en su lugar", value: "replace" },
        { name: "Mantener el actual y crear este como canal personalizado", value: "custom" },
        { name: "Cancelar", value: "cancel" },
      ],
    });
  }

  addPlannedChannel(config, categoryKey, draft, resolution);
}
