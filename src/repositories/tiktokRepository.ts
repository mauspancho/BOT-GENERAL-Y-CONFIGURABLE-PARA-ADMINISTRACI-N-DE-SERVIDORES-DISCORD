import type { Database, SqlRow } from "../core/database/sqlite.js";
import type { TikTokConnection, TikTokOAuthState } from "../modules/tiktokAlerts/tiktokTypes.js";

interface TikTokConnectionRow extends SqlRow {
  guild_id: string;
  open_id: string;
  display_name: string;
  avatar_url: string | null;
  scopes: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  connected_at: string;
  access_token_expires_at: string;
  refresh_token_expires_at: string;
  enabled: number;
  last_check_at: string | null;
  last_success_at: string | null;
  last_video_id: string | null;
}

interface TikTokStateRow extends SqlRow {
  state: string;
  guild_id: string;
  discord_user_id: string;
  created_at: string;
  expires_at: string;
  used: number;
}

export class TikTokRepository {
  public constructor(private readonly database: Database) {}

  public createOAuthState(state: TikTokOAuthState): void {
    this.database
      .prepare(
        `INSERT INTO tiktok_oauth_states
          (state, guild_id, discord_user_id, created_at, expires_at, used)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(state.state, state.guildId, state.discordUserId, state.createdAt, state.expiresAt, state.used ? 1 : 0);
  }

  public findOAuthState(state: string): TikTokOAuthState | undefined {
    const row = this.database
      .prepare("SELECT * FROM tiktok_oauth_states WHERE state = ?")
      .get(state) as TikTokStateRow | undefined;
    return row ? mapState(row) : undefined;
  }

  public consumeOAuthState(state: string, now = new Date()): TikTokOAuthState {
    const record = this.findOAuthState(state);
    if (!record) {
      throw new Error("State TikTok invalido.");
    }
    if (record.used) {
      throw new Error("State TikTok ya utilizado.");
    }
    if (new Date(record.expiresAt).getTime() <= now.getTime()) {
      throw new Error("State TikTok expirado.");
    }

    this.database.prepare("UPDATE tiktok_oauth_states SET used = 1 WHERE state = ?").run(state);
    return record;
  }

  public upsertConnection(connection: TikTokConnection): void {
    this.database
      .prepare(
        `INSERT INTO tiktok_connections
          (guild_id, open_id, display_name, avatar_url, scopes, encrypted_access_token, encrypted_refresh_token,
           connected_at, access_token_expires_at, refresh_token_expires_at, enabled, last_check_at,
           last_success_at, last_video_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
          open_id = excluded.open_id,
          display_name = excluded.display_name,
          avatar_url = excluded.avatar_url,
          scopes = excluded.scopes,
          encrypted_access_token = excluded.encrypted_access_token,
          encrypted_refresh_token = excluded.encrypted_refresh_token,
          connected_at = excluded.connected_at,
          access_token_expires_at = excluded.access_token_expires_at,
          refresh_token_expires_at = excluded.refresh_token_expires_at,
          enabled = excluded.enabled,
          last_check_at = excluded.last_check_at,
          last_success_at = excluded.last_success_at,
          last_video_id = excluded.last_video_id`,
      )
      .run(
        connection.guildId,
        connection.openId,
        connection.displayName,
        connection.avatarUrl ?? null,
        connection.scopes.join(","),
        connection.encryptedAccessToken,
        connection.encryptedRefreshToken,
        connection.connectedAt,
        connection.accessTokenExpiresAt,
        connection.refreshTokenExpiresAt,
        connection.enabled ? 1 : 0,
        connection.lastCheckAt ?? null,
        connection.lastSuccessAt ?? null,
        connection.lastVideoId ?? null,
      );
  }

  public findConnection(guildId: string): TikTokConnection | undefined {
    const row = this.database
      .prepare("SELECT * FROM tiktok_connections WHERE guild_id = ?")
      .get(guildId) as TikTokConnectionRow | undefined;
    return row ? mapConnection(row) : undefined;
  }

  public listEnabledConnections(): TikTokConnection[] {
    return this.database
      .prepare("SELECT * FROM tiktok_connections WHERE enabled = 1")
      .all()
      .map((row) => mapConnection(row as TikTokConnectionRow));
  }

  public setConnectionEnabled(guildId: string, enabled: boolean): void {
    this.database.prepare("UPDATE tiktok_connections SET enabled = ? WHERE guild_id = ?").run(enabled ? 1 : 0, guildId);
  }

  public updateConnectionTokens(
    guildId: string,
    values: {
      encryptedAccessToken: string;
      encryptedRefreshToken: string;
      accessTokenExpiresAt: string;
      refreshTokenExpiresAt: string;
    },
  ): void {
    this.database
      .prepare(
        `UPDATE tiktok_connections
        SET encrypted_access_token = ?, encrypted_refresh_token = ?,
            access_token_expires_at = ?, refresh_token_expires_at = ?
        WHERE guild_id = ?`,
      )
      .run(
        values.encryptedAccessToken,
        values.encryptedRefreshToken,
        values.accessTokenExpiresAt,
        values.refreshTokenExpiresAt,
        guildId,
      );
  }

  public updatePollingState(
    guildId: string,
    values: { lastCheckAt: string; lastSuccessAt?: string | undefined; lastVideoId?: string | undefined },
  ): void {
    this.database
      .prepare(
        `UPDATE tiktok_connections
        SET last_check_at = ?, last_success_at = COALESCE(?, last_success_at),
            last_video_id = COALESCE(?, last_video_id)
        WHERE guild_id = ?`,
      )
      .run(values.lastCheckAt, values.lastSuccessAt ?? null, values.lastVideoId ?? null, guildId);
  }

  public deleteConnection(guildId: string): void {
    this.database.prepare("DELETE FROM tiktok_connections WHERE guild_id = ?").run(guildId);
    this.database.prepare("DELETE FROM tiktok_oauth_states WHERE guild_id = ?").run(guildId);
  }

  public hasPublishedVideo(guildId: string, openId: string, videoId: string): boolean {
    return Boolean(
      this.database
        .prepare("SELECT 1 FROM tiktok_published_videos WHERE guild_id = ? AND open_id = ? AND video_id = ?")
        .get(guildId, openId, videoId),
    );
  }

  public markVideoPublished(guildId: string, openId: string, videoId: string, createTime: number | undefined): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO tiktok_published_videos
          (guild_id, open_id, video_id, create_time, published_at)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .run(guildId, openId, videoId, createTime ?? null, new Date().toISOString());
  }
}

function mapState(row: TikTokStateRow): TikTokOAuthState {
  return {
    state: row.state,
    guildId: row.guild_id,
    discordUserId: row.discord_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    used: row.used === 1,
  };
}

function mapConnection(row: TikTokConnectionRow): TikTokConnection {
  return {
    guildId: row.guild_id,
    openId: row.open_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url ?? undefined,
    scopes: row.scopes.split(",").filter(Boolean),
    encryptedAccessToken: row.encrypted_access_token,
    encryptedRefreshToken: row.encrypted_refresh_token,
    connectedAt: row.connected_at,
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
    enabled: row.enabled === 1,
    lastCheckAt: row.last_check_at ?? undefined,
    lastSuccessAt: row.last_success_at ?? undefined,
    lastVideoId: row.last_video_id ?? undefined,
  };
}
