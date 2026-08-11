import { describe, expect, it } from "vitest";
import { CONFIG_VERSION, createDefaultModules, serverConfigSchema } from "../src/core/config/schema.js";

describe("server config validation", () => {
  it("accepts a valid installation config", () => {
    const parsed = serverConfigSchema.parse({
      version: CONFIG_VERSION,
      guildId: "123",
      communityName: "Test",
      categories: { info: { name: "INFO", id: "1" } },
      channels: {
        rules: {
          name: "reglas",
          id: "2",
          type: "text",
          categoryKey: "info",
          function: "rules",
          readOnlyForMembers: true,
        },
      },
      roles: { member: { name: "Miembro", id: "3", enabled: true, protected: true } },
      modules: createDefaultModules(),
      rules: {
        enabled: true,
        sourcePath: "./data/rules.md",
        version: 1,
        requireReacceptOnRulesChange: false,
        rejectAction: "warn",
      },
      welcome: {
        channelEnabled: true,
        dmEnabled: false,
        message: "Hola {user}",
      },
      theIsleGuide: {
        enabled: false,
      },
    });

    expect(parsed.guildId).toBe("123");
  });

  it("migrates old configs without theIsleGuide section", () => {
    const parsed = serverConfigSchema.parse({
      version: CONFIG_VERSION,
      guildId: "123",
      communityName: "Test",
      categories: {},
      channels: {},
      roles: {},
      modules: {
        ...createDefaultModules(),
        theIsleGuide: true,
      },
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
        message: "Hola {user}",
      },
    });

    expect(parsed.theIsleGuide).toEqual({ enabled: true });
    expect(parsed.modules.theIsleGuide).toBe(true);
  });
});
