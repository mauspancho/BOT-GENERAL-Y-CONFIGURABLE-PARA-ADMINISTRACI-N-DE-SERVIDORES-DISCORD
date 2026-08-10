import { describe, expect, it } from "vitest";
import { createDefaultModules } from "../src/core/config/schema.js";
import { getRequiredPermissions } from "../src/core/permissions/requiredPermissions.js";

describe("permission resolver", () => {
  it("requires Kick Members only when reject action is kick", () => {
    const base = {
      modules: createDefaultModules(),
      rules: {
        enabled: true,
        sourcePath: "./data/rules.md",
        version: 1,
        requireReacceptOnRulesChange: false,
        rejectAction: "warn" as const,
      },
    };

    expect(getRequiredPermissions(base).map((permission) => permission.name)).not.toContain("Kick Members");
    expect(
      getRequiredPermissions({
        ...base,
        rules: { ...base.rules, rejectAction: "kick" },
      }).map((permission) => permission.name),
    ).toContain("Kick Members");
  });

  it("does not require Manage Messages for logs alone", () => {
    const modules = createDefaultModules();
    modules.logs = true;
    modules.moderation = false;

    const permissions = getRequiredPermissions({
      modules,
      rules: {
        enabled: true,
        sourcePath: "./data/rules.md",
        version: 1,
        requireReacceptOnRulesChange: false,
        rejectAction: "warn",
      },
    }).map((permission) => permission.name);

    expect(permissions).not.toContain("Manage Messages");
  });

  it("requires Manage Messages for moderation", () => {
    const modules = createDefaultModules();
    modules.logs = true;
    modules.moderation = true;

    const permissions = getRequiredPermissions({
      modules,
      rules: {
        enabled: true,
        sourcePath: "./data/rules.md",
        version: 1,
        requireReacceptOnRulesChange: false,
        rejectAction: "warn",
      },
    }).map((permission) => permission.name);

    expect(permissions).toContain("Manage Messages");
  });
});
