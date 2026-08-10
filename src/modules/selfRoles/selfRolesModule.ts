import type { BotModule } from "../../types/BotModule.js";

export const selfRolesModule: BotModule = {
  name: "selfRoles",
  enabled: (config) => config.modules.selfRoles,
  validate() {
    return Promise.resolve({ ok: true, messages: ["Self-roles preparado para Fase 2."] });
  },
  register() {
    return Promise.resolve();
  },
  start() {
    return Promise.resolve();
  },
};
