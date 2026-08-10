import { describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../src/core/database/sqlite.js";
import { RuleAcceptanceRepository } from "../src/repositories/ruleAcceptanceRepository.js";
import { PersistentMessageRepository } from "../src/repositories/persistentMessageRepository.js";

describe("sqlite repositories", () => {
  it("stores acceptances and persistent messages idempotently", async () => {
    const database = await openMemoryDatabase();

    const acceptances = new RuleAcceptanceRepository(database);
    acceptances.record({
      guildId: "g",
      userId: "u",
      acceptedAt: "2026-08-10T00:00:00.000Z",
      rulesVersion: 1,
    });
    acceptances.record({
      guildId: "g",
      userId: "u",
      acceptedAt: "2026-08-10T00:00:00.000Z",
      rulesVersion: 1,
    });
    expect(acceptances.hasAccepted("g", "u", 1)).toBe(true);

    const messages = new PersistentMessageRepository(database);
    messages.upsert({
      guildId: "g",
      channelId: "c",
      messageId: "m",
      panelType: "rules",
      version: 1,
      contentHash: "h",
      updatedAt: "now",
    });
    messages.upsert({
      guildId: "g",
      channelId: "c2",
      messageId: "m2",
      panelType: "rules",
      version: 2,
      contentHash: "h2",
      updatedAt: "later",
    });

    expect(messages.find("g", "rules")?.messageId).toBe("m2");
    database.close();
  });
});
