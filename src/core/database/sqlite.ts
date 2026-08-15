import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";
import { DatabaseError } from "../errors/AppError.js";

const require = createRequire(import.meta.url);

export type SqlValue = string | number | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface PreparedStatement {
  run(...params: SqlValue[]): void;
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  close(): void;
  save(): void;
}

let sqlFactory: Promise<SqlJsStatic> | undefined;

const migrations = [
  {
    id: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rule_acceptances (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        rules_version INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id, rules_version)
      );

      CREATE TABLE IF NOT EXISTS persistent_messages (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        panel_type TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, panel_type)
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        old_value TEXT,
        new_value TEXT,
        status TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS tiktok_oauth_states (
        state TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tiktok_connections (
        guild_id TEXT PRIMARY KEY,
        open_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        scopes TEXT NOT NULL,
        encrypted_access_token TEXT NOT NULL,
        encrypted_refresh_token TEXT NOT NULL,
        connected_at TEXT NOT NULL,
        access_token_expires_at TEXT NOT NULL,
        refresh_token_expires_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_check_at TEXT,
        last_success_at TEXT,
        last_video_id TEXT
      );

      CREATE TABLE IF NOT EXISTS tiktok_published_videos (
        guild_id TEXT NOT NULL,
        open_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        create_time INTEGER,
        published_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, open_id, video_id)
      );
    `,
  },
  {
    id: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS tiktok_pending_connections (
        state TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        open_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        scopes TEXT NOT NULL,
        encrypted_access_token TEXT NOT NULL,
        encrypted_refresh_token TEXT NOT NULL,
        connected_at TEXT NOT NULL,
        access_token_expires_at TEXT NOT NULL,
        refresh_token_expires_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `,
  },
];

export async function openDatabase(databasePath: string): Promise<Database> {
  try {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const SQL = await getSqlFactory();
    const file = fs.existsSync(databasePath) ? fs.readFileSync(databasePath) : undefined;
    const sqlite = file ? new SQL.Database(file) : new SQL.Database();
    const database = new SqlJsDatabaseAdapter(sqlite, databasePath);
    runMigrations(database);
    database.save();
    return database;
  } catch (error) {
    throw new DatabaseError(error instanceof Error ? error.message : "No se pudo abrir SQLite.");
  }
}

export async function openMemoryDatabase(): Promise<Database> {
  const SQL = await getSqlFactory();
  const database = new SqlJsDatabaseAdapter(new SQL.Database(), undefined);
  runMigrations(database);
  return database;
}

export function runMigrations(database: Database): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  const applied = new Set(database.prepare("SELECT id FROM schema_migrations").all().map((row) => Number(row.id)));

  for (const migration of migrations) {
    if (!applied.has(migration.id)) {
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, new Date().toISOString());
    }
  }
}

async function getSqlFactory(): Promise<SqlJsStatic> {
  sqlFactory ??= initSqlJs({
    locateFile: (filename) => require.resolve(`sql.js/dist/${filename}`),
  });

  return sqlFactory;
}

class SqlJsDatabaseAdapter implements Database {
  public constructor(
    private readonly database: SqlJsDatabase,
    private readonly databasePath: string | undefined,
  ) {}

  public exec(sql: string): void {
    this.database.exec(sql);
  }

  public prepare(sql: string): PreparedStatement {
    return new SqlJsPreparedStatement(this.database, sql, () => this.save());
  }

  public close(): void {
    this.save();
    this.database.close();
  }

  public save(): void {
    if (!this.databasePath) {
      return;
    }

    const data = this.database.export();
    fs.writeFileSync(this.databasePath, Buffer.from(data));
  }
}

class SqlJsPreparedStatement implements PreparedStatement {
  public constructor(
    private readonly database: SqlJsDatabase,
    private readonly sql: string,
    private readonly afterWrite: () => void,
  ) {}

  public run(...params: SqlValue[]): void {
    const statement = this.database.prepare(this.sql);
    try {
      statement.run(params);
      this.afterWrite();
    } finally {
      statement.free();
    }
  }

  public get(...params: SqlValue[]): SqlRow | undefined {
    const statement = this.database.prepare(this.sql);
    try {
      statement.bind(params);
      if (!statement.step()) {
        return undefined;
      }
      return statement.getAsObject();
    } finally {
      statement.free();
    }
  }

  public all(...params: SqlValue[]): SqlRow[] {
    const statement = this.database.prepare(this.sql);
    const rows: SqlRow[] = [];
    try {
      statement.bind(params);
      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
      return rows;
    } finally {
      statement.free();
    }
  }
}
