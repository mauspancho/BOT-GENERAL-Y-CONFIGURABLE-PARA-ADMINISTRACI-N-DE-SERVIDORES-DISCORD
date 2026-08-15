import fs from "node:fs";
import path from "node:path";
import { ConfigurationError } from "../errors/AppError.js";
import { getConfigPath, getGuildConfigsDir } from "./paths.js";
import { readServerConfig, writeServerConfig } from "./configStore.js";
import type { ServerConfig } from "./schema.js";

export class GuildConfigManager {
  public constructor(
    private readonly guildConfigsDir = getGuildConfigsDir(),
    private readonly legacyConfigPath = getConfigPath(),
  ) {}

  public migrateLegacyConfig(): void {
    if (!fs.existsSync(this.legacyConfigPath)) {
      return;
    }

    const legacyConfig = readServerConfig(this.legacyConfigPath);
    const targetPath = this.pathFor(legacyConfig.guildId);
    if (fs.existsSync(targetPath)) {
      return;
    }

    fs.mkdirSync(this.guildConfigsDir, { recursive: true });
    const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
    fs.copyFileSync(this.legacyConfigPath, `${this.legacyConfigPath}.pre-multiguild-${timestamp}.bak`);
    writeServerConfig(targetPath, legacyConfig);
  }

  public findLegacyConflict(): { guildId: string; legacyPath: string; guildPath: string } | undefined {
    if (!fs.existsSync(this.legacyConfigPath)) {
      return undefined;
    }

    const legacyConfig = readServerConfig(this.legacyConfigPath);
    const guildPath = this.pathFor(legacyConfig.guildId);
    return fs.existsSync(guildPath)
      ? { guildId: legacyConfig.guildId, legacyPath: this.legacyConfigPath, guildPath }
      : undefined;
  }

  public importLegacyConfig(guildId: string): void {
    const legacyConfig = readServerConfig(this.legacyConfigPath);
    if (legacyConfig.guildId !== guildId) {
      throw new ConfigurationError("La config legacy pertenece a otro guild.");
    }

    this.save(guildId, legacyConfig);
  }

  public get(guildId: string): ServerConfig {
    const configPath = this.pathFor(guildId);
    if (!fs.existsSync(configPath)) {
      throw new ConfigurationError(`Este servidor todavia no esta configurado: ${guildId}`);
    }

    const config = readServerConfig(configPath);
    if (config.guildId !== guildId) {
      throw new ConfigurationError(`La config ${configPath} pertenece a otro guild.`);
    }

    return config;
  }

  public find(guildId: string): ServerConfig | undefined {
    return this.has(guildId) ? this.get(guildId) : undefined;
  }

  public has(guildId: string): boolean {
    return fs.existsSync(this.pathFor(guildId));
  }

  public save(guildId: string, config: ServerConfig): void {
    if (config.guildId !== guildId) {
      throw new ConfigurationError("No se puede guardar una config en un guild distinto.");
    }

    fs.mkdirSync(this.guildConfigsDir, { recursive: true });
    writeServerConfig(this.pathFor(guildId), config);
  }

  public list(): ServerConfig[] {
    if (!fs.existsSync(this.guildConfigsDir)) {
      return [];
    }

    return fs
      .readdirSync(this.guildConfigsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readServerConfig(path.join(this.guildConfigsDir, entry.name)))
      .sort((left, right) => left.guildId.localeCompare(right.guildId));
  }

  public pathFor(guildId: string): string {
    return path.join(this.guildConfigsDir, `${guildId}.json`);
  }
}
