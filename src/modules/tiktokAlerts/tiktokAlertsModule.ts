import type { BotModule, BotModuleContext } from "../../types/BotModule.js";
import { TikTokRepository } from "../../repositories/tiktokRepository.js";
import { sendDiscordLog } from "../../services/discordLogService.js";
import { TikTokApiClient } from "./tiktokApiClient.js";
import { checkTikTokVideos } from "./tiktokAlertService.js";
import { TikTokCallbackServer } from "./tiktokCallbackServer.js";
import { hasTikTokCredentials, loadTikTokRuntimeConfig } from "./tiktokEnv.js";

const runtimes = new WeakMap<BotModuleContext, TikTokModuleRuntime>();
let singletonRuntime: TikTokModuleRuntime | undefined;

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
  async start(context) {
    const runtime = new TikTokModuleRuntime(context);
    singletonRuntime = runtime;
    runtimes.set(context, runtime);
    await runtime.start();
  },
  async stop(context) {
    const runtime = runtimes.get(context) ?? singletonRuntime;
    await runtime?.stop();
  },
};

export class TikTokModuleRuntime {
  private callbackServer: TikTokCallbackServer | undefined;
  private timer: NodeJS.Timeout | undefined;

  public constructor(private readonly context: BotModuleContext) {}

  public async start(): Promise<void> {
    if (!this.context.config.modules.tiktokAlerts) {
      return;
    }

    const runtime = loadTikTokRuntimeConfig();
    const repository = new TikTokRepository(this.context.database);
    const api = new TikTokApiClient(runtime);
    this.callbackServer = new TikTokCallbackServer(
      this.context.client,
      this.context.config,
      repository,
      api,
      runtime,
    );
    await this.callbackServer.start();
    await sendDiscordLog(this.context.client, this.context.config, "[TIKTOK]\nCallback OAuth iniciado.");

    const connection = repository.findConnection(this.context.config.guildId);
    if (!connection?.enabled) {
      return;
    }

    this.timer = setInterval(() => {
      void checkTikTokVideos(this.context.client, this.context.config, repository, api, runtime, {
        mention: this.context.config.tiktokAlerts.mention,
      }).catch((error: unknown) => {
        this.context.logger.error({ error }, "TikTok polling failed");
        void sendDiscordLog(
          this.context.client,
          this.context.config,
          `[TIKTOK]\nError de polling: ${error instanceof Error ? error.message : "Error desconocido."}`,
        );
      });
    }, this.context.config.tiktokAlerts.pollingIntervalSeconds * 1000);
    await sendDiscordLog(this.context.client, this.context.config, "[TIKTOK]\nPolling iniciado.");
  }

  public async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.callbackServer?.stop();
    this.callbackServer = undefined;
  }
}
