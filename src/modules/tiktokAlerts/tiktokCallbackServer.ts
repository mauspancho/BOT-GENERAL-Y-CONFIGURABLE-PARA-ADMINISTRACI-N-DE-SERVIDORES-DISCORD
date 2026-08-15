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
      if (url.pathname === "/") {
        sendPage(response, 200, "LinuxRed Connect", homePage());
        return;
      }
      if (url.pathname === "/terms") {
        sendPage(response, 200, "Terms - LinuxRed Connect", termsPage());
        return;
      }
      if (url.pathname === "/privacy") {
        sendPage(response, 200, "Privacy - LinuxRed Connect", privacyPage());
        return;
      }
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
      sendHtml(response, 200, "Cuenta TikTok detectada. Vuelve a Discord para confirmar o cancelar la conexion.");
    } catch {
      sendHtml(response, 400, "No se pudo conectar TikTok. Vuelve a Discord e intenta de nuevo.");
    }
  }
}

function sendPage(response: http.ServerResponse, status: number, title: string, body: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  });
  response.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`);
}

function sendHtml(response: http.ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`<!doctype html><html><body><p>${escapeHtml(message)}</p></body></html>`);
}

function homePage(): string {
  return [
    "<main>",
    "<h1>LinuxRed Connect</h1>",
    "<p>LinuxRed Connect enlaza cuentas TikTok autorizadas con servidores Discord administrados por sus propios responsables.</p>",
    "<p>La integracion usa Login Kit de TikTok para que un administrador pueda autorizar una cuenta y confirmar su uso desde Discord.</p>",
    '<p><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p>',
    "</main>",
  ].join("");
}

function termsPage(): string {
  return [
    "<main>",
    "<h1>Terms</h1>",
    "<p>LinuxRed Connect es una herramienta de integracion para comunidades Discord administradas por sus propietarios.</p>",
    "<p>Solo administradores autorizados pueden iniciar una conexion TikTok para su servidor Discord.</p>",
    "<p>El uso de la integracion debe respetar las reglas de Discord, TikTok y la comunidad donde se active.</p>",
    '<p><a href="/">Inicio</a> · <a href="/privacy">Privacy</a></p>',
    "</main>",
  ].join("");
}

function privacyPage(): string {
  return [
    "<main>",
    "<h1>Privacy</h1>",
    "<p>LinuxRed Connect guarda solamente los datos necesarios para operar la alerta TikTok autorizada por cada servidor Discord.</p>",
    "<p>Los tokens se almacenan cifrados. No se muestran access tokens, refresh tokens, client secrets ni claves de cifrado en paginas publicas.</p>",
    "<p>Los administradores pueden desconectar la cuenta TikTok desde Discord para eliminar las credenciales asociadas.</p>",
    '<p><a href="/">Inicio</a> · <a href="/terms">Terms</a></p>',
    "</main>",
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
