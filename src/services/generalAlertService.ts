import { ChannelType, EmbedBuilder, type Client, type ColorResolvable } from "discord.js";
import type { ServerConfig } from "../core/config/schema.js";
import { sendDiscordLog } from "./discordLogService.js";

export const generalAlertTypes = [
  "informacion",
  "advertencia",
  "mantenimiento",
  "servidor",
  "urgente",
] as const;

export const generalAlertMentions = ["ninguna", "everyone", "here"] as const;

export type GeneralAlertType = (typeof generalAlertTypes)[number];
export type GeneralAlertMention = (typeof generalAlertMentions)[number];

export interface GeneralAlert {
  message: string;
  type?: GeneralAlertType;
  mention?: GeneralAlertMention;
  source?: string;
}

export interface GeneralAlertResult {
  type: GeneralAlertType;
  mention: GeneralAlertMention;
  channelId: string;
  channelName: string;
}

const maxEmbedDescriptionLength = 4096;

const alertPresentation: Record<GeneralAlertType, { title: string; color: ColorResolvable }> = {
  informacion: { title: "Informacion", color: 0x3498db },
  advertencia: { title: "Aviso", color: 0xf1c40f },
  mantenimiento: { title: "Mantenimiento", color: 0xe67e22 },
  servidor: { title: "Servidor", color: 0x2ecc71 },
  urgente: { title: "Alerta importante", color: 0xe74c3c },
};

export async function sendGeneralAlert(
  client: Client,
  config: ServerConfig,
  alert: GeneralAlert,
): Promise<GeneralAlertResult> {
  if (!config.modules.generalAlerts) {
    throw new Error("El modulo generalAlerts esta desactivado.");
  }

  const message = alert.message.trim();
  if (!message) {
    throw new Error("El mensaje de la alerta no puede estar vacio.");
  }
  if (message.length > maxEmbedDescriptionLength) {
    throw new Error(`El mensaje excede el limite de ${maxEmbedDescriptionLength} caracteres para un embed.`);
  }

  const channelId = config.channels.general?.id;
  if (!channelId) {
    throw new Error("No hay un canal general configurado.");
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    throw new Error("El canal general configurado ya no existe. Ejecuta npm run setup para reparar la configuracion.");
  }
  if (channel.type !== ChannelType.GuildText) {
    throw new Error("El canal general configurado no es un canal de texto.");
  }

  const type = alert.type ?? "informacion";
  const mention = alert.mention ?? "ninguna";
  const presentation = alertPresentation[type];
  const mentionContent = mention === "everyone" ? "@everyone" : mention === "here" ? "@here" : undefined;
  const embed = new EmbedBuilder()
    .setTitle(presentation.title)
    .setColor(presentation.color)
    .setDescription(message)
    .setFooter({ text: config.communityName })
    .setTimestamp(new Date());

  await channel.send({
    ...(mentionContent ? { content: mentionContent } : {}),
    embeds: [embed],
    allowedMentions: {
      parse: mention === "ninguna" ? [] : ["everyone"],
      users: [],
      roles: [],
      repliedUser: false,
    },
  });

  await sendDiscordLog(
    client,
    config,
    [
      "[ALERTA GENERAL]",
      `Administrador: ${alert.source ?? "desconocido"}`,
      `Tipo: ${type}`,
      `Mencion: ${mention}`,
      `Canal: #${channel.name}`,
      "Resultado: OK",
      `Contenido: ${message}`,
    ].join("\n"),
  );

  return {
    type,
    mention,
    channelId,
    channelName: channel.name,
  };
}
