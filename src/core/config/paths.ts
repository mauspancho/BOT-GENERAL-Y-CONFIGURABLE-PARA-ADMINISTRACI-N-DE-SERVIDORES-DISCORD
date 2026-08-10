import path from "node:path";

export const projectRoot = process.cwd();

export function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export function getConfigPath(): string {
  return resolveFromRoot(process.env.CONFIG_PATH ?? "./config/server.json");
}

export function getDatabasePath(): string {
  return resolveFromRoot(process.env.DATABASE_PATH ?? "./data/bot.sqlite");
}

export function getRulesPath(relativePath = "./data/rules.md"): string {
  return resolveFromRoot(relativePath);
}

export function getBackupsDir(): string {
  return resolveFromRoot("./backups");
}

export function getLogsDir(): string {
  return resolveFromRoot("./logs");
}
