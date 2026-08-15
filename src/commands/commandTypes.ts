import type { ChatInputCommandInteraction, RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import type { ServerConfig } from "../core/config/schema.js";
import type { Database } from "../core/database/sqlite.js";
import type { AppLogger } from "../core/logger/logger.js";

export interface CommandContext {
  config: ServerConfig;
  database: Database;
  logger?: AppLogger | undefined;
}

export interface SlashCommand {
  name: string;
  enabled(config: ServerConfig): boolean;
  data(config: ServerConfig): RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(interaction: ChatInputCommandInteraction, context: CommandContext): Promise<void>;
}
