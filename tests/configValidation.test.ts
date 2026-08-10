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
    });

    expect(parsed.guildId).toBe("123");
  });
});
