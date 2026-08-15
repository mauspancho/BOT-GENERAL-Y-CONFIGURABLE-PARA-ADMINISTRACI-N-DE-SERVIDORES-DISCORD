import fs from "node:fs";
import { describe, expect, it, type vi } from "vitest";
import { createDefaultModules, type ServerConfig } from "../src/core/config/schema.js";
import { compatibleReusableChannelsForConfig } from "../src/installer/wizard/configFactory.js";
import {
  applyInventoryToConfig,
  findChannelCandidates,
  getGuildInventorySnapshotPath,
  normalizeDiscordResourceName,
  scanAndPersistGuildInventory,
  scanGuildInventory,
  type GuildInventory,
} from "../src/installer/discord/guildInventory.js";
import { applyStructurePlan, rollbackCreatedResources } from "../src/installer/discord/setupDiscord.js";
import { category, forumChannel, makeGuildMock, role, textChannel, voiceChannel } from "./support/discordMocks.js";

describe("guild inventory reuse", () => {
  it("reuses existing #general and does not create another general", async () => {
    const config = configFor("guild");
    const guild = makeGuildMock({ features: [], channels: [textChannel("general-id", "general")] });

    applyInventoryToConfig(config, scanGuildInventory(guild));
    await applyStructurePlan(guild, config);

    expect(config.channels.general?.id).toBe("general-id");
    expect(createdChannelNames(guild)).not.toContain("general");
  });

  it("reuses existing #reglas when rules are active", () => {
    const config = configFor("guild");
    const guild = makeGuildMock({ features: [], channels: [textChannel("rules-id", "reglas")] });

    applyInventoryToConfig(config, scanGuildInventory(guild));

    expect(config.channels.rules?.id).toBe("rules-id");
  });

  it("recognizes decorated logical channel names", () => {
    expect(normalizeDiscordResourceName("📜・reglas")).toBe("reglas");
    const config = configFor("guild");
    const guild = makeGuildMock({ features: [], channels: [textChannel("rules-id", "📜・reglas")] });

    applyInventoryToConfig(config, scanGuildInventory(guild));

    expect(config.channels.rules?.id).toBe("rules-id");
  });

  it("does not use a voice channel called general as text general", () => {
    const config = configFor("guild");
    const inventory = scanGuildInventory(makeGuildMock({ features: [], channels: [voiceChannel("voice-id", "general")] }));

    const result = findChannelCandidates(inventory, "general", config.channels.general!);

    expect(result.status).toBe("none");
    applyInventoryToConfig(config, inventory);
    expect(config.channels.general?.id).toBeUndefined();
  });

  it("manual channel selector only offers compatible text channels", () => {
    const config = configFor("guild");
    const guild = makeGuildMock({
      features: [],
      channels: [voiceChannel("voice-general", "general"), textChannel("text-chat", "chat-general")],
    });

    const channels = compatibleReusableChannelsForConfig(guild, config.channels.general!);

    expect(channels.map((channel) => channel.id)).toEqual(["text-chat"]);
  });

  it("does not reuse a forum channel called general as text general", () => {
    const config = configFor("guild");
    const inventory = scanGuildInventory(makeGuildMock({
      features: [],
      channels: [forumChannel("forum-id", "general")],
    }));

    const result = applyInventoryToConfig(config, inventory);

    expect(inventory.channels[0]?.type).toBe("unsupported");
    expect(result.missing).toContain("channel:general");
    expect(config.channels.general?.id).toBeUndefined();
  });

  it("exact configured channel name wins over lower priority aliases", () => {
    const config = configFor("guild");
    const inventory = scanGuildInventory(makeGuildMock({
      features: [],
      channels: [textChannel("alias-id", "chat"), textChannel("exact-id", "general")],
    }));

    applyInventoryToConfig(config, inventory);

    expect(config.channels.general?.id).toBe("exact-id");
  });

  it("does not choose arbitrary channel when matches are ambiguous", () => {
    const config = configFor("guild");
    const inventory = scanGuildInventory(makeGuildMock({
      features: [],
      channels: [textChannel("general-1", "general"), textChannel("general-2", "💬・general")],
    }));

    const result = applyInventoryToConfig(config, inventory);

    expect(result.ambiguous).toContain("channel:general");
    expect(config.channels.general?.id).toBeUndefined();
  });

  it("two exact normalized channel matches are ambiguous", () => {
    const config = configFor("guild");
    const inventory = scanGuildInventory(makeGuildMock({
      features: [],
      channels: [textChannel("general-1", "general"), textChannel("general-2", "💬・general")],
    }));

    const result = findChannelCandidates(inventory, "general", config.channels.general!);

    expect(result.status).toBe("ambiguous");
  });

  it("reuses existing INFORMACION category", () => {
    const config = configFor("guild");
    const guild = makeGuildMock({ features: [], channels: [category("info-id", "INFORMACION")] });

    applyInventoryToConfig(config, scanGuildInventory(guild));

    expect(config.categories.information?.id).toBe("info-id");
  });

  it("exact category name wins over category alias", () => {
    const config = configFor("guild");
    const guild = makeGuildMock({
      features: [],
      channels: [category("alias-id", "info"), category("exact-id", "INFORMACION")],
    });

    applyInventoryToConfig(config, scanGuildInventory(guild));

    expect(config.categories.information?.id).toBe("exact-id");
  });

  it("reuses existing protected roles by normalized aliases", async () => {
    const config = configFor("guild");
    const guild = makeGuildMock({
      features: [],
      roles: [role("pending-id", "Sin Verificar"), role("member-id", "verified")],
    });

    applyInventoryToConfig(config, scanGuildInventory(guild));
    await applyStructurePlan(guild, config);

    expect(config.roles.pending?.id).toBe("pending-id");
    expect(config.roles.member?.id).toBe("member-id");
    expect(createdRoleNames(guild)).not.toContain("Sin verificar");
    expect(createdRoleNames(guild)).not.toContain("Miembro");
  });

  it("exact role name wins over role alias", () => {
    const config = configFor("guild");
    const guild = makeGuildMock({
      features: [],
      roles: [role("alias-id", "verified"), role("exact-id", "Miembro")],
    });

    applyInventoryToConfig(config, scanGuildInventory(guild));

    expect(config.roles.member?.id).toBe("exact-id");
  });

  it("does not choose arbitrary role when role matches are ambiguous", () => {
    const config = configFor("guild");
    const guild = makeGuildMock({
      features: [],
      roles: [role("member-1", "member"), role("member-2", "👤 member")],
    });

    const result = applyInventoryToConfig(config, scanGuildInventory(guild));

    expect(result.ambiguous).toContain("role:member");
    expect(config.roles.member?.id).toBeUndefined();
  });

  it("keeps existing channel category relationship without moving silently", async () => {
    const config = configFor("guild");
    const guild = makeGuildMock({
      features: [],
      channels: [category("other-cat", "OTRA"), textChannel("rules-id", "reglas", "other-cat")],
    });

    applyInventoryToConfig(config, scanGuildInventory(guild));
    await applyStructurePlan(guild, config);

    expect(config.channels.rules?.id).toBe("rules-id");
    expect(createdChannelNames(guild)).not.toContain("reglas");
  });

  it("rollback ignores reused resources and only deletes created resources", async () => {
    const reused = textChannel("general-id", "general");
    const created = textChannel("created-id", "logs");
    const guild = makeGuildMock({ features: [], channels: [reused, created] });

    await rollbackCreatedResources(guild, [
      { action: "skip", resourceType: "channel", key: "general", name: "general", id: "general-id" },
      { action: "create", resourceType: "channel", key: "logs", name: "logs", id: "created-id" },
    ]);

    expect((reused.delete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((created.delete as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("configured valid IDs have priority over name search", () => {
    const config = configFor("guild");
    config.channels.general!.id = "configured-id";
    const guild = makeGuildMock({
      features: [],
      channels: [textChannel("configured-id", "chat-principal"), textChannel("name-id", "general")],
    });

    applyInventoryToConfig(config, scanGuildInventory(guild));

    expect(config.channels.general?.id).toBe("configured-id");
    expect(config.channels.general?.name).toBe("general");
  });

  it("missing configured ID can be reassigned by inventory but validation should report without Discord mutation", () => {
    const config = configFor("guild");
    config.channels.general!.id = "missing-id";
    const guild = makeGuildMock({ features: [], channels: [textChannel("new-id", "general")] });

    applyInventoryToConfig(config, scanGuildInventory(guild));

    expect(config.channels.general?.id).toBe("new-id");
    expect((guild.channels.create as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("keeps inventories isolated by guild", () => {
    const chepe = configFor("guild-chepe");
    const maus = configFor("guild-maus");

    applyInventoryToConfig(chepe, scanGuildInventory(makeGuildMock({ id: "guild-chepe", features: [], channels: [textChannel("chepe-general", "general")] })));
    applyInventoryToConfig(maus, scanGuildInventory(makeGuildMock({ id: "guild-maus", features: [], channels: [textChannel("maus-general", "general")] })));

    expect(chepe.channels.general?.id).toBe("chepe-general");
    expect(maus.channels.general?.id).toBe("maus-general");
  });

  it("rejects inventory from another guild without applying IDs", () => {
    const config = configFor("guild-b");
    const inventory = scanGuildInventory(makeGuildMock({
      id: "guild-a",
      features: [],
      channels: [textChannel("a-general", "general")],
    }));

    expect(() => applyInventoryToConfig(config, inventory)).toThrow(/no pertenece/);
    expect(config.channels.general?.id).toBeUndefined();
  });

  it("persists a separated guild inventory snapshot", () => {
    const guildId = "guild-snapshot-test";
    const snapshotPath = getGuildInventorySnapshotPath(guildId);
    fs.rmSync(snapshotPath, { force: true });
    const guild = makeGuildMock({
      id: guildId,
      features: [],
      channels: [category("cat-id", "INFO"), textChannel("general-id", "general", "cat-id")],
      roles: [role("member-id", "Miembro")],
    });

    scanAndPersistGuildInventory(guild, new Date("2026-08-15T00:00:00.000Z"));
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as GuildInventory;

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.guildId).toBe(guildId);
    expect(snapshot.channels[0]?.parentId).toBe("cat-id");
    expect(snapshot.roles[0]?.id).toBe("member-id");

    fs.rmSync(snapshotPath, { force: true });
  });
});

function configFor(guildId: string): ServerConfig {
  const modules = createDefaultModules();
  modules.welcome = false;
  modules.rules = true;
  modules.logs = false;
  modules.generalAlerts = true;
  return {
    version: 1,
    guildId,
    communityName: "Comunidad",
    locale: "es",
    categories: {
      information: { name: "INFORMACION" },
      community: { name: "COMUNIDAD" },
    },
    channels: {
      general: { name: "general", type: "text", categoryKey: "community", function: "general", readOnlyForMembers: false },
      rules: { name: "reglas", type: "text", categoryKey: "information", function: "rules", readOnlyForMembers: true },
    },
    roles: {
      pending: { name: "Sin verificar", enabled: true, protected: true },
      member: { name: "Miembro", enabled: true, protected: true },
    },
    modules,
    rules: { enabled: true, sourcePath: "./data/guilds/guild/rules.md", version: 1, requireReacceptOnRulesChange: false, rejectAction: "warn" },
    welcome: { channelEnabled: false, dmEnabled: false, message: "Hola" },
    theIsleGuide: { enabled: false },
    tiktokAlerts: { enabled: false, pollingIntervalSeconds: 300, mention: "ninguna" },
  };
}

function createdChannelNames(guild: ReturnType<typeof makeGuildMock>): string[] {
  return (guild.channels.create as unknown as { mock: { calls: Array<[{ name: string }]> } }).mock.calls.map(
    ([values]) => values.name,
  );
}

function createdRoleNames(guild: ReturnType<typeof makeGuildMock>): string[] {
  return (guild.roles.create as unknown as { mock: { calls: Array<[{ name: string }]> } }).mock.calls.map(
    ([values]) => values.name,
  );
}
