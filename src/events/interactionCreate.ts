import type { Interaction } from "discord.js";
import type { ServerConfig } from "../core/config/schema.js";
import type { Database } from "../core/database/sqlite.js";
import { RuleAcceptanceRepository } from "../repositories/ruleAcceptanceRepository.js";
import {
  RULES_ACCEPT_CUSTOM_ID,
  RULES_REJECT_CUSTOM_ID,
} from "../services/rulesPanelService.js";
import { RulesInteractionService } from "../services/rulesInteractionService.js";
import { handleSlashCommand } from "../commands/index.js";

export async function handleInteractionCreate(
  interaction: Interaction,
  config: ServerConfig,
  database: Database,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction, config, database);
    return;
  }

  if (!interaction.isButton()) {
    return;
  }

  const service = new RulesInteractionService(config, new RuleAcceptanceRepository(database));

  if (interaction.customId === RULES_ACCEPT_CUSTOM_ID) {
    await service.accept(interaction);
  }

  if (interaction.customId === RULES_REJECT_CUSTOM_ID) {
    await service.reject(interaction);
  }
}
