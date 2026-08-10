import type { ButtonInteraction } from "discord.js";
import type { ServerConfig } from "../core/config/schema.js";
import type { RuleAcceptanceRepository } from "../repositories/ruleAcceptanceRepository.js";
import { sendDiscordLog } from "./discordLogService.js";

export class RulesInteractionService {
  public constructor(
    private readonly config: ServerConfig,
    private readonly acceptances: RuleAcceptanceRepository,
  ) {}

  public async accept(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guild || !interaction.member) {
      await interaction.reply({ content: "Esta accion solo funciona dentro del servidor.", ephemeral: true });
      return;
    }

    const alreadyAccepted = this.acceptances.hasAccepted(
      interaction.guild.id,
      interaction.user.id,
      this.config.rules.version,
    );

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const pendingRoleId = this.config.roles.pending?.id;
    const memberRoleId = this.config.roles.member?.id;

    if (pendingRoleId) {
      await member.roles.remove(pendingRoleId).catch(() => undefined);
    }

    if (memberRoleId) {
      await member.roles.add(memberRoleId).catch(() => undefined);
    }

    if (!alreadyAccepted) {
      this.acceptances.record({
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        acceptedAt: new Date().toISOString(),
        rulesVersion: this.config.rules.version,
      });
    }

    await interaction.reply({
      content: alreadyAccepted
        ? "Ya habias aceptado esta version de las reglas."
        : "Reglas aceptadas. Tu acceso fue actualizado.",
      ephemeral: true,
    });
    await sendDiscordLog(interaction.client, this.config, `<@${interaction.user.id}> acepto las reglas.`);
  }

  public async reject(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guild) {
      await interaction.reply({ content: "Esta accion solo funciona dentro del servidor.", ephemeral: true });
      return;
    }

    const action = this.config.rules.rejectAction;
    if (action === "kick") {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (member.kickable && !member.permissions.has("Administrator")) {
        await interaction.reply({ content: "Has rechazado las reglas. Seras expulsado.", ephemeral: true });
        await sendDiscordLog(interaction.client, this.config, `<@${interaction.user.id}> rechazo las reglas.`);
        await member.kick("Rules rejected");
        return;
      }

      await interaction.reply({
        content: "No se pudo aplicar la expulsion por jerarquia de roles o permisos.",
        ephemeral: true,
      });
      return;
    }

    const message =
      action === "none"
        ? "No se aplico ninguna accion."
        : action === "keep_pending"
          ? "Permaneceras con el rol pendiente."
          : "Necesitas aceptar las reglas para obtener acceso completo.";

    await interaction.reply({ content: message, ephemeral: true });
    await sendDiscordLog(interaction.client, this.config, `<@${interaction.user.id}> rechazo las reglas.`);
  }
}
