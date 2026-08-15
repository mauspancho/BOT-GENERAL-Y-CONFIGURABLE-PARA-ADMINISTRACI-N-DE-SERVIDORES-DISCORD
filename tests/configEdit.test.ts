import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GuildConfigManager } from "../src/core/config/guildConfigManager.js";
import { writeServerConfig } from "../src/core/config/configStore.js";
import { createDefaultModules, type ServerConfig } from "../src/core/config/schema.js";
import { GuildConfigEditSession } from "../src/installer/configEdit/GuildConfigEditSession.js";
import { formatConfigDiff } from "../src/installer/configEdit/configDiff.js";
import { applyPlannedFileOperations } from "../src/installer/configEdit/plannedFileOperations.js";
import {
  addLogicalChannel,
  patchCategoryName,
  patchManagedRulesContent,
  patchRulesExternalPath,
  patchRulesImport,
  patchTikTokAlerts,
  patchWelcome,
} from "../src/installer/configEdit/sectionPatches.js";
import {
  applyConfigEditTransaction,
  shouldEnsureRulesPanel,
  shouldRegisterCommands,
} from "../src/installer/configEdit/setupTransaction.js";
import { managedRulesAbsolutePath, managedRulesSourcePath } from "../src/installer/configEdit/rulesStorage.js";
import { preflightStructurePlan } from "../src/installer/discord/setupDiscord.js";
import { makeGuildMock } from "./support/discordMocks.js";

describe("patch-based guild config editing", () => {
  it("modifying TikTok Chepe preserves unrelated sections exactly", () => {
    const before = configFor("guild-chepe");
    const session = new GuildConfigEditSession(before);

    patchTikTokAlerts(session.getWorking(), { enabled: true, pollingIntervalSeconds: 600 });
    session.markChanged("tiktokAlerts");

    const after = session.getWorking();
    expect(after.rules).toEqual(before.rules);
    expect(after.welcome).toEqual(before.welcome);
    expect(after.channels).toEqual(before.channels);
    expect(after.categories).toEqual(before.categories);
    expect(after.roles).toEqual(before.roles);
    expect(after.theIsleGuide).toEqual(before.theIsleGuide);
    expect(after.rules.version).toBe(7);
    expect(after.rules.sourcePath).toBe("/home/test/reglaschepe.md");
  });

  it("modifying Chepe rules leaves Maus config and rules file unchanged", async () => {
    const root = tempRoot();
    const manager = managerFor(root);
    const chepe = configFor("guild-chepe");
    const maus = configFor("guild-maus");
    manager.save(chepe.guildId, chepe);
    manager.save(maus.guildId, maus);
    const mausRules = path.join(root, "maus-rules.md");
    fs.writeFileSync(mausRules, "maus rules\n", "utf8");
    maus.rules.sourcePath = mausRules;
    manager.save(maus.guildId, maus);

    const session = new GuildConfigEditSession(manager.get("guild-chepe"));
    patchRulesExternalPath(session.getWorking(), path.join(root, "chepe-rules.md"));
    session.markChanged("rules");
    await applyConfigEditTransaction({
      session,
      configManager: manager,
      backup: vi.fn(),
    });

    expect(manager.get("guild-maus")).toEqual(maus);
    expect(fs.readFileSync(mausRules, "utf8")).toBe("maus rules\n");
  });

  it("modifying welcome keeps Chepe rules byte-for-byte unchanged", async () => {
    const root = tempRoot();
    const rulesPath = path.join(root, "rules.md");
    fs.writeFileSync(rulesPath, "reglas exactas\n", "utf8");
    const manager = managerFor(root);
    const config = configFor("guild-chepe");
    config.rules.sourcePath = rulesPath;
    manager.save(config.guildId, config);
    const beforeBytes = fs.readFileSync(rulesPath, "utf8");
    const session = new GuildConfigEditSession(manager.get(config.guildId));

    patchWelcome(session.getWorking(), { message: "Nuevo mensaje {user}" });
    session.markChanged("welcome");
    await applyConfigEditTransaction({ session, configManager: manager, backup: vi.fn() });

    expect(fs.readFileSync(rulesPath, "utf8")).toBe(beforeBytes);
  });

  it("modifying a category preserves existing channel ids and logical functions", () => {
    const before = configFor("guild-chepe");
    const session = new GuildConfigEditSession(before);

    patchCategoryName(session.getWorking(), "information", "INFO NUEVA");
    session.markChanged("structure");

    expect(session.getWorking().channels).toEqual(before.channels);
    expect(session.getWorking().channels.general?.id).toBe("general-guild-chepe");
    expect(session.getWorking().channels.theIsleGuide?.function).toBe("theIsleGuide");
  });

  it("cancel discards changes and leaves files byte-for-byte equal", () => {
    const root = tempRoot();
    const manager = managerFor(root);
    const config = configFor("guild-chepe");
    manager.save(config.guildId, config);
    const configPath = manager.pathFor(config.guildId);
    const beforeBytes = fs.readFileSync(configPath, "utf8");
    const session = new GuildConfigEditSession(manager.get(config.guildId));

    patchTikTokAlerts(session.getWorking(), { pollingIntervalSeconds: 900 });
    session.markChanged("tiktokAlerts");
    session.discard();

    expect(fs.readFileSync(configPath, "utf8")).toBe(beforeBytes);
    expect(session.hasChanges()).toBe(false);
  });

  it("preflight failure prevents writes", async () => {
    const root = tempRoot();
    const manager = managerFor(root);
    const config = configFor("guild-chepe");
    manager.save(config.guildId, config);
    const session = new GuildConfigEditSession(manager.get(config.guildId));
    delete session.getWorking().channels.general;
    session.markChanged("structure");

    await expect(
      applyConfigEditTransaction({
        session,
        configManager: manager,
        backup: vi.fn(),
        guild: makeGuildMock({ features: [] }),
        applyDiscordStructure: true,
      }),
    ).rejects.toThrow("Falta el canal logico \"general\"");
    expect(manager.get(config.guildId)).toEqual(config);
  });

  it("backup is created before deferred file writes", async () => {
    const root = tempRoot();
    const manager = managerFor(root);
    const config = configFor("guild-chepe");
    manager.save(config.guildId, config);
    const source = path.join(root, "created-by-backup.md");
    const target = path.join(root, "rules-target.md");
    const session = new GuildConfigEditSession(manager.get(config.guildId));
    patchRulesExternalPath(session.getWorking(), target);
    session.markChanged("rules");

    await applyConfigEditTransaction({
      session,
      configManager: manager,
      backup: () => fs.writeFileSync(source, "backup first\n", "utf8"),
      fileOperations: [{ type: "copyFile", sourcePath: source, targetPath: target }],
    });

    expect(fs.readFileSync(target, "utf8")).toBe("backup first\n");
  });

  it("rules version and sourcePath do not change when editing TikTok polling", () => {
    const before = configFor("guild-chepe");
    const session = new GuildConfigEditSession(before);

    patchTikTokAlerts(session.getWorking(), { pollingIntervalSeconds: 600 });
    session.markChanged("tiktokAlerts");

    expect(session.getWorking().rules.version).toBe(7);
    expect(session.getWorking().rules.sourcePath).toBe("/home/test/reglaschepe.md");
  });

  it("external rules path is never overwritten by another module edit", async () => {
    const root = tempRoot();
    const external = path.join(root, "reglaschepe.md");
    fs.writeFileSync(external, "externo\n", "utf8");
    const manager = managerFor(root);
    const config = configFor("guild-chepe");
    config.rules.sourcePath = external;
    manager.save(config.guildId, config);
    const session = new GuildConfigEditSession(manager.get(config.guildId));

    patchTikTokAlerts(session.getWorking(), { pollingIntervalSeconds: 600 });
    session.markChanged("tiktokAlerts");
    await applyConfigEditTransaction({ session, configManager: manager, backup: vi.fn() });

    expect(fs.readFileSync(external, "utf8")).toBe("externo\n");
    expect(manager.get(config.guildId).rules.sourcePath).toBe(external);
  });

  it("two guilds can use different managed rules files", () => {
    expect(managedRulesSourcePath("guild-chepe")).toBe("./data/guilds/guild-chepe/rules.md");
    expect(managedRulesSourcePath("guild-maus")).toBe("./data/guilds/guild-maus/rules.md");
    expect(managedRulesAbsolutePath("guild-chepe")).not.toBe(managedRulesAbsolutePath("guild-maus"));
  });

  it("activating TikTok Chepe does not activate TikTok Maus", async () => {
    const root = tempRoot();
    const manager = managerFor(root);
    manager.save("guild-chepe", configFor("guild-chepe"));
    manager.save("guild-maus", configFor("guild-maus"));
    const session = new GuildConfigEditSession(manager.get("guild-chepe"));

    patchTikTokAlerts(session.getWorking(), { enabled: true });
    session.markChanged("tiktokAlerts");
    await applyConfigEditTransaction({ session, configManager: manager, backup: vi.fn() });

    expect(manager.get("guild-chepe").modules.tiktokAlerts).toBe(true);
    expect(manager.get("guild-maus").modules.tiktokAlerts).toBe(false);
  });

  it("configuring TikTok Developer global does not modify guild JSON", () => {
    const root = tempRoot();
    const manager = managerFor(root);
    const config = configFor("guild-chepe");
    manager.save(config.guildId, config);
    const before = fs.readFileSync(manager.pathFor(config.guildId), "utf8");
    const envPath = path.join(root, ".env");

    applyPlannedFileOperations([
      { type: "patchEnv", envPath, values: { TIKTOK_CLIENT_SECRET: "new-secret" }, ensureTikTokEncryptionKey: true },
    ]);

    expect(fs.readFileSync(manager.pathFor(config.guildId), "utf8")).toBe(before);
  });

  it("modifying Client Secret preserves all remaining env variables", () => {
    const root = tempRoot();
    const envPath = path.join(root, ".env");
    fs.writeFileSync(
      envPath,
      "DISCORD_TOKEN=token\nDISCORD_CLIENT_ID=client\nNODE_ENV=production\nCUSTOM_FLAG=yes\nTIKTOK_CLIENT_SECRET=old\n",
      "utf8",
    );

    applyPlannedFileOperations([{ type: "patchEnv", envPath, values: { TIKTOK_CLIENT_SECRET: "new" } }]);

    const env = fs.readFileSync(envPath, "utf8");
    expect(env).toContain("DISCORD_TOKEN=token");
    expect(env).toContain("DISCORD_CLIENT_ID=client");
    expect(env).toContain("NODE_ENV=production");
    expect(env).toContain("CUSTOM_FLAG=yes");
    expect(env).toContain("TIKTOK_CLIENT_SECRET=new");
  });

  it("activating a module with a missing channel can patch only that channel", () => {
    const config = configFor("guild-chepe");
    delete config.channels.welcome;
    const beforeChannels = { ...config.channels };

    addLogicalChannel(config, "welcome", {
      name: "bienvenida",
      id: "welcome-new",
      type: "text",
      categoryKey: "information",
      function: "welcome",
      readOnlyForMembers: true,
    });

    expect(config.channels.general).toEqual(beforeChannels.general);
    expect(config.channels.rules).toEqual(beforeChannels.rules);
    expect((config.channels as Record<string, { id?: string }>).welcome?.id).toBe("welcome-new");
  });

  it("repairing one channel does not rebuild all channels", () => {
    const config = configFor("guild-chepe");
    const beforeGeneral = config.channels.general;

    addLogicalChannel(config, "customNews", {
      name: "noticias",
      type: "text",
      function: "custom",
      readOnlyForMembers: false,
    });

    expect(config.channels.general).toBe(beforeGeneral);
    expect(Object.keys(config.channels)).toContain("customNews");
  });

  it("legacy migration preserves channel ids", () => {
    const root = tempRoot();
    const legacyPath = path.join(root, "config", "server.json");
    const manager = new GuildConfigManager(path.join(root, "config", "guilds"), legacyPath);
    const legacy = configFor("guild-chepe");
    writeServerConfig(legacyPath, legacy);

    manager.migrateLegacyConfig();

    expect(manager.get("guild-chepe").channels.general?.id).toBe("general-guild-chepe");
    expect(manager.get("guild-chepe").channels.welcome?.id).toBe("welcome-guild-chepe");
  });

  it("legacy plus multi-guild conflict never overwrites automatically", () => {
    const root = tempRoot();
    const legacyPath = path.join(root, "config", "server.json");
    const manager = new GuildConfigManager(path.join(root, "config", "guilds"), legacyPath);
    const legacy = configFor("guild-chepe");
    const current = configFor("guild-chepe");
    current.communityName = "Multi actual";
    writeServerConfig(legacyPath, legacy);
    manager.save(current.guildId, current);

    manager.migrateLegacyConfig();

    expect(manager.findLegacyConflict()?.guildId).toBe("guild-chepe");
    expect(manager.get("guild-chepe").communityName).toBe("Multi actual");
  });

  it("modify server edits do not need the full install wizard", () => {
    const session = new GuildConfigEditSession(configFor("guild-chepe"));

    patchTikTokAlerts(session.getWorking(), { enabled: true });
    session.markChanged("tiktokAlerts");

    expect(session.getDiff().map((entry) => entry.path)).toEqual([
      "modules.tiktokAlerts",
      "tiktokAlerts.enabled",
    ]);
  });

  it("no-op edit does not write config", async () => {
    const manager = { save: vi.fn() };
    const session = new GuildConfigEditSession(configFor("guild-chepe"));
    const result = await applyConfigEditTransaction({ session, configManager: manager, backup: vi.fn() });

    expect(result.reason).toBe("no-op");
    expect(manager.save).not.toHaveBeenCalled();
  });

  it("modifying TikTok does not request rules panel updates", () => {
    const before = configFor("guild-chepe");
    const after = structuredClone(before);
    after.modules.tiktokAlerts = true;
    after.tiktokAlerts.enabled = true;

    expect(shouldEnsureRulesPanel(before, after, ["tiktokAlerts"])).toBe(false);
  });

  it("modifying rules.rejectAction does not require Discord structure changes", () => {
    const before = configFor("guild-chepe");
    const after = structuredClone(before);
    after.rules.rejectAction = "warn";

    expect(shouldEnsureRulesPanel(before, after, ["rules"])).toBe(false);
  });

  it("modifying TikTok polling does not modify Discord structure", async () => {
    const root = tempRoot();
    const manager = managerFor(root);
    const config = configFor("guild-chepe");
    manager.save(config.guildId, config);
    const session = new GuildConfigEditSession(manager.get(config.guildId));
    patchTikTokAlerts(session.getWorking(), { pollingIntervalSeconds: 700 });
    session.markChanged("tiktokAlerts");
    const guild = makeGuildMock({ features: [] });

    await applyConfigEditTransaction({ session, configManager: manager, backup: vi.fn(), guild, applyDiscordStructure: false });

    expect((guild.channels as unknown as { create: { mock: { calls: unknown[] } } }).create.mock.calls).toHaveLength(0);
  });

  it("each operation uses the selected guild id", () => {
    const chepe = new GuildConfigEditSession(configFor("guild-chepe"));
    const maus = new GuildConfigEditSession(configFor("guild-maus"));

    patchManagedRulesContent(chepe.getWorking(), "chepe");
    patchTikTokAlerts(maus.getWorking(), { enabled: true });

    expect(chepe.getWorking().rules.sourcePath).toContain("guild-chepe");
    expect(maus.getWorking().guildId).toBe("guild-maus");
  });

  it("a failed Chepe edit does not affect Maus", async () => {
    const root = tempRoot();
    const manager = managerFor(root);
    const chepe = configFor("guild-chepe");
    const maus = configFor("guild-maus");
    manager.save(chepe.guildId, chepe);
    manager.save(maus.guildId, maus);
    const session = new GuildConfigEditSession(manager.get("guild-chepe"));
    delete session.getWorking().channels.general;
    session.markChanged("structure");

    await expect(
      applyConfigEditTransaction({
        session,
        configManager: manager,
        backup: vi.fn(),
        guild: makeGuildMock({ features: [] }),
        applyDiscordStructure: true,
      }),
    ).rejects.toThrow();
    expect(manager.get("guild-maus")).toEqual(maus);
  });

  it("bug regression: TikTok edit does not report missing existing logical channels", () => {
    const config = configFor("guild-chepe");
    const session = new GuildConfigEditSession(config);
    patchTikTokAlerts(session.getWorking(), { pollingIntervalSeconds: 600 });
    session.markChanged("tiktokAlerts");

    const result = preflightStructurePlan(makeGuildMock({ features: ["COMMUNITY"] }), session.getWorking());

    expect(result.errors.join("\n")).not.toContain("Falta el canal logico \"general\"");
    expect(result.errors.join("\n")).not.toContain("Falta el canal logico \"welcome\"");
    expect(result.errors.join("\n")).not.toContain("Falta el canal logico \"rules\"");
    expect(result.errors.join("\n")).not.toContain("Falta el canal logico \"announcements\"");
    expect(result.errors.join("\n")).not.toContain("Falta el canal logico \"theIsleGuide\"");
    expect(session.getWorking().channels).toEqual(config.channels);
  });

  it("bug regression: external rules settings survive TikTok polling edit", () => {
    const before = configFor("guild-chepe");
    before.rules = {
      enabled: true,
      sourcePath: "/home/test/reglaschepe.md",
      version: 7,
      requireReacceptOnRulesChange: true,
      rejectAction: "keep_pending",
    };
    const session = new GuildConfigEditSession(before);

    patchTikTokAlerts(session.getWorking(), { pollingIntervalSeconds: 600 });
    session.markChanged("tiktokAlerts");

    expect(session.getWorking().rules).toEqual(before.rules);
  });

  it("diff displays changed and unchanged sections", () => {
    const before = configFor("guild-chepe");
    const after = structuredClone(before);
    after.tiktokAlerts.pollingIntervalSeconds = 600;

    const diff = formatConfigDiff(before, after);

    expect(diff).toContain("tiktokAlerts.pollingIntervalSeconds");
    expect(diff).toContain("rules");
    expect(diff).toContain("welcome");
  });

  it("command registration is limited to module changes", () => {
    const before = configFor("guild-chepe");
    const after = structuredClone(before);
    after.tiktokAlerts.pollingIntervalSeconds = 600;
    expect(shouldRegisterCommands(before, after)).toBe(false);

    after.modules.tiktokAlerts = true;
    expect(shouldRegisterCommands(before, after)).toBe(true);
  });

  it("importing rules bumps only Chepe version and points to guild storage", () => {
    const session = new GuildConfigEditSession(configFor("guild-chepe"));
    const result = patchRulesImport(session.getWorking(), "/tmp/source.md");

    expect(session.getWorking().rules.version).toBe(8);
    expect(session.getWorking().rules.sourcePath).toBe("./data/guilds/guild-chepe/rules.md");
    expect(result.fileOperations[0]).toMatchObject({ type: "copyFile", targetPath: managedRulesAbsolutePath("guild-chepe") });
  });
});

function configFor(guildId: string): ServerConfig {
  const modules = createDefaultModules();
  modules.welcome = true;
  modules.rules = true;
  modules.logs = true;
  modules.generalAlerts = true;
  modules.announcements = true;
  modules.theIsleGuide = true;
  modules.tiktokAlerts = false;
  return {
    version: 1,
    guildId,
    communityName: guildId.includes("chepe") ? "Chepe" : "Maus",
    locale: "es",
    categories: {
      information: { name: "INFORMACION", id: `info-${guildId}` },
      community: { name: "COMUNIDAD", id: `community-${guildId}` },
      administration: { name: "ADMINISTRACION", id: `admin-${guildId}` },
    },
    channels: {
      general: channel(guildId, "general", "general", "community", false),
      welcome: channel(guildId, "welcome", "welcome", "information", true),
      rules: channel(guildId, "rules", "rules", "information", true),
      announcements: channel(guildId, "announcements", "announcements", "information", true),
      theIsleGuide: channel(guildId, "theIsleGuide", "theIsleGuide", "information", true),
      logs: channel(guildId, "logs", "logs", "administration", true),
    },
    roles: {
      pending: { name: "Sin verificar", id: `pending-${guildId}`, enabled: true, protected: true },
      member: { name: "Miembro", id: `member-${guildId}`, enabled: true, protected: true },
    },
    modules,
    rules: {
      enabled: true,
      sourcePath: guildId.includes("chepe") ? "/home/test/reglaschepe.md" : "/home/test/reglasmaus.md",
      version: 7,
      requireReacceptOnRulesChange: true,
      rejectAction: "keep_pending",
    },
    welcome: { channelEnabled: true, dmEnabled: true, message: `Bienvenido ${guildId}` },
    theIsleGuide: { enabled: true, sourcePath: `/guides/${guildId}.md` },
    tiktokAlerts: { enabled: false, pollingIntervalSeconds: 300, mention: "ninguna" },
  };
}

function channel(
  guildId: string,
  key: string,
  channelFunction: ServerConfig["channels"][string]["function"],
  categoryKey: string,
  readOnlyForMembers: boolean,
): ServerConfig["channels"][string] {
  return {
    name: key,
    id: `${key}-${guildId}`,
    type: channelFunction === "announcements" ? "announcement" : "text",
    categoryKey,
    function: channelFunction,
    readOnlyForMembers,
  };
}

function managerFor(root: string): GuildConfigManager {
  return new GuildConfigManager(path.join(root, "config", "guilds"), path.join(root, "config", "server.json"));
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "config-edit-"));
}
