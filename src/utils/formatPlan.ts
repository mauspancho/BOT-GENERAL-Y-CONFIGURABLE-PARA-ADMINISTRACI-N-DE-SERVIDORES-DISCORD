import type { ServerConfig } from "../core/config/schema.js";

export function formatInstallationTree(config: ServerConfig): string {
  const lines = [`Servidor: ${config.communityName}`, ""];

  for (const [categoryKey, category] of Object.entries(config.categories)) {
    const categoryChannels = Object.values(config.channels).filter(
      (candidate) => candidate.categoryKey === categoryKey,
    );
    lines.push(`${category.name}${category.id ? ` (${category.id})` : ""}`);
    for (const channel of categoryChannels) {
      lines.push(`  - #${channel.name}${channel.id ? ` (${channel.id})` : ""}`);
      lines.push(`      tipo: ${formatChannelType(channel.type)}`);
      lines.push(`      funcion: ${channel.function}`);
      lines.push(`      permisos: ${channel.readOnlyForMembers ? "solo administradores/bot" : "miembros pueden escribir"}`);
    }
    lines.push("");
  }

  const uncategorized = Object.values(config.channels).filter((channel) => !channel.categoryKey);
  if (uncategorized.length > 0) {
    lines.push("Sin categoria");
    for (const channel of uncategorized) {
      lines.push(`  - #${channel.name} [${channel.function}]${channel.id ? ` (${channel.id})` : ""}`);
    }
    lines.push("");
  }

  lines.push("Roles:");
  for (const role of Object.values(config.roles)) {
    lines.push(`  - ${role.enabled ? role.name : `${role.name} (desactivado)`}${role.id ? ` (${role.id})` : ""}`);
  }

  lines.push("", "Modulos:");
  for (const [name, enabled] of Object.entries(config.modules)) {
    lines.push(`  ${enabled ? "[x]" : "[ ]"} ${name}`);
  }

  return lines.join("\n");
}

function formatChannelType(type: string): string {
  if (type === "announcement") {
    return "anuncios";
  }
  if (type === "voice") {
    return "voz";
  }
  return "texto";
}
