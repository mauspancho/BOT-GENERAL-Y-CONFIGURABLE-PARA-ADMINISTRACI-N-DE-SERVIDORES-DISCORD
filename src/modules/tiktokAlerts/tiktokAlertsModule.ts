import type { Client } from "discord.js";
import type { GuildConfigManager } from "../../core/config/guildConfigManager.js";
import type { Database } from "../../core/database/sqlite.js";
import type { AppLogger } from "../../core/logger/logger.js";
import { TikTokRepository } from "../../repositories/tiktokRepository.js";
import { sendDiscordLog } from "../../services/discordLogService.js";
import type { BotModule } from "../../types/BotModule.js";
import { TikTokApiClient } from "./tiktokApiClient.js";
import { checkTikTokVideos, cleanupExpiredTikTokArtifacts } from "./tiktokAlertService.js";
import { TikTokCallbackServer } from "./tiktokCallbackServer.js";
import { hasTikTokCredentials, loadTikTokRuntimeConfig } from "./tiktokEnv.js";
import type { TikTokRuntimeConfig } from "./tiktokTypes.js";

export const tiktokAlertsModule: BotModule = {
  name: "tiktokAlerts",
  enabled: (config) => config.modules.tiktokAlerts,
  validate(context) {
    if (!context.config.modules.generalAlerts) {
      return Promise.resolve({ ok: false, messages: ["tiktokAlerts requiere generalAlerts activo."] });
    }
    if (!context.config.channels.general?.id) {
      return Promise.resolve({ ok: false, messages: ["tiktokAlerts requiere config.channels.general.id."] });
    }
    if (!hasTikTokCredentials()) {
      return Promise.resolve({ ok: false, messages: ["Credenciales TikTok incompletas."] });
    }
    return Promise.resolve({ ok: true, messages: ["tiktokAlerts OK."] });
  },
  register() {
    return Promise.resolve();
  },
  start() {
    return Promise.resolve();
  },
};

export class TikTokMultiGuildRuntime {
  private callbackServer: TikTokCallbackServer | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly repository: TikTokRepository;
  private readonly runtime: TikTokRuntimeConfig;
  private readonly api: TikTokApiClient;

  public constructor(
    private readonly client: Client,
    private readonly configManager: GuildConfigManager,
    database: Database,
    private readonly logger: AppLogger,
    dependencies?: {
      repository?: TikTokRepository;
      runtime?: TikTokRuntimeConfig;
      api?: TikTokApiClient;
    },
  ) {
    this.repository = dependencies?.repository ?? new TikTokRepository(database);
    this.runtime = dependencies?.runtime ?? loadTikTokRuntimeConfig();
    this.api = dependencies?.api ?? new TikTokApiClient(this.runtime);
  }

  public async start(): Promise<void> {
    const tiktokConfigs = this.configManager.list().filter((config) => config.modules.tiktokAlerts);
    if (tiktokConfigs.length === 0) {
      return;
    }

    this.callbackServer = new TikTokCallbackServer(
      this.client,
      this.configManager,
      this.repository,
      this.api,
      this.runtime,
    );
    await this.callbackServer.start();

    for (const config of tiktokConfigs) {
      await sendDiscordLog(this.client, config, "[TIKTOK]\nCallback OAuth iniciado.");
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, 30_000);
    void this.tick();
  }

  public async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    await this.callbackServer?.stop();
    this.callbackServer = undefined;
  }

  public async tick(now = new Date()): Promise<void> {
    await cleanupExpiredTikTokArtifacts(this.repository, this.api, this.runtime, now);
    const connections = this.repository.listEnabledConnections();
    for (const connection of connections) {
      const config = this.configManager.find(connection.guildId);
      if (!config?.modules.tiktokAlerts) {
        continue;
      }

      if (!this.isDue(connection.lastCheckAt, config.tiktokAlerts.pollingIntervalSeconds, now)) {
        continue;
      }

      try {
        await checkTikTokVideos(this.client, config, this.repository, this.api, this.runtime, {
          mention: config.tiktokAlerts.mention,
        });
      } catch (error) {
        this.logger.error({ error, guildId: connection.guildId }, "TikTok polling failed");
        await sendDiscordLog(
          this.client,
          config,
          `[TIKTOK]\nError de polling: ${error instanceof Error ? error.message : "Error desconocido."}`,
        );
      }
    }
  }

  private isDue(lastCheckAt: string | undefined, intervalSeconds: number, now: Date): boolean {
    if (!lastCheckAt) {
      return true;
    }

    return now.getTime() - new Date(lastCheckAt).getTime() >= intervalSeconds * 1000;
  }
}
