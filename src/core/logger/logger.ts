import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { getLogsDir } from "../config/paths.js";

export function createLogger(name = "discord-community-bot") {
  const logsDir = getLogsDir();
  fs.mkdirSync(logsDir, { recursive: true });

  return pino(
    {
      name,
      level: process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: ["token", "*.token", "DISCORD_TOKEN", "authorization"],
        censor: "[REDACTED]",
      },
    },
    pino.destination(path.join(logsDir, "app.log")),
  );
}

export type AppLogger = ReturnType<typeof createLogger>;
