import type { ServerConfig } from "../../core/config/schema.js";
import { getConfigDiff, jsonEqual, type ConfigDiffEntry } from "./configDiff.js";

export type ConfigSection =
  | "communityName"
  | "modules"
  | "generalAlerts"
  | "tiktokAlerts"
  | "rules"
  | "welcome"
  | "theIsleGuide"
  | "structure"
  | "tiktokDeveloper";

export class GuildConfigEditSession {
  private workingConfig: ServerConfig;
  private readonly changedSections = new Set<ConfigSection>();

  public constructor(private readonly originalConfig: ServerConfig) {
    this.workingConfig = cloneConfig(originalConfig);
  }

  public get guildId(): string {
    return this.originalConfig.guildId;
  }

  public getOriginal(): ServerConfig {
    return this.originalConfig;
  }

  public getWorking(): ServerConfig {
    return this.workingConfig;
  }

  public markChanged(section: ConfigSection): void {
    this.changedSections.add(section);
  }

  public sections(): ConfigSection[] {
    return [...this.changedSections];
  }

  public hasChanges(): boolean {
    return !jsonEqual(this.originalConfig, this.workingConfig);
  }

  public getDiff(): ConfigDiffEntry[] {
    return getConfigDiff(this.originalConfig, this.workingConfig);
  }

  public discard(): void {
    this.workingConfig = cloneConfig(this.originalConfig);
    this.changedSections.clear();
  }
}

export function cloneConfig(config: ServerConfig): ServerConfig {
  return JSON.parse(JSON.stringify(config)) as ServerConfig;
}
