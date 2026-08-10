import type { Database } from "../core/database/sqlite.js";

export interface RuleAcceptance {
  guildId: string;
  userId: string;
  acceptedAt: string;
  rulesVersion: number;
}

export class RuleAcceptanceRepository {
  public constructor(private readonly database: Database) {}

  public hasAccepted(guildId: string, userId: string, rulesVersion: number): boolean {
    const row = this.database
      .prepare(
        "SELECT 1 FROM rule_acceptances WHERE guild_id = ? AND user_id = ? AND rules_version = ?",
      )
      .get(guildId, userId, rulesVersion);

    return row !== undefined;
  }

  public record(acceptance: RuleAcceptance): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO rule_acceptances
          (guild_id, user_id, accepted_at, rules_version)
        VALUES (?, ?, ?, ?)`,
      )
      .run(
        acceptance.guildId,
        acceptance.userId,
        acceptance.acceptedAt,
        acceptance.rulesVersion,
      );
  }
}
