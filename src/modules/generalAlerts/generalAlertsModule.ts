import type { BotModule } from "../../types/BotModule.js";

export const generalAlertsModule: BotModule = {
  name: "generalAlerts",
  enabled: (config) => config.modules.generalAlerts,
  validate(context) {
    if (!context.config.channels.general?.id) {
      return Promise.resolve({
        ok: false,
        messages: ["generalAlerts requiere config.channels.general.id."],
      });
    }

    return Promise.resolve({ ok: true, messages: ["generalAlerts OK."] });
  },
  register() {
    return Promise.resolve();
  },
  start() {
    return Promise.resolve();
  },
};
