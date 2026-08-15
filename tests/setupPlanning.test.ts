import { ChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import { createDefaultModules, type ServerConfig } from "../src/core/config/schema.js";
import { createQuickInstallConfig } from "../src/installer/wizard/configFactory.js";
import {
  applyStructurePlan,
  preflightStructurePlan,
  toDiscordChannelType,
} from "../src/installer/discord/setupDiscord.js";
import { category, makeGuildMock, textChannel } from "./support/discordMocks.js";

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
  theIsleGuideChannel: "mutaciones",
  theIsleGuideSourcePath: "./data/the-isle/dinosaurs.md",
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
    const guild = makeGuildMock({
      features: [],
      channels: [
        category("cat-1", "INFORMACION"),
        category("cat-2", "COMUNIDAD"),
        textChannel("chan-1", "reglas"),
        textChannel("chan-2", "general"),
      ],
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
    theIsleGuide: {
      enabled: false,
    },
    tiktokAlerts: {
      enabled: false,
      pollingIntervalSeconds: 300,
      mention: "ninguna",
    },
  };
}
