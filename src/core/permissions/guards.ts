import { PermissionFlagsBits, type ButtonInteraction, type ChatInputCommandInteraction, type Client } from "discord.js";

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

export async function requireGuildAdministratorForUser(
  client: Client,
  guildId: string,
  discordUserId: string,
): Promise<boolean> {
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(discordUserId);
  return member.permissions.has(PermissionFlagsBits.Administrator);
}
