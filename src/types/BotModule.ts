import type { Client } from "discord.js";
import type { AppLogger } from "../core/logger/logger.js";
import type { ServerConfig } from "../core/config/schema.js";
import type { Database } from "../core/database/sqlite.js";

export interface ValidationResult {
  ok: boolean;
  messages: string[];
}

export interface BotModuleContext {
  client: Client;
  config: ServerConfig;
  database: Database;
  logger: AppLogger;
}

export interface BotModule {
  name: string;
  enabled(config: ServerConfig): boolean;
  validate(context: BotModuleContext): Promise<ValidationResult>;
  register(context: BotModuleContext): Promise<void>;
  start(context: BotModuleContext): Promise<void>;
  stop?(context: BotModuleContext): Promise<void>;
}
