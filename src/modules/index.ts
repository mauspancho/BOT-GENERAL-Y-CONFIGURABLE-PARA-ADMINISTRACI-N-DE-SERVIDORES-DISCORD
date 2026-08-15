import type { BotModule } from "../types/BotModule.js";
import { generalAlertsModule } from "./generalAlerts/generalAlertsModule.js";
import { logsModule } from "./logs/logsModule.js";
import { rulesModule } from "./rules/rulesModule.js";
import { selfRolesModule } from "./selfRoles/selfRolesModule.js";
import { theIsleGuideModule } from "./theIsleGuide/theIsleGuideModule.js";
import { tiktokAlertsModule } from "./tiktokAlerts/tiktokAlertsModule.js";
import { welcomeModule } from "./welcome/welcomeModule.js";

export const modules: BotModule[] = [
  welcomeModule,
  rulesModule,
  logsModule,
  generalAlertsModule,
  tiktokAlertsModule,
  selfRolesModule,
  theIsleGuideModule,
];

export function enabledModules(config: Parameters<BotModule["enabled"]>[0]): BotModule[] {
  return modules.filter((module) => module.enabled(config));
}
