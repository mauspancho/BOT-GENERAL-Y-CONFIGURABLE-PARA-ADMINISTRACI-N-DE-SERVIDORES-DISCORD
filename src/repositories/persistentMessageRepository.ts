import type { Database } from "../core/database/sqlite.js";

export interface PersistentMessageRecord {
  guildId: string;
  channelId: string;
  messageId: string;
  panelType: string;
  version: number;
  contentHash: string;
  updatedAt: string;
}

interface PersistentMessageRow {
  guild_id: string;
  channel_id: string;
  message_id: string;
  panel_type: string;
  version: number;
  content_hash: string;
  updated_at: string;
}

export class PersistentMessageRepository {
  public constructor(private readonly database: Database) {}

  public find(guildId: string, panelType: string): PersistentMessageRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM persistent_messages WHERE guild_id = ? AND panel_type = ?")
      .get(guildId, panelType) as PersistentMessageRow | undefined;

    if (!row) {
      return undefined;
    }

    return {
      guildId: row.guild_id,
      channelId: row.channel_id,
      messageId: row.message_id,
      panelType: row.panel_type,
      version: row.version,
      contentHash: row.content_hash,
      updatedAt: row.updated_at,
    };
  }

  public upsert(record: PersistentMessageRecord): void {
    this.database
      .prepare(
        `INSERT INTO persistent_messages
          (guild_id, channel_id, message_id, panel_type, version, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, panel_type) DO UPDATE SET
          channel_id = excluded.channel_id,
          message_id = excluded.message_id,
          version = excluded.version,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at`,
      )
      .run(
        record.guildId,
        record.channelId,
        record.messageId,
        record.panelType,
        record.version,
        record.contentHash,
        record.updatedAt,
      );
  }
}
