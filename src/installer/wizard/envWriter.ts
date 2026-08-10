import fs from "node:fs";
import path from "node:path";

export function writeEnvFile(values: { token: string; clientId: string }): void {
  const envPath = path.resolve(process.cwd(), ".env");
  const lines = [
    `DISCORD_TOKEN=${values.token}`,
    `DISCORD_CLIENT_ID=${values.clientId}`,
    "NODE_ENV=production",
    "CONFIG_PATH=./config/server.json",
    "DATABASE_PATH=./data/bot.sqlite",
    "LOG_LEVEL=info",
  ];

  fs.writeFileSync(envPath, `${lines.join("\n")}\n`, "utf8");
}
