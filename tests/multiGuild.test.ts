import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enabledCommands } from "../src/commands/index.js";
import { GuildConfigManager } from "../src/core/config/guildConfigManager.js";
import type { ServerConfig } from "../src/core/config/schema.js";
import { openMemoryDatabase } from "../src/core/database/sqlite.js";
import { TikTokRepository } from "../src/repositories/tiktokRepository.js";
import type { TikTokApiClient } from "../src/modules/tiktokAlerts/tiktokApiClient.js";
import {
  checkTikTokVideos,
  completeTikTokOAuth,
  createTikTokAuthorization,
  refreshTikTokConnectionIfNeeded,
} from "../src/modules/tiktokAlerts/tiktokAlertService.js";
import { TikTokMultiGuildRuntime } from "../src/modules/tiktokAlerts/tiktokAlertsModule.js";
import { TikTokCallbackServer } from "../src/modules/tiktokAlerts/tiktokCallbackServer.js";
import type { TikTokRuntimeConfig, TikTokTokenResponse, TikTokUserInfo, TikTokVideo } from "../src/modules/tiktokAlerts/tiktokTypes.js";
import { createDefaultModules } from "../src/core/config/schema.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    fs.rmSync(cleanupPath, { recursive: true, force: true });
  }
});

describe("multi-guild isolation", () => {
  it("stores and loads independent guild configs and migrates legacy server.json safely", () => {
    const root = makeTempDir();
    const legacyPath = path.join(root, "config", "server.json");
    const guildsDir = path.join(root, "config", "guilds");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify(configFor("guild-chepe", true), null, 2), "utf8");
    const manager = new GuildConfigManager(guildsDir, legacyPath);

    manager.migrateLegacyConfig();
    manager.save("guild-maus", configFor("guild-maus", false));

    expect(manager.list().map((config) => config.guildId).sort()).toEqual(["guild-chepe", "guild-maus"]);
    expect(manager.get("guild-chepe").channels.general?.id).toBe("general-guild-chepe");
    expect(manager.get("guild-maus").channels.general?.id).toBe("general-guild-maus");
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.readdirSync(path.dirname(legacyPath)).some((entry) => entry.includes("pre-multiguild"))).toBe(true);
  });

  it("registers commands according to each guild config", () => {
    const chepe = configFor("guild-chepe", true);
    const maus = configFor("guild-maus", false);

    expect(enabledCommands(chepe).map((command) => command.name)).toContain("tiktok");
    expect(enabledCommands(maus).map((command) => command.name)).not.toContain("tiktok");
    expect(enabledCommands(maus).map((command) => command.name)).toContain("alerta");
  });

  it("supports concurrent OAuth callbacks in reverse order without crossing guilds", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const manager = managerFor([configFor("guild-chepe", true), configFor("guild-maus", true)]);
    const api = apiForGuilds();
    const chepeAuth = createTikTokAuthorization(repository, api, { guildId: "guild-chepe", discordUserId: "admin-chepe" });
    const mausAuth = createTikTokAuthorization(repository, api, { guildId: "guild-maus", discordUserId: "admin-maus" });
    const server = new TikTokCallbackServer(makeClient() as never, manager, repository, api, runtime());
    await server.start();
    const port = serverPort(server);

    await fetch(`http://127.0.0.1:${port}/tiktok/callback?code=code-maus&state=${mausAuth.state}`);
    await fetch(`http://127.0.0.1:${port}/tiktok/callback?code=code-chepe&state=${chepeAuth.state}`);

    expect(repository.findConnection("guild-chepe")?.openId).toBe("open-chepe");
    expect(repository.findConnection("guild-maus")?.openId).toBe("open-maus");
    await server.stop();
    database.close();
  });

  it("activation, deactivation, disconnect and same video id are scoped by guild_id", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedTwoGuilds(database);

    repository.setConnectionEnabled("guild-chepe", false);
    expect(repository.findConnection("guild-chepe")?.enabled).toBe(false);
    expect(repository.findConnection("guild-maus")?.enabled).toBe(true);

    repository.setConnectionEnabled("guild-chepe", true);
    repository.markVideoPublished("guild-chepe", "open-chepe", "same-video", 1);
    expect(repository.hasPublishedVideo("guild-chepe", "open-chepe", "same-video")).toBe(true);
    expect(repository.hasPublishedVideo("guild-maus", "open-maus", "same-video")).toBe(false);

    repository.deleteConnection("guild-chepe");
    expect(repository.findConnection("guild-chepe")).toBeUndefined();
    expect(repository.findConnection("guild-maus")).toBeDefined();
    database.close();
  });

  it("publishes Chepe videos only to Chepe channels and Maus videos only to Maus channels", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedTwoGuilds(database);
    const client = makeClient();
    const api = apiForGuilds(
      {
        "access-chepe": [video("shared-id", 3_000, "Chepe nuevo")],
        "access-maus": [video("shared-id", 3_000, "Maus nuevo")],
      },
      activeRefreshTokens(),
    );

    await checkTikTokVideos(client as never, configFor("guild-chepe", true), repository, api, runtime(), { mention: "ninguna" });
    await checkTikTokVideos(client as never, configFor("guild-maus", true), repository, api, runtime(), { mention: "ninguna" });

    expect(client.sendsByChannel.get("general-guild-chepe")).toHaveLength(1);
    expect(client.sendsByChannel.get("general-guild-maus")).toHaveLength(1);
    expect(client.sendsByChannel.get("general-guild-chepe")?.map(stringifyPayload).join("\n")).toContain("Chepe nuevo");
    expect(client.sendsByChannel.get("general-guild-chepe")?.map(stringifyPayload).join("\n")).not.toContain("Maus nuevo");
    expect(client.sendsByChannel.get("logs-guild-chepe")).toHaveLength(1);
    expect(client.sendsByChannel.get("logs-guild-maus")).toHaveLength(1);
    database.close();
  });

  it("refresh token for Chepe never changes Maus token", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedTwoGuilds(database);
    const chepe = repository.findConnection("guild-chepe")!;
    const mausBefore = repository.findConnection("guild-maus")!;
    const api = apiForGuilds(undefined, {
      "refresh-chepe": token("access-chepe-2", "refresh-chepe-2", "open-chepe"),
    });

    await refreshTikTokConnectionIfNeeded(repository, api, runtime(), {
      ...chepe,
      accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    expect(repository.findConnection("guild-chepe")?.encryptedRefreshToken).not.toBe(chepe.encryptedRefreshToken);
    expect(repository.findConnection("guild-maus")?.encryptedRefreshToken).toBe(mausBefore.encryptedRefreshToken);
    database.close();
  });

  it("scheduler isolates API errors and respects per-guild polling intervals", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedTwoGuilds(database);
    const manager = managerFor([
      configFor("guild-chepe", true, 300),
      configFor("guild-maus", true, 600),
    ]);
    repository.updatePollingState("guild-chepe", { lastCheckAt: new Date(0).toISOString() });
    repository.updatePollingState("guild-maus", { lastCheckAt: new Date(590_000).toISOString() });
    const client = makeClient();
    const api = apiForGuilds(
      {
        "access-chepe": new Error("TikTok Chepe fallo"),
        "access-maus": [video("maus-new", 3_000, "Maus ok")],
      },
      activeRefreshTokens(),
    );
    const runtimeInstance = new TikTokMultiGuildRuntime(client as never, manager, database, logger(), {
      repository,
      runtime: runtime(),
      api,
    });

    await runtimeInstance.tick(new Date(1_200_000));

    expect(client.sendsByChannel.get("general-guild-maus")).toHaveLength(1);
    expect(client.sendsByChannel.get("general-guild-chepe")).toBeUndefined();
    expect(client.sendsByChannel.get("logs-guild-chepe")).toHaveLength(1);
    database.close();
  });

  it("unconfigured guild never falls back to another guild config", () => {
    const manager = managerFor([configFor("guild-chepe", true)]);

    expect(manager.find("guild-maus")).toBeUndefined();
  });
});

function configFor(guildId: string, tiktokAlerts: boolean, pollingIntervalSeconds = 300): ServerConfig {
  const modules = createDefaultModules();
  modules.welcome = false;
  modules.rules = false;
  modules.logs = true;
  modules.generalAlerts = true;
  modules.tiktokAlerts = tiktokAlerts;
  modules.theIsleGuide = false;
  return {
    version: 1,
    guildId,
    communityName: guildId.includes("chepe") ? "Chepe" : "Maus",
    locale: "es",
    categories: {},
    channels: {
      general: { id: `general-${guildId}`, name: "general", type: "text", function: "general", readOnlyForMembers: false },
      logs: { id: `logs-${guildId}`, name: "logs", type: "text", function: "logs", readOnlyForMembers: true },
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
    welcome: { channelEnabled: false, dmEnabled: false, message: "Hola" },
    theIsleGuide: { enabled: false },
    tiktokAlerts: { enabled: tiktokAlerts, pollingIntervalSeconds, mention: "ninguna" },
  };
}

function managerFor(configs: ServerConfig[]) {
  const map = new Map(configs.map((config) => [config.guildId, config]));
  return {
    get(guildId: string) {
      const config = map.get(guildId);
      if (!config) {
        throw new Error(`Config no encontrada: ${guildId}`);
      }
      return config;
    },
    find: (guildId: string) => map.get(guildId),
    list: () => [...map.values()],
  } as GuildConfigManager;
}

async function connectedTwoGuilds(database: Awaited<ReturnType<typeof openMemoryDatabase>>): Promise<TikTokRepository> {
  const repository = new TikTokRepository(database);
  const api = apiForGuilds({
    "access-chepe": [video("baseline-chepe", 1_000, "baseline")],
    "access-maus": [video("baseline-maus", 1_000, "baseline")],
  });
  for (const guildId of ["guild-chepe", "guild-maus"]) {
    const auth = createTikTokAuthorization(repository, api, { guildId, discordUserId: `admin-${guildId}` });
    await completeTikTokOAuth(makeClient() as never, configFor(guildId, true), repository, api, runtime(), {
      state: auth.state,
      code: guildId.includes("chepe") ? "code-chepe" : "code-maus",
      now: new Date(2_000_000),
    });
  }
  return repository;
}

function apiForGuilds(
  videosByAccessToken: Record<string, TikTokVideo[] | Error> = {},
  refreshByRefreshToken: Record<string, TikTokTokenResponse> = {},
): TikTokApiClient {
  return {
    buildAuthorizeUrl: (state: string) => `https://www.tiktok.com/v2/auth/authorize/?state=${state}`,
    exchangeCode: vi.fn((code: string) =>
      Promise.resolve(code.includes("chepe") ? token("access-chepe", "refresh-chepe", "open-chepe") : token("access-maus", "refresh-maus", "open-maus")),
    ),
    refreshToken: vi.fn((refreshToken: string) => Promise.resolve(refreshByRefreshToken[refreshToken] ?? token(`${refreshToken}-access`, refreshToken, refreshToken.includes("chepe") ? "open-chepe" : "open-maus"))),
    revokeToken: vi.fn(() => Promise.resolve()),
    getUserInfo: vi.fn((accessToken: string) =>
      Promise.resolve(accessToken.includes("chepe") ? user("open-chepe", "ChepeTikTok") : user("open-maus", "MausTikTok")),
    ),
    listVideos: vi.fn((accessToken: string) => {
      const result = videosByAccessToken[accessToken] ?? [];
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    }),
  } as unknown as TikTokApiClient;
}

function activeRefreshTokens(): Record<string, TikTokTokenResponse> {
  return {
    "refresh-chepe": token("access-chepe", "refresh-chepe", "open-chepe"),
    "refresh-maus": token("access-maus", "refresh-maus", "open-maus"),
  };
}

function token(accessToken: string, refreshToken: string, openId: string): TikTokTokenResponse {
  return {
    openId,
    scopes: ["user.info.basic", "video.list"],
    accessToken,
    expiresIn: 3600,
    refreshToken,
    refreshExpiresIn: 86_400,
  };
}

function user(openId: string, displayName: string): TikTokUserInfo {
  return { openId, displayName };
}

function video(id: string, createTime: number, description: string): TikTokVideo {
  return {
    id,
    createTime,
    videoDescription: description,
    shareUrl: `https://tiktok.example/${id}`,
  };
}

function runtime(): TikTokRuntimeConfig {
  return {
    clientKey: "client",
    clientSecret: "secret",
    redirectUri: "https://tiktok.linuxred.lat/tiktok/callback",
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    encryptionKey: Buffer.alloc(32, 7),
  };
}

function makeClient() {
  const sendsByChannel = new Map<string, unknown[]>();
  return {
    sendsByChannel,
    channels: {
      fetch: vi.fn((id: string) =>
        Promise.resolve({
          id,
          name: id,
          type: ChannelType.GuildText,
          send: (payload: unknown) => {
            const sends = sendsByChannel.get(id) ?? [];
            sends.push(payload);
            sendsByChannel.set(id, sends);
            return Promise.resolve();
          },
        }),
      ),
    },
  };
}

function stringifyPayload(value: unknown): string {
  return JSON.stringify(value);
}

function serverPort(server: TikTokCallbackServer): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server has no TCP address.");
  }
  return address.port;
}

function logger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as never;
}

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-guild-"));
  cleanupPaths.push(tempDir);
  return tempDir;
}
