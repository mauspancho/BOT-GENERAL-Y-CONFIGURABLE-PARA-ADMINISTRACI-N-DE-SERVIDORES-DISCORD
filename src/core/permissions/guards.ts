import { PermissionFlagsBits, type ButtonInteraction, type ChatInputCommandInteraction } from "discord.js";

export async function requireAdministrator(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<boolean> {
  const memberPermissions = interaction.memberPermissions;
  if (!memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "Este comando requiere permiso de Administrador.",
      ephemeral: true,
    });
    return false;
  }

  return true;
}

export async function requireManageGuild(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const memberPermissions = interaction.memberPermissions;
  if (!memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: "Este comando requiere permiso Manage Server.",
      ephemeral: true,
    });
    return false;
  }

  return true;
}
