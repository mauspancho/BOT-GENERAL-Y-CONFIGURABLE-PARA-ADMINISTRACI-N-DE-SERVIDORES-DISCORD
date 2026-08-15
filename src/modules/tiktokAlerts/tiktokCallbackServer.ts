import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Client } from "discord.js";
import type { GuildConfigManager } from "../../core/config/guildConfigManager.js";
import type { TikTokRepository } from "../../repositories/tiktokRepository.js";
import type { TikTokApiClient } from "./tiktokApiClient.js";
import { completeTikTokOAuth } from "./tiktokAlertService.js";
import type { TikTokRuntimeConfig } from "./tiktokTypes.js";

export class TikTokCallbackServer {
  private server: Server | undefined;

  public constructor(
    private readonly client: Client,
    private readonly configManager: GuildConfigManager,
    private readonly repository: TikTokRepository,
    private readonly api: TikTokApiClient,
    private readonly runtime: TikTokRuntimeConfig,
  ) {}

  public async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.runtime.callbackPort, this.runtime.callbackHost, () => resolve());
    });
  }

  public async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  public address(): AddressInfo | string | null {
    return this.server?.address() ?? null;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (request.method !== "GET" || !request.url) {
        sendHtml(response, 404, "Ruta no encontrada.");
        return;
      }

      const url = new URL(request.url, `http://${this.runtime.callbackHost}:${this.runtime.callbackPort}`);
      if (url.pathname !== "/tiktok/callback") {
        sendHtml(response, 404, "Ruta no encontrada.");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        sendHtml(response, 400, "TikTok rechazo la autorizacion.");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        sendHtml(response, 400, "Callback TikTok incompleto.");
        return;
      }

      const oauthState = this.repository.findOAuthState(state);
      if (!oauthState) {
        sendHtml(response, 400, "State TikTok invalido.");
        return;
      }
      const config = this.configManager.get(oauthState.guildId);
      await completeTikTokOAuth(this.client, config, this.repository, this.api, this.runtime, {
        state,
        code,
      });
      sendHtml(response, 200, "TikTok conectado correctamente. Puedes cerrar esta ventana y volver a Discord.");
    } catch {
      sendHtml(response, 400, "No se pudo conectar TikTok. Vuelve a Discord e intenta de nuevo.");
    }
  }
}

function sendHtml(response: http.ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`<!doctype html><html><body><p>${escapeHtml(message)}</p></body></html>`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
