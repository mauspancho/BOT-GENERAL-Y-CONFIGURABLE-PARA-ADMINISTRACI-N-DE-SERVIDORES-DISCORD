import type { BotModule } from "../../types/BotModule.js";

export const welcomeModule: BotModule = {
  name: "welcome",
  enabled: (config) => config.modules.welcome,
  validate() {
    return Promise.resolve({ ok: true, messages: ["Modulo bienvenida OK."] });
  },
  register() {
    return Promise.resolve();
  },
  start() {
    return Promise.resolve();
  },
};
