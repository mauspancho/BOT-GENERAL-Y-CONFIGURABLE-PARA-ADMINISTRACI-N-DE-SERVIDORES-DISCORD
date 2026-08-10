import type { BotModule } from "../../types/BotModule.js";
import { PersistentMessageRepository } from "../../repositories/persistentMessageRepository.js";
import { ensureRulesPanel } from "../../services/rulesPanelService.js";
import { loadRulesFile } from "../../services/rulesContentService.js";

export const rulesModule: BotModule = {
  name: "rules",
  enabled: (config) => config.modules.rules,
  validate(context) {
    const messages: string[] = [];
    try {
      loadRulesFile(context.config.rules.sourcePath);
      messages.push("Archivo de reglas OK.");
    } catch (error) {
      messages.push(error instanceof Error ? error.message : "Error desconocido en reglas.");
    }

    return Promise.resolve({
      ok: messages.length === 1 && messages[0] === "Archivo de reglas OK.",
      messages,
    });
  },
  register() {
    return Promise.resolve();
  },
  async start(context) {
    await ensureRulesPanel(
      context.client,
      context.config,
      new PersistentMessageRepository(context.database),
    );
  },
};
