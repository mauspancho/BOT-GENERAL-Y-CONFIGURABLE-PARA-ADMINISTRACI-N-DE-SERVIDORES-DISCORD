import type { BotModule } from "../types/BotModule.js";
import { logsModule } from "./logs/logsModule.js";
import { rulesModule } from "./rules/rulesModule.js";
import { selfRolesModule } from "./selfRoles/selfRolesModule.js";
import { welcomeModule } from "./welcome/welcomeModule.js";

export const modules: BotModule[] = [welcomeModule, rulesModule, logsModule, selfRolesModule];

export function enabledModules(config: Parameters<BotModule["enabled"]>[0]): BotModule[] {
  return modules.filter((module) => module.enabled(config));
}
