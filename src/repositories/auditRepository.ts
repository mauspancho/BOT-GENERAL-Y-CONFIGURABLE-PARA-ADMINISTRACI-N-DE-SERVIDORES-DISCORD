import type { Database } from "../core/database/sqlite.js";

export interface AuditEvent {
  guildId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  status: "success" | "warning" | "error";
}

export class AuditRepository {
  public constructor(private readonly database: Database) {}

  public record(event: AuditEvent): void {
    this.database
      .prepare(
        `INSERT INTO audit_events
          (timestamp, guild_id, action, resource_type, resource_id, old_value, new_value, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        event.guildId,
        event.action,
        event.resourceType,
        event.resourceId ?? null,
        event.oldValue === undefined ? null : JSON.stringify(event.oldValue),
        event.newValue === undefined ? null : JSON.stringify(event.newValue),
        event.status,
      );
  }
}
