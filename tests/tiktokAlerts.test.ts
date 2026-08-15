import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enabledCommands } from "../src/commands/index.js";
import { tiktokCommand } from "../src/commands/tiktok.js";
import { createDefaultModules, type ServerConfig } from "../src/core/config/schema.js";
import { openMemoryDatabase } from "../src/core/database/sqlite.js";
import { preflightStructurePlan } from "../src/installer/discord/setupDiscord.js";
import { readEnvFile, writeEnvFile } from "../src/installer/wizard/envWriter.js";
import { enabledModules } from "../src/modules/index.js";
import { checkTikTokVideos, completeTikTokOAuth, createTikTokAuthorization, refreshTikTokConnectionIfNeeded, sendTikTokTestAlert } from "../src/modules/tiktokAlerts/tiktokAlertService.js";
import { TikTokApiClient } from "../src/modules/tiktokAlerts/tiktokApiClient.js";
import { TikTokCallbackServer } from "../src/modules/tiktokAlerts/tiktokCallbackServer.js";
import { decryptTikTokToken } from "../src/modules/tiktokAlerts/tiktokCrypto.js";
import type { TikTokRuntimeConfig, TikTokTokenResponse, TikTokUserInfo, TikTokVideo } from "../src/modules/tiktokAlerts/tiktokTypes.js";
import { TikTokRepository } from "../src/repositories/tiktokRepository.js";
import { makeGuildMock } from "./support/discordMocks.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const cleanupPath of cleanupPaths.splice(0)) {
    fs.rmSync(cleanupPath, { recursive: true, force: true });
  }
});

describe("tiktok alerts", () => {
  it("does not register /tiktok when disabled", () => {
    expect(enabledCommands(makeConfig(false)).map((command) => command.name)).not.toContain("tiktok");
    expect(enabledModules(makeConfig(false)).map((module) => module.name)).not.toContain("tiktokAlerts");
  });

  it("registers /tiktok when enabled", () => {
    expect(enabledCommands(makeConfig(true)).map((command) => command.name)).toContain("tiktok");
    expect(enabledModules(makeConfig(true)).map((module) => module.name)).toContain("tiktokAlerts");
  });

  it("requires Administrator and guild-only command metadata", () => {
    const json = tiktokCommand.data(makeConfig(true));

    expect(json.default_member_permissions).toBe(PermissionFlagsBits.Administrator.toString());
    expect(json.dm_permission).toBe(false);
  });

  it("rejects normal users and ManageGuild without Administrator", async () => {
    const database = await openMemoryDatabase();
    const normal = makeInteraction("estado", { isAdministrator: false });
    const manageGuild = makeInteraction("estado", {
      hasPermission: (permission) => permission === PermissionFlagsBits.ManageGuild,
    });

    await tiktokCommand.execute(normal as never, { config: makeConfig(true), database });
    await tiktokCommand.execute(manageGuild as never, { config: makeConfig(true), database });

    expect(firstReply(normal).content).toContain("Administrador");
    expect(firstReply(manageGuild).content).toContain("Administrador");
    database.close();
  });

  it("allows Administrator to see status without exposing tokens", async () => {
    const database = await openMemoryDatabase();
    const interaction = makeInteraction("estado", { isAdministrator: true });

    await tiktokCommand.execute(interaction as never, { config: makeConfig(true), database });

    expect(firstReply(interaction).content).toContain("TikTok Alerts");
    expect(firstReply(interaction).content).not.toContain("token");
    database.close();
  });

  it("generates random one-time state and expires it", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi();
    const first = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "admin" });
    const second = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "admin" });

    expect(first.state).not.toBe(second.state);
    repository.consumeOAuthState(first.state);
    expect(() => repository.consumeOAuthState(first.state)).toThrow(/utilizado/i);

    const expired = createTikTokAuthorization(repository, api, {
      guildId: "guild",
      discordUserId: "admin",
      now: new Date("2026-08-14T00:00:00.000Z"),
    });
    expect(() => repository.consumeOAuthState(expired.state, new Date("2026-08-14T00:11:00.000Z"))).toThrow(/expirado/i);
    database.close();
  });

  it("rejects callback without code and invalid state without leaking secrets", async () => {
    const database = await openMemoryDatabase();
    const server = new TikTokCallbackServer(makeClient() as never, makeConfig(true), new TikTokRepository(database), makeApi(), runtime());
    await server.start();
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const missingCode = await fetch(`http://127.0.0.1:${port}/tiktok/callback?state=x`);
    const invalidState = await fetch(`http://127.0.0.1:${port}/tiktok/callback?state=x&code=y`);

    expect(missingCode.status).toBe(400);
    expect(await invalidState.text()).not.toContain("secret");
    await server.stop();
    database.close();
  });

  it("exchanges token, reads user info and stores encrypted tokens", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi();
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "admin" });
    const client = makeClient();

    await completeTikTokOAuth(client as never, makeConfig(true), repository, api, runtime(), {
      state: auth.state,
      code: "code",
    });
    const connection = repository.findConnection("guild");

    expect(connection?.displayName).toBe("CuentaTikTok");
    expect(connection?.encryptedAccessToken).not.toBe("access-1");
    expect(decryptTikTokToken(connection?.encryptedAccessToken ?? "", runtime().encryptionKey)).toBe("access-1");
    expect(JSON.stringify(client.logSend.mock.calls)).not.toContain("access-1");
    database.close();
  });

  it("uses official TikTok OAuth, user info and video list endpoints", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const endpoint = stringifyRequestUrl(url);
      calls.push({ url: endpoint, init: init ?? {} });
      if (endpoint.includes("/oauth/token/")) {
        return Promise.resolve(jsonResponse({
          open_id: "open-id",
          scope: "user.info.basic,video.list",
          access_token: "access-api",
          expires_in: 3600,
          refresh_token: "refresh-api",
          refresh_expires_in: 86_400,
        }));
      }
      if (endpoint.includes("/user/info/")) {
        return Promise.resolve(jsonResponse({ data: { user: { open_id: "open-id", display_name: "Cuenta", avatar_url: "avatar" } } }));
      }
      return Promise.resolve(jsonResponse({ data: { videos: [video("api-video", 1_000)] } }));
    }) as unknown as typeof fetch;
    const api = new TikTokApiClient(runtime(), fetcher);

    await api.exchangeCode("code");
    await api.getUserInfo("access-api");
    await api.listVideos("access-api");

    expect(calls[0]?.url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    expect(stringifyBody(calls[0]?.init.body)).toContain("grant_type=authorization_code");
    expect(calls[1]?.url).toContain("https://open.tiktokapis.com/v2/user/info/");
    expect(calls[2]?.url).toContain("https://open.tiktokapis.com/v2/video/list/");
    expect(calls[2]?.init.method).toBe("POST");
  });

  it("refreshes token and persists rotated refresh_token", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);
    const connection = repository.findConnection("guild");
    const api = makeApi({
      refresh: token("access-2", "refresh-2"),
    });

    const result = await refreshTikTokConnectionIfNeeded(repository, api, runtime(), {
      ...connection!,
      accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const stored = repository.findConnection("guild");

    expect(result.refreshed).toBe(true);
    expect(decryptTikTokToken(stored?.encryptedRefreshToken ?? "", runtime().encryptionKey)).toBe("refresh-2");
    database.close();
  });

  it("creates baseline on first connection and does not publish old videos", async () => {
    const database = await openMemoryDatabase();
    const client = makeClient();
    const repository = new TikTokRepository(database);
    const api = makeApi({ videos: [video("old", 1_000)] });
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "admin" });

    await completeTikTokOAuth(client as never, makeConfig(true), repository, api, runtime(), {
      state: auth.state,
      code: "code",
      now: new Date(2_000_000),
    });
    const published = await checkTikTokVideos(client as never, makeConfig(true), repository, api, runtime(), { mention: "ninguna" });

    expect(published).toBe(0);
    expect(client.generalSend).not.toHaveBeenCalled();
    database.close();
  });

  it("publishes new videos once and in chronological order after restart", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);
    const client = makeClient();
    const api = makeApi({ videos: [video("new-2", 4_000), video("new-1", 3_000), video("old", 1_000)] });

    const first = await checkTikTokVideos(client as never, makeConfig(true), repository, api, runtime(), { mention: "ninguna" });
    const second = await checkTikTokVideos(client as never, makeConfig(true), repository, api, runtime(), { mention: "ninguna" });

    expect(first).toBe(2);
    expect(second).toBe(0);
    expect(client.generalSend.mock.calls.map((call) => JSON.stringify(call[0]))).toEqual([
      expect.stringContaining("new-1"),
      expect.stringContaining("new-2"),
    ]);
    database.close();
  });

  it("uses config.channels.general.id and sendGeneralAlert pipeline", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);
    const client = makeClient();

    await checkTikTokVideos(client as never, makeConfig(true), repository, makeApi({ videos: [video("new", 3_000)] }), runtime(), { mention: "ninguna" });

    expect(client.channels.fetch).toHaveBeenCalledWith("general-id");
    expect(fs.readFileSync(path.resolve(process.cwd(), "src/modules/tiktokAlerts/tiktokAlertService.ts"), "utf8")).toContain("sendGeneralAlert");
    database.close();
  });

  it("neutralizes TikTok mentions and only uses configured mention", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);
    const client = makeClient();

    await checkTikTokVideos(client as never, makeConfig(true, "everyone"), repository, makeApi({
      videos: [video("mention", 3_000, "@everyone <@123>")],
    }), runtime(), { mention: "everyone" });

    const payload = firstAlertPayload(client);
    expect(payload.content).toBe("@everyone");
    expect(payload.allowedMentions).toMatchObject({ parse: ["everyone"], users: [], roles: [] });
    database.close();
  });

  it("supports here mention only when configured", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);
    const client = makeClient();

    await checkTikTokVideos(client as never, makeConfig(true, "here"), repository, makeApi({ videos: [video("here", 3_000)] }), runtime(), { mention: "here" });

    expect(firstAlertPayload(client).content).toBe("@here");
    database.close();
  });

  it("disconnect removes credentials and desactivar preserves them", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);

    repository.setConnectionEnabled("guild", false);
    expect(repository.findConnection("guild")).toBeDefined();
    repository.deleteConnection("guild");
    expect(repository.findConnection("guild")).toBeUndefined();
    database.close();
  });

  it("callback HTTP listens only on configured host", async () => {
    const database = await openMemoryDatabase();
    const configured = runtime();
    const server = new TikTokCallbackServer(makeClient() as never, makeConfig(true), new TikTokRepository(database), makeApi(), configured);
    await server.start();
    const address = server.address();

    expect(typeof address === "object" && address ? address.address : "").toBe(configured.callbackHost);
    await server.stop();
    database.close();
  });

  it("setup env writer preserves variables and creates encryption key once", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiktok-env-"));
    cleanupPaths.push(tempDir);
    const envPath = path.join(tempDir, ".env");
    fs.writeFileSync(envPath, "EXISTING=value\nTIKTOK_TOKEN_ENCRYPTION_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\n", "utf8");
    writeEnvFile({ tiktokClientKey: "client", tiktokClientSecret: "secret", ensureTikTokEncryptionKey: true }, envPath);
    writeEnvFile({ tiktokClientKey: "client2", ensureTikTokEncryptionKey: true }, envPath);
    const env = readEnvFile(envPath).values;

    expect(env.get("EXISTING")).toBe("value");
    expect(env.get("TIKTOK_CLIENT_SECRET")).toBe("secret");
    expect(env.get("TIKTOK_TOKEN_ENCRYPTION_KEY")).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=");
  });

  it("status and source code do not expose token secrets", async () => {
    const database = await openMemoryDatabase();
    const interaction = makeInteraction("estado", { isAdministrator: true });

    await tiktokCommand.execute(interaction as never, { config: makeConfig(true), database });

    expect(firstReply(interaction).content).not.toMatch(/access|refresh|secret/i);
    database.close();
  });

  it("test alert marks the latest video to avoid later duplicate", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);
    const client = makeClient();
    const api = makeApi({ videos: [video("latest", 3_000)] });

    await sendTikTokTestAlert(client as never, makeConfig(true), repository, api, runtime());
    const published = await checkTikTokVideos(client as never, makeConfig(true), repository, api, runtime(), { mention: "ninguna" });

    expect(published).toBe(0);
    database.close();
  });

  it("preflight rejects tiktokAlerts without generalAlerts", () => {
    const config = makeConfig(true);
    config.modules.generalAlerts = false;

    const result = preflightStructurePlan(makeGuildMock({ features: [] }), config);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("generalAlerts");
  });
});

function runtime(): TikTokRuntimeConfig {
  return {
    clientKey: "client-key",
    clientSecret: "client-secret",
    redirectUri: "https://tiktok.linuxred.lat/tiktok/callback",
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    encryptionKey: crypto.createHash("sha256").update("tests").digest(),
  };
}

function token(accessToken: string, refreshToken: string): TikTokTokenResponse {
  return {
    openId: "open-id",
    scopes: ["user.info.basic", "video.list"],
    accessToken,
    expiresIn: 3600,
    refreshToken,
    refreshExpiresIn: 86_400,
  };
}

function user(): TikTokUserInfo {
  return {
    openId: "open-id",
    displayName: "CuentaTikTok",
  };
}

function video(id: string, createTime: number, description = id): TikTokVideo {
  return {
    id,
    videoDescription: description,
    shareUrl: `https://www.tiktok.com/@cuenta/video/${id}`,
    coverImageUrl: `https://cdn.example/${id}.jpg`,
    createTime,
  };
}

function makeApi(values: {
  exchange?: TikTokTokenResponse;
  refresh?: TikTokTokenResponse;
  userInfo?: TikTokUserInfo;
  videos?: TikTokVideo[];
} = {}): TikTokApiClient {
  return {
    buildAuthorizeUrl: (state: string) => `https://www.tiktok.com/v2/auth/authorize/?state=${state}`,
    exchangeCode: vi.fn(() => Promise.resolve(values.exchange ?? token("access-1", "refresh-1"))),
    refreshToken: vi.fn(() => Promise.resolve(values.refresh ?? token("access-r", "refresh-r"))),
    revokeToken: vi.fn(() => Promise.resolve()),
    getUserInfo: vi.fn(() => Promise.resolve(values.userInfo ?? user())),
    listVideos: vi.fn(() => Promise.resolve(values.videos ?? [])),
  } as unknown as TikTokApiClient;
}

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(value),
  } as Response;
}

function stringifyRequestUrl(value: string | URL | Request): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  return value.url;
}

function stringifyBody(value: RequestInit["body"] | undefined): string {
  if (value instanceof URLSearchParams) {
    return value.toString();
  }
  return typeof value === "string" ? value : "";
}

async function connectedRepository(database: Awaited<ReturnType<typeof openMemoryDatabase>>): Promise<TikTokRepository> {
  const repository = new TikTokRepository(database);
  const api = makeApi({ videos: [video("old", 1_000)] });
  const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "admin" });
  await completeTikTokOAuth(makeClient() as never, makeConfig(true), repository, api, runtime(), {
    state: auth.state,
    code: "code",
    now: new Date(2_000_000),
  });
  return repository;
}

function makeConfig(enabled: boolean, mention: ServerConfig["tiktokAlerts"]["mention"] = "ninguna"): ServerConfig {
  const modules = createDefaultModules();
  modules.welcome = false;
  modules.rules = false;
  modules.logs = true;
  modules.generalAlerts = true;
  modules.tiktokAlerts = enabled;
  modules.theIsleGuide = false;
  return {
    version: 1,
    guildId: "guild",
    communityName: "Comunidad",
    locale: "es",
    categories: {},
    channels: {
      general: {
        id: "general-id",
        name: "general",
        type: "text",
        function: "general",
        readOnlyForMembers: false,
      },
      logs: {
        id: "logs-id",
        name: "logs",
        type: "text",
        function: "logs",
        readOnlyForMembers: true,
      },
    },
    roles: {},
    modules,
    rules: {
      enabled: false,
      sourcePath: "./data/rules.md",
      version: 1,
      requireReacceptOnRulesChange: false,
      rejectAction: "warn",
    },
    welcome: {
      channelEnabled: false,
      dmEnabled: false,
      message: "Hola",
    },
    theIsleGuide: {
      enabled: false,
    },
    tiktokAlerts: {
      enabled,
      pollingIntervalSeconds: 300,
      mention,
    },
  };
}

interface AlertPayload {
  content?: string;
  embeds?: unknown[];
  allowedMentions?: {
    parse: string[];
    users: string[];
    roles: string[];
  };
}

function makeClient() {
  const generalSend = vi.fn((payload: AlertPayload) => {
    void payload;
    return Promise.resolve();
  });
  const logSend = vi.fn((payload: AlertPayload) => {
    void payload;
    return Promise.resolve();
  });
  return {
    generalSend,
    logSend,
    channels: {
      fetch: vi.fn((id: string) =>
        Promise.resolve(
          id === "general-id"
            ? { id, name: "general", type: ChannelType.GuildText, send: generalSend }
            : { id, name: "logs", type: ChannelType.GuildText, send: logSend },
        ),
      ),
    },
  };
}

function firstAlertPayload(client: ReturnType<typeof makeClient>): AlertPayload {
  const payload = client.generalSend.mock.calls[0]?.[0];
  if (!payload) {
    throw new Error("No alert payload.");
  }
  return payload;
}

function makeInteraction(subcommand: string, options: {
  isAdministrator?: boolean;
  hasPermission?: (permission: bigint) => boolean;
}) {
  const reply = vi.fn((payload: { content: string; ephemeral: boolean }) => {
    void payload;
    return Promise.resolve();
  });
  return {
    client: makeClient(),
    inGuild: () => true,
    memberPermissions: {
      has:
        options.hasPermission ??
        ((permission: bigint) => Boolean(options.isAdministrator) && permission === PermissionFlagsBits.Administrator),
    },
    user: { id: "admin" },
    options: {
      getSubcommand: () => subcommand,
    },
    reply,
  };
}

function firstReply(interaction: ReturnType<typeof makeInteraction>): { content: string; ephemeral: boolean } {
  const payload = interaction.reply.mock.calls[0]?.[0];
  if (!payload) {
    throw new Error("No reply payload.");
  }
  return payload;
}
