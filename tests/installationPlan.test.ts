import { describe, expect, it } from "vitest";
import { createDefaultModules, type ServerConfig } from "../src/core/config/schema.js";
import {
  addPlannedCategory,
  addPlannedChannel,
  createEmptyStructureConfig,
  findChannelFunctionConflict,
  keyForCategoryName,
  makeUniqueKey,
  slugifyName,
  type StructureConfig,
} from "../src/installer/wizard/installationPlan.js";
import { preflightStructurePlan } from "../src/installer/discord/setupDiscord.js";
import { makeGuildMock } from "./support/discordMocks.js";

describe("installation plan helpers", () => {
  it("creates one category with multiple channels", () => {
    const config = makeStructureConfig();
    const categoryKey = addPlannedCategory(config, { name: "INFORMACION" });

    addPlannedChannel(config, categoryKey, channel("bienvenida", "welcome", true));
    addPlannedChannel(config, categoryKey, channel("reglas", "rules", true));
    addPlannedChannel(config, categoryKey, channel("guia", "custom", true));

    expect(Object.keys(config.categories)).toEqual(["information"]);
    expect(Object.values(config.channels).map((entry) => entry.categoryKey)).toEqual([
      "information",
      "information",
      "information",
    ]);
  });

  it("creates multiple categories and assigns categoryKey correctly", () => {
    const config = makeStructureConfig();
    const information = addPlannedCategory(config, { name: "INFORMACION" });
    const community = addPlannedCategory(config, { name: "COMUNIDAD" });

    addPlannedChannel(config, information, channel("reglas", "rules", true));
    addPlannedChannel(config, community, channel("general", "general", false));

    expect(config.channels.rules?.categoryKey).toBe("information");
    expect(config.channels.general?.categoryKey).toBe("community");
  });

  it("creates several custom channels without module listeners", () => {
    const config = makeStructureConfig();
    const community = addPlannedCategory(config, { name: "COMUNIDAD" });

    addPlannedChannel(config, community, channel("streams", "custom", false));
    addPlannedChannel(config, community, channel("multimedia", "custom", false));
    addPlannedChannel(config, community, channel("memes", "custom", false));

    expect(Object.keys(config.channels).sort()).toEqual(["memes", "multimedia", "streams"]);
    expect(Object.values(config.channels).every((entry) => entry.function === "custom")).toBe(true);
  });

  it("generates internal identifiers without asking for logical IDs", () => {
    expect(keyForCategoryName("INFORMACION")).toBe("information");
    expect(keyForCategoryName("COMUNIDAD")).toBe("community");
    expect(slugifyName("GUIAS Y AYUDA")).toBe("guias-y-ayuda");
  });

  it("generates unique identifiers when names collide", () => {
    expect(makeUniqueKey("events", { events: {}, "events-2": {} })).toBe("events-3");
  });

  it("does not allow two unique welcome channels by default", () => {
    const config = makeStructureConfig();
    const information = addPlannedCategory(config, { name: "INFORMACION" });

    addPlannedChannel(config, information, channel("bienvenida", "welcome", true));
    const result = addPlannedChannel(config, information, channel("hola", "welcome", true));

    expect(result.added).toBe(false);
    expect(result.conflict?.existingName).toBe("bienvenida");
    expect(findChannelFunctionConflict(config, "welcome")?.existingKey).toBe("welcome");
  });

  it("can replace a unique function and convert the old channel to custom", () => {
    const config = makeStructureConfig();
    const information = addPlannedCategory(config, { name: "INFORMACION" });

    addPlannedChannel(config, information, channel("bienvenida", "welcome", true));
    addPlannedChannel(config, information, channel("hola", "welcome", true), "replace");

    expect(config.channels.welcome?.name).toBe("hola");
    expect(Object.values(config.channels).find((entry) => entry.name === "bienvenida")?.function).toBe("custom");
  });

  it("reuses existing category and channel IDs selected by the user", () => {
    const config = makeStructureConfig();
    const community = addPlannedCategory(config, { name: "COMUNIDAD", id: "cat-existing" });

    addPlannedChannel(config, community, {
      ...channel("general", "general", false),
      id: "channel-existing",
    });

    expect(config.categories.community?.id).toBe("cat-existing");
    expect(config.channels.general?.id).toBe("channel-existing");
  });

  it("builds the real requested example", () => {
    const config = makeStructureConfig();
    config.modules.announcements = true;
    config.modules.logs = true;

    const information = addPlannedCategory(config, { name: "INFORMACION" });
    const community = addPlannedCategory(config, { name: "COMUNIDAD" });
    const administration = addPlannedCategory(config, { name: "ADMINISTRACION" });

    addPlannedChannel(config, information, channel("bienvenida", "welcome", true));
    addPlannedChannel(config, information, channel("reglas", "rules", true));
    addPlannedChannel(config, information, channel("avisos", "announcements", true));
    addPlannedChannel(config, information, channel("guia", "custom", true));
    addPlannedChannel(config, community, channel("general", "general", false));
    addPlannedChannel(config, community, channel("streams", "custom", false));
    addPlannedChannel(config, community, channel("multimedia", "custom", false));
    addPlannedChannel(config, administration, channel("logs", "logs", true));

    expect(Object.keys(config.channels).sort()).toEqual([
      "announcements",
      "general",
      "guia",
      "logs",
      "multimedia",
      "rules",
      "streams",
      "welcome",
    ]);
    expect(config.channels.guia?.readOnlyForMembers).toBe(true);
    expect(config.channels.streams?.readOnlyForMembers).toBe(false);
  });

  it("does not modify Discord while building the in-memory plan", () => {
    const guild = makeGuildMock({ features: [] });
    const config = makeStructureConfig();
    const information = addPlannedCategory(config, { name: "INFORMACION" });

    addPlannedChannel(config, information, channel("bienvenida", "welcome", true));

    expect(channelCreateCalls(guild)).toHaveLength(0);
    expect(roleCreateCalls(guild)).toHaveLength(0);
  });

  it("can discard a plan without creating Discord resources", () => {
    const guild = makeGuildMock({ features: [] });
    const config = makeStructureConfig();
    const community = addPlannedCategory(config, { name: "COMUNIDAD" });

    addPlannedChannel(config, community, channel("general", "general", false));
    const discardedPlan = undefined;

    expect(discardedPlan).toBeUndefined();
    expect(channelCreateCalls(guild)).toHaveLength(0);
    expect(roleCreateCalls(guild)).toHaveLength(0);
  });

  it("preflight rejects duplicate unique functions in imported configs", () => {
    const config = toServerConfig(makeStructureConfig());
    config.channels.welcome = {
      name: "bienvenida",
      type: "text",
      categoryKey: "information",
      function: "welcome",
      readOnlyForMembers: true,
    };
    config.channels.hola = {
      name: "hola",
      type: "text",
      categoryKey: "information",
      function: "welcome",
      readOnlyForMembers: true,
    };
    config.channels.general = {
      name: "general",
      type: "text",
      categoryKey: "information",
      function: "general",
      readOnlyForMembers: false,
    };
    config.roles.pending = { name: "Sin verificar", enabled: true, protected: true };
    config.roles.member = { name: "Miembro", enabled: true, protected: true };

    const result = preflightStructurePlan(makeGuildMock({ features: [] }), config);

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("funcion unica"))).toBe(true);
  });
});

function makeStructureConfig(): StructureConfig {
  const modules = createDefaultModules();
  modules.welcome = true;
  modules.rules = true;
  modules.logs = false;
  return createEmptyStructureConfig("guild", "Comunidad", modules);
}

function channel(
  name: string,
  channelFunction: Parameters<typeof addPlannedChannel>[2]["function"],
  readOnlyForMembers: boolean,
): Parameters<typeof addPlannedChannel>[2] {
  return {
    name,
    type: "text",
    function: channelFunction,
    readOnlyForMembers,
  };
}

function toServerConfig(config: StructureConfig): ServerConfig {
  config.categories.information = { name: "INFORMACION" };
  return {
    ...config,
    rules: {
      enabled: config.modules.rules,
      sourcePath: "./data/rules.md",
      version: 1,
      requireReacceptOnRulesChange: false,
      rejectAction: "warn",
    },
    welcome: {
      channelEnabled: config.modules.welcome,
      dmEnabled: false,
      message: "Hola {user}",
    },
  };
}

function channelCreateCalls(guild: ReturnType<typeof makeGuildMock>): unknown[] {
  return (guild.channels as unknown as { create: { mock: { calls: unknown[] } } }).create.mock.calls;
}

function roleCreateCalls(guild: ReturnType<typeof makeGuildMock>): unknown[] {
  return (guild.roles as unknown as { create: { mock: { calls: unknown[] } } }).create.mock.calls;
}
