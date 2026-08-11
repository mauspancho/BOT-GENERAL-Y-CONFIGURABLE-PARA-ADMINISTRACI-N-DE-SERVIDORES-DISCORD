import fs from "node:fs";
import path from "node:path";
import { getBackupsDir, getConfigPath, getDatabasePath, projectRoot } from "../../core/config/paths.js";

export interface BackupResult {
  name: string;
  path: string;
  included: string[];
}

export function createBackup(reason = "manual"): BackupResult {
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replaceAll("-", "")
    .replace("T", "-")
    .replaceAll(":", "")
    .slice(0, 15);
  const name = `backup-${timestamp}`;
  const targetDir = path.join(getBackupsDir(), name);
  fs.mkdirSync(targetDir, { recursive: true });

  const included: string[] = [];
  copyIfExists(path.join(projectRoot, "config"), path.join(targetDir, "config"), included, "config/");
  copyIfExists(path.join(projectRoot, "data", "rules.md"), path.join(targetDir, "data", "rules.md"), included, "data/rules.md");
  copyIfExists(path.join(projectRoot, "data", "the-isle"), path.join(targetDir, "data", "the-isle"), included, "data/the-isle/");
  copyIfExists(getDatabasePath(), path.join(targetDir, "data", "bot.sqlite"), included, "data/bot.sqlite");

  fs.writeFileSync(
    path.join(targetDir, "metadata.json"),
    `${JSON.stringify(
      {
        createdAt: now.toISOString(),
        reason,
        excludes: [".env", "Discord token", "logs"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  included.push("metadata.json");

  return { name, path: targetDir, included };
}

export function listBackups(): string[] {
  const dir = getBackupsDir();
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("backup-"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

export function restoreBackup(name: string): BackupResult {
  const sourceDir = path.join(getBackupsDir(), name);
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Backup no encontrado: ${name}`);
  }

  createBackup(`pre-restore-${name}`);

  const restored: string[] = [];
  copyIfExists(path.join(sourceDir, "config"), path.dirname(getConfigPath()), restored, "config/");
  copyIfExists(path.join(sourceDir, "data", "rules.md"), path.join(projectRoot, "data", "rules.md"), restored, "data/rules.md");
  copyIfExists(path.join(sourceDir, "data", "the-isle"), path.join(projectRoot, "data", "the-isle"), restored, "data/the-isle/");
  copyIfExists(path.join(sourceDir, "data", "bot.sqlite"), getDatabasePath(), restored, "data/bot.sqlite");

  return { name, path: sourceDir, included: restored };
}

function copyIfExists(source: string, target: string, included: string[], label: string): void {
  if (!fs.existsSync(source)) {
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
  included.push(label);
}
