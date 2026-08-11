import { z } from "zod";

export const CONFIG_VERSION = 1;

export const logicalChannelFunctions = [
  "welcome",
  "rules",
  "announcements",
  "roles",
  "general",
  "logs",
  "tickets",
  "suggestions",
  "theIsleGuide",
  "custom",
] as const;

export const moduleNames = [
  "welcome",
  "rules",
  "selfRoles",
  "announcements",
  "tickets",
  "suggestions",
  "moderation",
  "logs",
  "theIsleGuide",
] as const;

const resourceSchema = z.object({
  name: z.string().min(1),
  id: z.string().min(1).optional(),
});

export const channelSchema = resourceSchema.extend({
  type: z.enum(["text", "announcement", "voice"]),
  categoryKey: z.string().min(1).optional(),
  function: z.enum(logicalChannelFunctions),
  readOnlyForMembers: z.boolean().default(false),
});

export const roleSchema = resourceSchema.extend({
  enabled: z.boolean().default(true),
  protected: z.boolean().default(false),
});

export const modulesSchema = z.object({
  welcome: z.boolean(),
  rules: z.boolean(),
  selfRoles: z.boolean(),
  announcements: z.boolean(),
  tickets: z.boolean(),
  suggestions: z.boolean(),
  moderation: z.boolean(),
  logs: z.boolean(),
  theIsleGuide: z.boolean().default(false),
});

export const rulesConfigSchema = z.object({
  enabled: z.boolean(),
  sourcePath: z.string().default("./data/rules.md"),
  version: z.number().int().positive().default(1),
  requireReacceptOnRulesChange: z.boolean().default(false),
  rejectAction: z.enum(["warn", "none", "kick", "keep_pending"]).default("warn"),
});

export const welcomeConfigSchema = z.object({
  channelEnabled: z.boolean().default(true),
  dmEnabled: z.boolean().default(false),
  message: z.string().default("Bienvenido {user} a {server}!"),
});

export const theIsleGuideConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    sourcePath: z.string().trim().min(1).optional(),
  })
  .default({ enabled: true });

export const serverConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  guildId: z.string().min(1),
  communityName: z.string().min(1),
  locale: z.enum(["es", "en"]).default("es"),
  categories: z.record(z.string(), resourceSchema),
  channels: z.record(z.string(), channelSchema),
  roles: z.record(z.string(), roleSchema),
  modules: modulesSchema,
  rules: rulesConfigSchema,
  welcome: welcomeConfigSchema,
  theIsleGuide: theIsleGuideConfigSchema,
});

export type LogicalChannelFunction = (typeof logicalChannelFunctions)[number];
export type ModuleName = (typeof moduleNames)[number];
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type ChannelConfig = z.infer<typeof channelSchema>;
export type RoleConfig = z.infer<typeof roleSchema>;
export type TheIsleGuideConfig = z.infer<typeof theIsleGuideConfigSchema>;

export function createDefaultModules(): ServerConfig["modules"] {
  return {
    welcome: true,
    rules: true,
    selfRoles: false,
    announcements: false,
    tickets: false,
    suggestions: false,
    moderation: false,
    logs: true,
    theIsleGuide: false,
  };
}
