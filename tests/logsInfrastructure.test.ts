import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";
import { createDefaultModules, type ServerConfig } from "../src/core/config/schema.js";
import {
  applyStructurePlan,
  preflightStructurePlan,
  getChannelPermissionOverwrites,
} from "../src/installer/discord/setupDiscord.js";
import { createEmptyStructureConfig, ensureAutomaticInfrastructure } from "../src/installer/wizard/installationPlan.js";
import { formatInstallationTree } from "../src/utils/formatPlan.js";
import { category, makeGuildMock, textChannel } from "./support/discordMocks.js";

interface OverwriteShape {
  id: string;
  allow?: bigint[];
  deny?: bigint[];
}

describe("logs infrastructure", () => {
  it("creates logs automatically in the plan", () => {
    const config = makeConfig();

    ensureAutomaticInfrastructure(config);

    expect(config.categories.administration?.name).toBe("ADMINISTRACION");
    expect(config.channels.logs).toMatchObject({
      name: "logs",
      function: "logs",
      categoryKey: "administration",
    });
  });

  it("preflight adds logs so the wizard does not require the user to create it", () => {
    const config = toServerConfig(makeConfig());
    config.channels.general = {
      name: "general",
      type: "text",
      function: "general",
      readOnlyForMembers: false,
    };

    const result = preflightStructurePlan(makeGuildMock({ features: [] }), config);

    expect(result.ok).toBe(true);
    expect(config.channels.logs?.function).toBe("logs");
  });

  it("does not duplicate an existing configured logs channel", () => {
    const config = makeConfig();
    config.categories.administration = { name: "ADMINISTRACION", id: "cat-1" };
    config.channels.logs = {
      name: "logs",
      id: "chan-1",
      type: "text",
      categoryKey: "administration",
      function: "logs",
      readOnlyForMembers: true,
    };

    ensureAutomaticInfrastructure(config);

    expect(Object.values(config.channels).filter((channel) => channel.function === "logs")).toHaveLength(1);
    expect(config.channels.logs?.id).toBe("chan-1");
  });

  it("captures existing logs IDs through idempotent matching", async () => {
    const config = toServerConfig(makeConfig());
    config.channels.general = {
      name: "general",
      type: "text",
      function: "general",
      readOnlyForMembers: false,
    };
    const guild = makeGuildMock({
      features: [],
      channels: [
        category("cat-1", "ADMINISTRACION"),
        textChannel("chan-1", "logs", "cat-1"),
        textChannel("chan-2", "general"),
      ],
    });
    preflightStructurePlan(guild, config);
    await applyStructurePlan(guild, config);

    expect(config.categories.administration?.id).toBe("cat-1");
    expect(config.channels.logs?.id).toBe("chan-1");
  });

  it("sets logs permissions as private for members and writable by the bot", () => {
    const config = makeConfig();
    ensureAutomaticInfrastructure(config);
    const guild = makeGuildMock({ features: [] });
    const overwrites = getChannelPermissionOverwrites(guild, config.channels.logs!);
    const overwriteList = overwrites as OverwriteShape[];
    const everyoneOverwrite = overwriteList.find((overwrite) => overwrite.id === "everyone");
    const botOverwrite = overwriteList.find((overwrite) => overwrite.id === "bot");

    expect(everyoneOverwrite?.deny).toContain(PermissionFlagsBits.ViewChannel);
    expect(botOverwrite?.allow).toContain(PermissionFlagsBits.ViewChannel);
    expect(botOverwrite?.allow).toContain(PermissionFlagsBits.SendMessages);
    expect(botOverwrite?.allow).toContain(PermissionFlagsBits.ReadMessageHistory);
  });

  it("preview shows logs as automatic and admin-only", () => {
    const config = toServerConfig(makeConfig());
    config.channels.general = {
      name: "general",
      type: "text",
      function: "general",
      readOnlyForMembers: false,
    };
    preflightStructurePlan(makeGuildMock({ features: [] }), config);

    const preview = formatInstallationTree(config);

    expect(preview).toContain("funcion: logs");
    expect(preview).toContain("permisos: solo administradores");
    expect(preview).toContain("creacion: automatica");
  });
});

function makeConfig() {
  const modules = createDefaultModules();
  modules.logs = true;
  modules.welcome = false;
  modules.rules = false;
  return createEmptyStructureConfig("guild", "Comunidad", modules);
}

function toServerConfig(config: ReturnType<typeof makeConfig>): ServerConfig {
  return {
    ...config,
    rules: {
      enabled: false,
      sourcePath: "./data/rules.md",
      version: 1,
      requireReacceptOnRulesChange: false,
      rejectAction: "warn",
    },
    welcome: {
      channelEnabled: false,
      dmEnabled: false,
      message: "Hola",
    },
    theIsleGuide: config.theIsleGuide,
  };
}
