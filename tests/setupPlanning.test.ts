import { ChannelType, type Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createDefaultModules, type ServerConfig } from "../src/core/config/schema.js";
import { createQuickInstallConfig } from "../src/installer/wizard/configFactory.js";
import {
  applyStructurePlan,
  preflightStructurePlan,
  toDiscordChannelType,
} from "../src/installer/discord/setupDiscord.js";

const promptValues = {
  informationCategory: "INFORMACION",
  communityCategory: "COMUNIDAD",
  administrationCategory: "ADMINISTRACION",
  welcomeChannel: "bienvenida",
  rulesChannel: "reglas",
  announcementsChannel: "anuncios",
  selfRolesChannel: "roles",
  generalChannel: "general",
  logsChannel: "logs",
  pendingRole: "Sin verificar",
  memberRole: "Miembro",
};

describe("setup planning", () => {
  it("quick install creates only resources required by enabled modules", () => {
    const modules = createDefaultModules();
    modules.welcome = true;
    modules.rules = true;
    modules.logs = true;
    modules.selfRoles = false;
    modules.announcements = false;

    const config = createQuickInstallConfig("guild", "Comunidad", modules, promptValues);

    expect(Object.keys(config.channels).sort()).toEqual(["general", "logs", "rules", "welcome"]);
    expect(config.channels.announcements).toBeUndefined();
    expect(config.channels.roles).toBeUndefined();
    expect(Object.keys(config.categories).sort()).toEqual([
      "administration",
      "community",
      "information",
    ]);
  });

  it("does not plan GuildAnnouncement when announcements are disabled", () => {
    const modules = createDefaultModules();
    modules.announcements = false;

    const config = createQuickInstallConfig("guild", "Comunidad", modules, promptValues);

    expect(Object.values(config.channels).some((channel) => channel.type === "announcement")).toBe(false);
  });

  it("falls back announcement channels to text when the guild lacks Community support", () => {
    const config = makeServerConfig();
    config.channels.announcements = {
      name: "anuncios",
      type: "announcement",
      categoryKey: "information",
      function: "announcements",
      readOnlyForMembers: true,
    };
    config.modules.announcements = true;

    const guild = makeGuildMock({ features: [] });
    const preflight = preflightStructurePlan(guild, config);

    expect(preflight.ok).toBe(true);
    expect(preflight.warnings[0]).toContain("no admite canales de anuncios");
    expect(config.channels.announcements.type).toBe("text");
    expect(toDiscordChannelType(config.channels.announcements.type, false)).toBe(ChannelType.GuildText);
  });

  it("reuses partially existing resources and does not duplicate them", async () => {
    const config = makeServerConfig();
    const existingCategory = {
      id: "cat-1",
      name: "INFORMACION",
      type: ChannelType.GuildCategory,
      isThread: () => false,
    };
    const existingCommunityCategory = {
      id: "cat-2",
      name: "COMUNIDAD",
      type: ChannelType.GuildCategory,
      isThread: () => false,
    };
    const existingRules = {
      id: "chan-1",
      name: "reglas",
      type: ChannelType.GuildText,
      isThread: () => false,
    };
    const existingGeneral = {
      id: "chan-2",
      name: "general",
      type: ChannelType.GuildText,
      isThread: () => false,
    };
    const guild = makeGuildMock({
      features: [],
      channels: [existingCategory, existingCommunityCategory, existingRules, existingGeneral],
      roles: [
        { id: "role-1", name: "Sin verificar", managed: false },
        { id: "role-2", name: "Miembro", managed: false },
      ],
    });

    const changes = await applyStructurePlan(guild, config);

    expect(changes).toEqual([
      {
        action: "skip",
        resourceType: "category",
        key: "information",
        name: "INFORMACION",
        id: "cat-1",
      },
      {
        action: "skip",
        resourceType: "category",
        key: "community",
        name: "COMUNIDAD",
        id: "cat-2",
      },
      {
        action: "skip",
        resourceType: "channel",
        key: "rules",
        name: "reglas",
        id: "chan-1",
      },
      {
        action: "skip",
        resourceType: "channel",
        key: "general",
        name: "general",
        id: "chan-2",
      },
      {
        action: "skip",
        resourceType: "role",
        key: "pending",
        name: "Sin verificar",
        id: "role-1",
      },
      {
        action: "skip",
        resourceType: "role",
        key: "member",
        name: "Miembro",
        id: "role-2",
      },
    ]);
  });
});

function makeServerConfig(): ServerConfig {
  const modules = createDefaultModules();
  modules.welcome = false;
  modules.rules = true;
  modules.logs = false;
  modules.announcements = false;

  return {
    version: 1,
    guildId: "guild",
    communityName: "Comunidad",
    locale: "es",
    categories: {
      information: { name: "INFORMACION" },
      community: { name: "COMUNIDAD" },
    },
    channels: {
      rules: {
        name: "reglas",
        type: "text",
        categoryKey: "information",
        function: "rules",
        readOnlyForMembers: true,
      },
      general: {
        name: "general",
        type: "text",
        categoryKey: "community",
        function: "general",
        readOnlyForMembers: false,
      },
    },
    roles: {
      pending: {
        name: "Sin verificar",
        enabled: true,
        protected: true,
      },
      member: {
        name: "Miembro",
        enabled: true,
        protected: true,
      },
    },
    modules,
    rules: {
      enabled: true,
      sourcePath: "./data/rules.md",
      version: 1,
      requireReacceptOnRulesChange: false,
      rejectAction: "warn",
    },
    welcome: {
      channelEnabled: false,
      dmEnabled: false,
      message: "Hola {user}",
    },
  };
}

function makeGuildMock(options: {
  features: string[];
  channels?: Array<Record<string, unknown>>;
  roles?: Array<Record<string, unknown>>;
}): Guild {
  const channelList = options.channels ?? [];
  const roleList = options.roles ?? [];
  const cache = {
    values: () => channelList.values(),
    find: (predicate: (channel: Record<string, unknown>) => boolean) => channelList.find(predicate),
  };
  const roleCache = {
    values: () => roleList.values(),
    find: (predicate: (role: Record<string, unknown>) => boolean) => roleList.find(predicate),
  };

  return {
    features: options.features,
    channels: {
      cache,
      fetch: (id: string) => Promise.resolve(channelList.find((channel) => channel.id === id) ?? null),
      create: vi.fn(),
    },
    roles: {
      cache: roleCache,
      fetch: (id: string) => Promise.resolve(roleList.find((role) => role.id === id) ?? null),
      create: vi.fn(),
      everyone: { id: "everyone" },
    },
    members: {
      me: { id: "bot" },
    },
    client: {
      user: { id: "bot" },
    },
  } as unknown as Guild;
}
