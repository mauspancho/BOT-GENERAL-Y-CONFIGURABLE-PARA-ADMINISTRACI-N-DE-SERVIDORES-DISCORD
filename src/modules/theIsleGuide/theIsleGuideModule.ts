import type { BotModule } from "../../types/BotModule.js";
import { getRulesPath } from "../../core/config/paths.js";
import { loadTheIsleGuideFile } from "./theIsleParser.js";
import { ensureTheIslePanel } from "./theIslePanelService.js";
import { PersistentMessageRepository } from "../../repositories/persistentMessageRepository.js";

export const theIsleGuideModule: BotModule = {
  name: "theIsleGuide",
  enabled: (config) => config.modules.theIsleGuide,
  validate() {
    try {
      loadTheIsleGuideFile(getRulesPath("./data/the-isle/dinosaurs.md"));
      return Promise.resolve({ ok: true, messages: ["The Isle guide OK."] });
    } catch (error) {
      return Promise.resolve({
        ok: false,
        messages: [error instanceof Error ? error.message : "Error desconocido en The Isle guide."],
      });
    }
  },
  register() {
    return Promise.resolve();
  },
  async start(context) {
    await ensureTheIslePanel(
      context.client,
      context.config,
      new PersistentMessageRepository(context.database),
    );
  },
};
