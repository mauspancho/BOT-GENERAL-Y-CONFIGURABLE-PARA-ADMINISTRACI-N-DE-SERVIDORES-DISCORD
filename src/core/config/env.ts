import dotenv from "dotenv";
import { z } from "zod";
import { ConfigurationError } from "../errors/AppError.js";

dotenv.config();

export const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CONFIG_PATH: z.string().default("./config/server.json"),
  DATABASE_PATH: z.string().default("./data/bot.sqlite"),
  LOG_LEVEL: z.string().default("info"),
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  TIKTOK_REDIRECT_URI: z.string().optional(),
  TIKTOK_CALLBACK_HOST: z.string().optional(),
  TIKTOK_CALLBACK_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  TIKTOK_TOKEN_ENCRYPTION_KEY: z.string().optional(),
});

export type BotEnv = z.infer<typeof envSchema>;

export function loadEnv(): BotEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new ConfigurationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
}

export function maskToken(token: string): string {
  if (token.length <= 8) {
    return "********";
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
