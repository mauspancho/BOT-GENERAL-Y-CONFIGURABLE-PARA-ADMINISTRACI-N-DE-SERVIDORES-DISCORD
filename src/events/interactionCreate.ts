import type { Interaction } from "discord.js";
import type { ServerConfig } from "../core/config/schema.js";
import type { Database } from "../core/database/sqlite.js";
import type { AppLogger } from "../core/logger/logger.js";
import { RuleAcceptanceRepository } from "../repositories/ruleAcceptanceRepository.js";
import {
  RULES_ACCEPT_CUSTOM_ID,
  RULES_REJECT_CUSTOM_ID,
} from "../services/rulesPanelService.js";
import { RulesInteractionService } from "../services/rulesInteractionService.js";
import { handleSlashCommand } from "../commands/index.js";
import { handleTheIsleSelect } from "../modules/theIsleGuide/theIsleInteractionService.js";
import { handleTikTokButton } from "../modules/tiktokAlerts/tiktokInteractionService.js";
import { handleTikTokRepublishSelect } from "../modules/tiktokAlerts/tiktokInteractionService.js";

export async function handleInteractionCreate(
  interaction: Interaction,
  config: ServerConfig,
  database: Database,
  logger?: AppLogger,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction, config, database, logger);
    return;
  }

  if (interaction.isStringSelectMenu()) {
    if (await handleTikTokRepublishSelect(interaction, config, database, logger ? { logger } : undefined)) {
      return;
    }
    if (await handleTheIsleSelect(interaction, config)) {
      return;
    }
  }

  if (!interaction.isButton()) {
    return;
  }

  if (await handleTikTokButton(interaction, config, database, logger ? { logger } : undefined)) {
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
