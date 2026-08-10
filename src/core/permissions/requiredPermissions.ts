import { PermissionFlagsBits, PermissionsBitField, type GuildMember } from "discord.js";
import type { ServerConfig } from "../config/schema.js";

export interface PermissionRequirement {
  bit: bigint;
  name: string;
  reason: string;
}

const baseRequirements: PermissionRequirement[] = [
  {
    bit: PermissionFlagsBits.ViewChannel,
    name: "View Channels",
    reason: "leer canales configurados y validar recursos existentes",
  },
  {
    bit: PermissionFlagsBits.SendMessages,
    name: "Send Messages",
    reason: "publicar bienvenida, reglas y logs",
  },
  {
    bit: PermissionFlagsBits.EmbedLinks,
    name: "Embed Links",
    reason: "publicar paneles informativos con embeds",
  },
  {
    bit: PermissionFlagsBits.ReadMessageHistory,
    name: "Read Message History",
    reason: "reutilizar paneles persistentes ya publicados",
  },
  {
    bit: PermissionFlagsBits.UseApplicationCommands,
    name: "Use Application Commands",
    reason: "usar slash commands administrativos",
  },
];

export function getRequiredPermissions(config: Pick<ServerConfig, "modules" | "rules">): PermissionRequirement[] {
  const requirements = [...baseRequirements];

  if (config.modules.rules || config.modules.welcome) {
    requirements.push({
      bit: PermissionFlagsBits.ManageRoles,
      name: "Manage Roles",
      reason: "asignar rol pendiente y rol miembro",
    });
  }

  requirements.push({
    bit: PermissionFlagsBits.ManageChannels,
    name: "Manage Channels",
    reason: "crear o reparar categorias y canales desde setup",
  });

  if (config.modules.moderation) {
    requirements.push({
      bit: PermissionFlagsBits.ManageMessages,
      name: "Manage Messages",
      reason: "moderar mensajes cuando los modulos habilitados lo requieran",
    });
  }

  if (config.modules.rules && config.rules.rejectAction === "kick") {
    requirements.push({
      bit: PermissionFlagsBits.KickMembers,
      name: "Kick Members",
      reason: "expulsar usuarios que rechacen reglas cuando esa estrategia este activada",
    });
  }

  const unique = new Map(requirements.map((requirement) => [requirement.bit.toString(), requirement]));
  return [...unique.values()];
}

export function getMissingPermissions(
  botMember: GuildMember,
  requirements: PermissionRequirement[],
): PermissionRequirement[] {
  const permissions = botMember.permissions;
  return requirements.filter((requirement) => !permissions.has(requirement.bit));
}

export function permissionBits(requirements: PermissionRequirement[]): bigint {
  return new PermissionsBitField(requirements.map((requirement) => requirement.bit)).bitfield;
}
