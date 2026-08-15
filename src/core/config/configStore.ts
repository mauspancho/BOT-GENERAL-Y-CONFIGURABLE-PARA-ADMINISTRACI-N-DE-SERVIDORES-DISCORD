import fs from "node:fs";
import path from "node:path";
import { ConfigurationError } from "../errors/AppError.js";
import { serverConfigSchema, type ServerConfig } from "./schema.js";

export function readServerConfig(configPath: string): ServerConfig {
  if (!fs.existsSync(configPath)) {
    throw new ConfigurationError(`No existe el archivo de configuracion: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsedJson: unknown = JSON.parse(raw);
  const parsed = serverConfigSchema.safeParse(parsedJson);

  if (!parsed.success) {
    throw new ConfigurationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  return parsed.data;
}

export function writeServerConfig(configPath: string, config: ServerConfig): void {
  const parsed = serverConfigSchema.parse(config);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeTextFileAtomic(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

export function configExists(configPath: string): boolean {
  return fs.existsSync(configPath);
}

export function writeTextFileAtomic(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  const handle = fs.openSync(tempPath, "w");
  try {
    fs.writeFileSync(handle, content, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(tempPath, targetPath);
}
