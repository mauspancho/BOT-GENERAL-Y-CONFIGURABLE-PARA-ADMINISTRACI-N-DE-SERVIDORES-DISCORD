import type { BotModule } from "../../types/BotModule.js";

export const logsModule: BotModule = {
  name: "logs",
  enabled: (config) => config.modules.logs,
  validate(context) {
    return Promise.resolve({
      ok: Boolean(context.config.channels.logs?.id),
      messages: [context.config.channels.logs?.id ? "Canal de logs configurado." : "Canal de logs no configurado."],
    });
  },
  register() {
    return Promise.resolve();
  },
  start() {
    return Promise.resolve();
  },
};
