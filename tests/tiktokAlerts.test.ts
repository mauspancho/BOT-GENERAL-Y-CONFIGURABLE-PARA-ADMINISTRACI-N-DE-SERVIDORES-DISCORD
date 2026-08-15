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
import {
  cancelTikTokPendingConnection,
  checkTikTokVideos,
  completeTikTokOAuth,
  confirmTikTokPendingConnection,
  createTikTokAuthorization,
  refreshTikTokConnectionIfNeeded,
  sendTikTokTestAlert,
} from "../src/modules/tiktokAlerts/tiktokAlertService.js";
import { TikTokApiClient } from "../src/modules/tiktokAlerts/tiktokApiClient.js";
import { TikTokCallbackServer } from "../src/modules/tiktokAlerts/tiktokCallbackServer.js";
import {
  TIKTOK_CONNECT_CANCEL_PREFIX,
  TIKTOK_CONNECT_CONFIRM_PREFIX,
  TIKTOK_REPUBLISH_NEXT_PREFIX,
  TIKTOK_REPUBLISH_PREVIOUS_PREFIX,
  TIKTOK_REPUBLISH_SELECT_PREFIX,
} from "../src/modules/tiktokAlerts/tiktokCustomIds.js";
import { decryptTikTokToken } from "../src/modules/tiktokAlerts/tiktokCrypto.js";
import {
  handleTikTokButton,
  handleTikTokPendingDmButton,
  handleTikTokRepublishSelect,
  isTikTokPendingButton,
} from "../src/modules/tiktokAlerts/tiktokInteractionService.js";
import { createTikTokRepublishSession } from "../src/modules/tiktokAlerts/tiktokRepublishState.js";
import type { TikTokRuntimeConfig, TikTokTokenResponse, TikTokUserInfo, TikTokVideo, TikTokVideoPage } from "../src/modules/tiktokAlerts/tiktokTypes.js";
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

  it("/tiktok republicar requires Administrator", async () => {
    const database = await openMemoryDatabase();
    const interaction = makeInteraction("republicar", { isAdministrator: false });

    await tiktokCommand.execute(interaction as never, { config: makeConfig(true), database });

    expect(firstReply(interaction).content).toContain("Administrador");
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
    const server = new TikTokCallbackServer(makeClient() as never, makeConfigManager([makeConfig(true)]), new TikTokRepository(database), makeApi(), runtime());
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

  it("exchanges token, reads user info and creates encrypted pending connection", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi();
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "admin" });
    const client = makeClient();

    await completeTikTokOAuth(client as never, makeConfig(true), repository, api, runtime(), {
      state: auth.state,
      code: "code",
    });
    const pending = repository.findPendingConnection(auth.state);

    expect(repository.findConnection("guild")).toBeUndefined();
    expect(pending?.displayName).toBe("CuentaTikTok");
    expect(pending?.encryptedAccessToken).not.toBe("access-1");
    expect(decryptTikTokToken(pending?.encryptedAccessToken ?? "", runtime().encryptionKey)).toBe("access-1");
    expect(JSON.stringify(client.logSend.mock.calls)).not.toContain("access-1");
    expect(firstDmPayload(client).content).toContain("CuentaTikTok");
    database.close();
  });

  it("confirming pending connection stores connection and creates baseline", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi({ videos: [video("old", 1_000)] });
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "admin" });
    await completeTikTokOAuth(makeClient() as never, makeConfig(true), repository, api, runtime(), {
      state: auth.state,
      code: "code",
      now: new Date(2_000_000),
    });

    await confirmTikTokPendingConnection(repository, api, runtime(), {
      state: auth.state,
      guildId: "guild",
      discordUserId: "admin",
      now: new Date(2_000_000),
    });

    expect(repository.findConnection("guild")?.enabled).toBe(true);
    expect(repository.findPendingConnection(auth.state)).toBeUndefined();
    expect(repository.hasPublishedVideo("guild", "open-id", "old")).toBe(true);
    database.close();
  });

  it("canceling pending connection revokes token and does not connect", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi();
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "admin" });
    await completeTikTokOAuth(makeClient() as never, makeConfig(true), repository, api, runtime(), {
      state: auth.state,
      code: "code",
    });

    await cancelTikTokPendingConnection(repository, api, runtime(), {
      state: auth.state,
      guildId: "guild",
      discordUserId: "admin",
    });

    expect(repository.findConnection("guild")).toBeUndefined();
    expect(repository.findPendingConnection(auth.state)).toBeUndefined();
    expectRevokeCalled(api, "access-1");
    database.close();
  });

  it("pending confirmation is scoped to guild and Discord user", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi();
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "admin" });
    await completeTikTokOAuth(makeClient() as never, makeConfig(true), repository, api, runtime(), {
      state: auth.state,
      code: "code",
    });

    expect(() =>
      repository.consumePendingConnection(auth.state, { guildId: "other", discordUserId: "admin" }),
    ).toThrow(/servidor|confirmarla/i);
    expect(() =>
      repository.consumePendingConnection(auth.state, { guildId: "guild", discordUserId: "other" }),
    ).toThrow(/confirmarla/i);
    expect(repository.findConnection("guild")).toBeUndefined();
    database.close();
  });

  it("DM confirmation works with guildId null and resolves guild from state", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi({ videos: [video("old", 1_000)] });
    const config = makeConfig(true);
    config.guildId = "guild-chepe";
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild-chepe", discordUserId: "123" });
    await completeTikTokOAuth(makeClient() as never, config, repository, api, runtime(), {
      state: auth.state,
      code: "code",
    });
    const interaction = makeButtonInteraction(`${TIKTOK_CONNECT_CONFIRM_PREFIX}${auth.state}`, {
      userId: "123",
      guildId: null,
      admin: true,
    });
    const configManager = makeConfigManager([config]);

    const handled = await handleTikTokPendingDmButton(interaction as never, configManager, database, {
      runtime: runtime(),
      api,
    });

    expect(handled).toBe(true);
    expect(repository.findConnection("guild-chepe")?.openId).toBe("open-id");
    expect(firstUpdate(interaction).content).toContain("TikTok conectado");
    database.close();
  });

  it("DM cancel works with guildId null", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi();
    const config = makeConfig(true);
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "123" });
    await completeTikTokOAuth(makeClient() as never, config, repository, api, runtime(), {
      state: auth.state,
      code: "code",
    });
    const interaction = makeButtonInteraction(`${TIKTOK_CONNECT_CANCEL_PREFIX}${auth.state}`, {
      userId: "123",
      guildId: null,
      admin: true,
    });

    await handleTikTokPendingDmButton(interaction as never, makeConfigManager([config]), database, {
      runtime: runtime(),
      api,
    });

    expect(repository.findConnection("guild")).toBeUndefined();
    expect(repository.findPendingConnection(auth.state)).toBeUndefined();
    expectRevokeCalled(api, "access-1");
    database.close();
  });

  it("wrong DM user cannot confirm pending TikTok connection", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi();
    const config = makeConfig(true);
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "123" });
    await completeTikTokOAuth(makeClient() as never, config, repository, api, runtime(), {
      state: auth.state,
      code: "code",
    });
    const interaction = makeButtonInteraction(`${TIKTOK_CONNECT_CONFIRM_PREFIX}${auth.state}`, {
      userId: "456",
      guildId: null,
      admin: true,
    });

    await handleTikTokPendingDmButton(interaction as never, makeConfigManager([config]), database, {
      runtime: runtime(),
      api,
    });

    expect(repository.findConnection("guild")).toBeUndefined();
    expect(firstButtonReply(interaction).content).toContain("Solo quien inicio");
    database.close();
  });

  it("admin who lost Administrator cannot confirm pending TikTok connection", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi();
    const config = makeConfig(true);
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "123" });
    await completeTikTokOAuth(makeClient() as never, config, repository, api, runtime(), {
      state: auth.state,
      code: "code",
    });
    const interaction = makeButtonInteraction(`${TIKTOK_CONNECT_CONFIRM_PREFIX}${auth.state}`, {
      userId: "123",
      guildId: null,
      admin: false,
    });

    await handleTikTokPendingDmButton(interaction as never, makeConfigManager([config]), database, {
      runtime: runtime(),
      api,
    });

    expect(repository.findConnection("guild")).toBeUndefined();
    expect(firstButtonReply(interaction).content).toContain("Administrador");
    database.close();
  });

  it("Chepe pending state never uses Maus config", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi();
    const chepe = makeConfig(true);
    chepe.guildId = "guild-chepe";
    const maus = makeConfig(true);
    maus.guildId = "guild-maus";
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild-chepe", discordUserId: "123" });
    await completeTikTokOAuth(makeClient() as never, chepe, repository, api, runtime(), {
      state: auth.state,
      code: "code",
    });
    const get = vi.fn((guildId: string) => (guildId === "guild-chepe" ? chepe : maus));
    const interaction = makeButtonInteraction(`${TIKTOK_CONNECT_CONFIRM_PREFIX}${auth.state}`, {
      userId: "123",
      guildId: null,
      admin: true,
    });

    await handleTikTokPendingDmButton(interaction as never, { get }, database, {
      runtime: runtime(),
      api,
    });

    expect(get).toHaveBeenCalledWith("guild-chepe");
    expect(repository.findConnection("guild-chepe")).toBeDefined();
    expect(repository.findConnection("guild-maus")).toBeUndefined();
    database.close();
  });

  it("expired pending DM confirmation fails", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi();
    const config = makeConfig(true);
    const old = new Date("2026-08-14T00:00:00.000Z");
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "123", now: old });
    await completeTikTokOAuth(makeClient() as never, config, repository, api, runtime(), {
      state: auth.state,
      code: "code",
      now: old,
    });
    const interaction = makeButtonInteraction(`${TIKTOK_CONNECT_CONFIRM_PREFIX}${auth.state}`, {
      userId: "123",
      guildId: null,
      admin: true,
    });

    await expect(
      handleTikTokPendingDmButton(interaction as never, makeConfigManager([config]), database, {
        runtime: runtime(),
        api,
      }),
    ).rejects.toThrow(/expiro/);
    expect(repository.findConnection("guild")).toBeUndefined();
    database.close();
  });

  it("blocked DM removes pending and revokes token", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi();
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "admin" });

    await expect(
      completeTikTokOAuth(makeClient({ dmReject: true }) as never, makeConfig(true), repository, api, runtime(), {
        state: auth.state,
        code: "code",
      }),
    ).rejects.toThrow(/mensajes directos/);

    expect(repository.findPendingConnection(auth.state)).toBeUndefined();
    expect(repository.findConnection("guild")).toBeUndefined();
    expectRevokeCalled(api, "access-1");
    database.close();
  });

  it("unknown DM button is not handled by TikTok pending router", async () => {
    const database = await openMemoryDatabase();
    const interaction = makeButtonInteraction("rules:accept", { userId: "123", guildId: null, admin: true });

    const handled = await handleTikTokPendingDmButton(interaction as never, makeConfigManager([makeConfig(true)]), database, {
      runtime: runtime(),
      api: makeApi(),
    });

    expect(handled).toBe(false);
    expect(isTikTokPendingButton("rules:accept")).toBe(false);
    expect(interaction.reply).not.toHaveBeenCalled();
    database.close();
  });

  it("rejects incomplete scopes and revokes token without pending", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi({ exchange: { ...token("access-1", "refresh-1"), scopes: ["user.info.basic"] } });
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "admin" });

    await expect(
      completeTikTokOAuth(makeClient() as never, makeConfig(true), repository, api, runtime(), {
        state: auth.state,
        code: "code",
      }),
    ).rejects.toThrow(/video.list/);

    expect(repository.findPendingConnection(auth.state)).toBeUndefined();
    expect(repository.findConnection("guild")).toBeUndefined();
    expectRevokeCalled(api, "access-1");
    database.close();
  });

  it("accepts required scopes in any order", async () => {
    const database = await openMemoryDatabase();
    const repository = new TikTokRepository(database);
    const api = makeApi({ exchange: { ...token("access-1", "refresh-1"), scopes: ["video.list", "user.info.basic"] } });
    const auth = createTikTokAuthorization(repository, api, { guildId: "guild", discordUserId: "admin" });

    await completeTikTokOAuth(makeClient() as never, makeConfig(true), repository, api, runtime(), {
      state: auth.state,
      code: "code",
    });

    expect(repository.findPendingConnection(auth.state)).toBeDefined();
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
      return Promise.resolve(jsonResponse({ data: { videos: [video("api-video", 1_000)], cursor: 20, has_more: true } }));
    }) as unknown as typeof fetch;
    const api = new TikTokApiClient(runtime(), fetcher);

    await api.exchangeCode("code");
    await api.getUserInfo("access-api");
    const page = await api.listVideosPage("access-api", { maxCount: 20, cursor: 10 });

    expect(calls[0]?.url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    expect(stringifyBody(calls[0]?.init.body)).toContain("grant_type=authorization_code");
    expect(calls[1]?.url).toContain("https://open.tiktokapis.com/v2/user/info/");
    expect(calls[2]?.url).toContain("https://open.tiktokapis.com/v2/video/list/");
    expect(calls[2]?.init.method).toBe("POST");
    expect(stringifyBody(calls[2]?.init.body)).toContain('"cursor":10');
    expect(page.cursor).toBe(20);
    expect(page.hasMore).toBe(true);
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
    const server = new TikTokCallbackServer(makeClient() as never, makeConfigManager([makeConfig(true)]), new TikTokRepository(database), makeApi(), configured);
    await server.start();
    const address = server.address();

    expect(typeof address === "object" && address ? address.address : "").toBe(configured.callbackHost);
    await server.stop();
    database.close();
  });

  it("serves public homepage, terms and privacy pages", async () => {
    const database = await openMemoryDatabase();
    const server = new TikTokCallbackServer(makeClient() as never, makeConfigManager([makeConfig(true)]), new TikTokRepository(database), makeApi(), runtime());
    await server.start();
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const home = await fetch(`http://127.0.0.1:${port}/`);
    const terms = await fetch(`http://127.0.0.1:${port}/terms`);
    const privacy = await fetch(`http://127.0.0.1:${port}/privacy`);

    expect(home.status).toBe(200);
    expect(await home.text()).toContain("LinuxRed Connect");
    expect(terms.status).toBe(200);
    expect(privacy.status).toBe(200);
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

  it("/tiktok republicar fails clearly without connected account", async () => {
    const database = await openMemoryDatabase();
    stubTikTokEnv();
    const interaction = makeInteraction("republicar", { isAdministrator: true });

    await tiktokCommand.execute(interaction as never, { config: makeConfig(true), database });

    expect(firstReply(interaction).content).toContain("No hay una cuenta TikTok conectada");
    database.close();
  });

  it("/tiktok republicar fetches TikTok videos and returns ephemeral select menu", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);
    keepConnectionFresh(repository);
    stubTikTokEnv();
    vi.spyOn(TikTokApiClient.prototype, "listVideosPage").mockResolvedValueOnce({ videos: [video("old", 3_000)], hasMore: false });
    const interaction = makeInteraction("republicar", { isAdministrator: true });

    await tiktokCommand.execute(interaction as never, { config: makeConfig(true), database });

    const reply = firstReply(interaction);
    expect(reply.ephemeral).toBe(true);
    expect(reply.components?.[0]).toBeDefined();
    database.close();
  });

  it("/tiktok republicar limits menu options to 20 videos", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);
    keepConnectionFresh(repository);
    stubTikTokEnv();
    const interaction = makeInteraction("republicar", { isAdministrator: true });
    const apiVideos = Array.from({ length: 30 }, (_, index) => video(`video-${index}`, 3_000 + index));
    vi.spyOn(TikTokApiClient.prototype, "listVideosPage").mockResolvedValueOnce({ videos: apiVideos, hasMore: true, cursor: 123 });

    await tiktokCommand.execute(interaction as never, { config: makeConfig(true), database });

    expect(repository.findConnection("guild")).toBeDefined();
    expect(JSON.stringify(firstReply(interaction).components)).not.toContain("video-25");
    database.close();
  });

  it("/tiktok republicar paginates next and previous without changing sessions across users", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);
    keepConnectionFresh(repository);
    const config = makeConfig(true);
    const session = createTikTokRepublishSession({
      guildId: "guild",
      discordUserId: "admin",
      displayName: "CuentaTikTok",
      page: { videos: [video("page-1", 3_000)], hasMore: true, cursor: 50 },
    });
    const api = makeApi({ pages: [{ videos: [video("page-2", 3_100)], hasMore: false }] });
    const nextInteraction = makeRepublishButtonInteraction(`${TIKTOK_REPUBLISH_NEXT_PREFIX}${session.id}`, {
      userId: "admin",
      guildId: "guild",
      isAdministrator: true,
    });

    await handleTikTokButton(nextInteraction as never, config, database, { runtime: runtime(), api });

    expect(JSON.stringify(firstUpdate(nextInteraction))).toContain("page-2");
    const blockedInteraction = makeRepublishButtonInteraction(`${TIKTOK_REPUBLISH_NEXT_PREFIX}${session.id}`, {
      userId: "other",
      guildId: "guild",
      isAdministrator: true,
    });

    await handleTikTokButton(blockedInteraction as never, config, database, { runtime: runtime(), api });

    expect(firstButtonReply(blockedInteraction).content).toContain("otro servidor o administrador");
    const previousInteraction = makeRepublishButtonInteraction(`${TIKTOK_REPUBLISH_PREVIOUS_PREFIX}${session.id}`, {
      userId: "admin",
      guildId: "guild",
      isAdministrator: true,
    });

    await handleTikTokButton(previousInteraction as never, config, database, { runtime: runtime(), api });

    expect(JSON.stringify(firstUpdate(previousInteraction))).toContain("page-1");
    database.close();
  });

  it("/tiktok republicar can publish a selected video from page 2 without revalidating page 1", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);
    keepConnectionFresh(repository);
    repository.updatePollingState("guild", { lastCheckAt: "before", lastSuccessAt: "before", lastVideoId: "before-video" });
    stubTikTokEnv();
    const config = makeConfig(true);
    const commandInteraction = makeInteraction("republicar", { isAdministrator: true });
    vi.spyOn(TikTokApiClient.prototype, "listVideosPage").mockResolvedValueOnce({
      videos: [video("video-page-1", 3_000)],
      cursor: 100,
      hasMore: true,
    });

    await tiktokCommand.execute(commandInteraction as never, { config, database });

    const sessionId = extractRepublishSessionId(firstReply(commandInteraction).components, TIKTOK_REPUBLISH_NEXT_PREFIX);
    const api = makeApi({ pages: [{ videos: [video("video-page-2", 3_100, "Video pagina dos")], hasMore: false }] });
    const nextInteraction = makeRepublishButtonInteraction(`${TIKTOK_REPUBLISH_NEXT_PREFIX}${sessionId}`, {
      userId: "admin",
      guildId: "guild",
      isAdministrator: true,
    });

    await handleTikTokButton(nextInteraction as never, config, database, { runtime: runtime(), api });

    const selectInteraction = makeSelectInteraction(
      extractCustomId(firstUpdate(nextInteraction).components, TIKTOK_REPUBLISH_SELECT_PREFIX),
      "video-page-2",
      { userId: "admin", guildId: "guild", isAdministrator: true },
    );

    await handleTikTokRepublishSelect(selectInteraction as never, config, database);

    expect(selectInteraction.client.generalSend).toHaveBeenCalled();
    expect(JSON.stringify(firstAlertPayload(selectInteraction.client))).toContain("video-page-2");
    expect(selectInteraction.reply).not.toHaveBeenCalled();
    expect((api.listVideos as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
    expect(repository.hasPublishedVideo("guild", "open-id", "video-page-2")).toBe(false);
    const after = repository.findConnection("guild");
    expect(after?.lastVideoId).toBe("before-video");
    expect(after?.lastCheckAt).toBe("before");
    expect(after?.lastSuccessAt).toBe("before");
    database.close();
  });

  it("/tiktok republicar pagination cannot be used from another guild", async () => {
    const database = await openMemoryDatabase();
    const config = makeConfig(true);
    config.guildId = "other-guild";
    const session = createTikTokRepublishSession({
      guildId: "guild",
      discordUserId: "admin",
      page: { videos: [video("page-1", 3_000)], hasMore: true, cursor: 50 },
    });
    const interaction = makeRepublishButtonInteraction(`${TIKTOK_REPUBLISH_NEXT_PREFIX}${session.id}`, {
      userId: "admin",
      guildId: "other-guild",
      isAdministrator: true,
    });

    await handleTikTokButton(interaction as never, config, database, {
      runtime: runtime(),
      api: makeApi({ pages: [{ videos: [video("page-2", 3_100)], hasMore: false }] }),
    });

    expect(firstButtonReply(interaction).content).toContain("otro servidor");
    database.close();
  });

  it("/tiktok republicar rejects next page when the connected account changed", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);
    keepConnectionFresh(repository);
    const config = makeConfig(true);
    const session = createTikTokRepublishSession({
      guildId: "guild",
      discordUserId: "admin",
      openId: "open-id",
      page: { videos: [video("page-1", 3_000)], hasMore: true, cursor: 50 },
    });
    changeConnectionOpenId(repository, "open-id-b");
    const api = makeApi({ pages: [{ videos: [video("page-2", 3_100)], hasMore: false }] });
    const interaction = makeRepublishButtonInteraction(`${TIKTOK_REPUBLISH_NEXT_PREFIX}${session.id}`, {
      userId: "admin",
      guildId: "guild",
      isAdministrator: true,
    });

    await handleTikTokButton(interaction as never, config, database, { runtime: runtime(), api });

    expect(firstButtonReply(interaction).content).toContain("cuenta TikTok conectada cambio");
    expect((api.listVideosPage as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
    database.close();
  });

  it("/tiktok republicar rejects selected video when the connected account changed", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);
    const config = makeConfig(true);
    const customId = createRepublishCustomId("guild", "admin", [video("old", 3_000)], "open-id");
    changeConnectionOpenId(repository, "open-id-b");
    const selectInteraction = makeSelectInteraction(customId, "old", {
      userId: "admin",
      guildId: "guild",
      isAdministrator: true,
    });

    await handleTikTokRepublishSelect(selectInteraction as never, config, database);

    expect(firstButtonReply(selectInteraction).content).toContain("cuenta TikTok conectada cambio");
    expect(selectInteraction.client.generalSend).not.toHaveBeenCalled();
    database.close();
  });

  it("/tiktok republicar rejects hasMore without cursor without duplicating pages", async () => {
    const database = await openMemoryDatabase();
    await connectedRepository(database);
    const config = makeConfig(true);
    const session = createTikTokRepublishSession({
      guildId: "guild",
      discordUserId: "admin",
      openId: "open-id",
      page: { videos: [video("page-1", 3_000)], hasMore: true },
    });
    const api = makeApi({ pages: [{ videos: [video("page-2", 3_100)], hasMore: false }] });
    const logger = { error: vi.fn() };
    const interaction = makeRepublishButtonInteraction(`${TIKTOK_REPUBLISH_NEXT_PREFIX}${session.id}`, {
      userId: "admin",
      guildId: "guild",
      isAdministrator: true,
    });

    await handleTikTokButton(interaction as never, config, database, { runtime: runtime(), api, logger: logger as never });

    expect(firstButtonReply(interaction).content).toContain("cursor valido");
    expect((api.listVideosPage as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
    expect(session.pages).toHaveLength(1);
    expect(logger.error).toHaveBeenCalled();
    database.close();
  });

  it("selecting a republish video posts to configured general channel with mention and keeps dedupe state", async () => {
    const database = await openMemoryDatabase();
    const repository = await connectedRepository(database);
    repository.markVideoPublished("guild", "open-id", "already", 2_500);
    repository.updatePollingState("guild", { lastCheckAt: "before", lastSuccessAt: "before", lastVideoId: "already" });
    const config = makeConfig(true, "here");
    const api = makeApi({ videos: [video("already", 3_000, "Republicar descripcion")] });
    const customId = createRepublishCustomId("guild", "admin", [video("already", 3_000, "Republicar descripcion")]);
    const selectInteraction = makeSelectInteraction(customId, "already", { userId: "admin", guildId: "guild", isAdministrator: true });

    await handleTikTokRepublishSelect(selectInteraction as never, config, database, {
      runtime: runtime(),
      api,
    });

    expect(selectInteraction.client.generalSend).toHaveBeenCalled();
    expect(firstAlertPayload(selectInteraction.client).content).toBe("@here");
    const alertPayload = JSON.stringify(firstAlertPayload(selectInteraction.client));
    expect(alertPayload).toContain("Republicar descripcion");
    expect(alertPayload).toContain("vuelve a compartir uno de sus videos");
    expect(alertPayload).not.toContain("acaba de publicar un nuevo video");
    expect(repository.hasPublishedVideo("guild", "open-id", "already")).toBe(true);
    const afterRepublish = repository.findConnection("guild");
    expect(afterRepublish?.lastVideoId).toBe("already");
    expect(afterRepublish?.lastCheckAt).toBe("before");
    expect(afterRepublish?.lastSuccessAt).toBe("before");
    const automatic = await checkTikTokVideos(makeClient() as never, config, repository, api, runtime(), { mention: "ninguna" });
    expect(automatic).toBe(0);
    database.close();
  });

  it("another user cannot use a republish select menu", async () => {
    const database = await openMemoryDatabase();
    const config = makeConfig(true);
    const selectInteraction = makeSelectInteraction(createRepublishCustomId("guild", "admin", [video("old", 3_000)]), "old", {
      userId: "other",
      guildId: "guild",
      isAdministrator: true,
    });

    await handleTikTokRepublishSelect(selectInteraction as never, config, database, {
      runtime: runtime(),
      api: makeApi({ videos: [video("old", 3_000)] }),
    });

    expect(firstButtonReply(selectInteraction).content).toContain("otro servidor o administrador");
    expect(selectInteraction.client.generalSend).not.toHaveBeenCalled();
    database.close();
  });

  it("admin who lost permissions cannot use republish select menu", async () => {
    const database = await openMemoryDatabase();
    const config = makeConfig(true);
    const selectInteraction = makeSelectInteraction(createRepublishCustomId("guild", "admin", [video("old", 3_000)]), "old", {
      userId: "admin",
      guildId: "guild",
      isAdministrator: false,
    });

    await handleTikTokRepublishSelect(selectInteraction as never, config, database, {
      runtime: runtime(),
      api: makeApi({ videos: [video("old", 3_000)] }),
    });

    expect(firstButtonReply(selectInteraction).content).toContain("Administrador");
    expect(selectInteraction.client.generalSend).not.toHaveBeenCalled();
    database.close();
  });

  it("guild A cannot use republish select from guild B", async () => {
    const database = await openMemoryDatabase();
    const otherConfig = makeConfig(true);
    otherConfig.guildId = "other-guild";
    const selectInteraction = makeSelectInteraction(createRepublishCustomId("guild", "admin", [video("old", 3_000)]), "old", {
      userId: "admin",
      guildId: "other-guild",
      isAdministrator: true,
    });

    await handleTikTokRepublishSelect(selectInteraction as never, otherConfig, database, {
      runtime: runtime(),
      api: makeApi({ videos: [video("old", 3_000)] }),
    });

    expect(firstButtonReply(selectInteraction).content).toContain("otro servidor");
    expect(selectInteraction.client.generalSend).not.toHaveBeenCalled();
    database.close();
  });

  it("expired republish select reports clear error and does not publish", async () => {
    const database = await openMemoryDatabase();
    const config = makeConfig(true);
    const selectInteraction = makeSelectInteraction("tiktok:republish:select:expired", "old", {
      userId: "admin",
      guildId: "guild",
      isAdministrator: true,
    });

    await handleTikTokRepublishSelect(selectInteraction as never, config, database, {
      runtime: runtime(),
      api: makeApi({ videos: [video("old", 3_000)] }),
    });

    expect(firstButtonReply(selectInteraction).content).toContain("expiro");
    expect(selectInteraction.client.generalSend).not.toHaveBeenCalled();
    database.close();
  });

  it("republish rejects a video id outside the current saved page without exposing secrets", async () => {
    const database = await openMemoryDatabase();
    await connectedRepository(database);
    const config = makeConfig(true);
    const selectInteraction = makeSelectInteraction(createRepublishCustomId("guild", "admin", [video("allowed", 3_000)]), "old", {
      userId: "admin",
      guildId: "guild",
      isAdministrator: true,
    });

    await handleTikTokRepublishSelect(selectInteraction as never, config, database);
    expect(firstButtonReply(selectInteraction).content).toContain("no pertenece");
    expect(JSON.stringify(selectInteraction.update.mock.calls)).not.toMatch(/access|refresh|secret/i);
    database.close();
  });

  it("republish send failure is logged safely and replies with a generic message", async () => {
    const database = await openMemoryDatabase();
    await connectedRepository(database);
    const config = makeConfig(true);
    const selectInteraction = makeSelectInteraction(createRepublishCustomId("guild", "admin", [video("old", 3_000)]), "old", {
      userId: "admin",
      guildId: "guild",
      isAdministrator: true,
    });
    selectInteraction.client.generalSend.mockRejectedValueOnce(new Error("send failed access_token_123456789012345678901234567890"));
    const logger = { error: vi.fn() };

    await handleTikTokRepublishSelect(selectInteraction as never, config, database, {
      runtime: runtime(),
      api: makeApi({ videos: [video("old", 3_000)] }),
      logger: logger as never,
    });

    expect(firstButtonReply(selectInteraction).content).toBe("No se pudo republicar el video TikTok en este momento.");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("access_token_123456789012345678901234567890");
    expect(JSON.stringify(logger.error.mock.calls)).toContain("[REDACTED]");
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
  pages?: TikTokVideoPage[];
} = {}): TikTokApiClient {
  const pages = [...(values.pages ?? [])];
  return {
    buildAuthorizeUrl: (state: string) => `https://www.tiktok.com/v2/auth/authorize/?state=${state}`,
    exchangeCode: vi.fn(() => Promise.resolve(values.exchange ?? token("access-1", "refresh-1"))),
    refreshToken: vi.fn(() => Promise.resolve(values.refresh ?? token("access-r", "refresh-r"))),
    revokeToken: vi.fn(() => Promise.resolve()),
    getUserInfo: vi.fn(() => Promise.resolve(values.userInfo ?? user())),
    listVideos: vi.fn(() => Promise.resolve(values.videos ?? [])),
    listVideosPage: vi.fn(() => Promise.resolve(pages.shift() ?? { videos: values.videos ?? [], hasMore: false })),
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
  await confirmTikTokPendingConnection(repository, api, runtime(), {
    state: auth.state,
    guildId: "guild",
    discordUserId: "admin",
    now: new Date(2_000_000),
  });
  return repository;
}

function keepConnectionFresh(repository: TikTokRepository, guildId = "guild"): void {
  const connection = repository.findConnection(guildId);
  if (!connection) {
    throw new Error(`Missing TikTok connection for ${guildId}.`);
  }
  repository.upsertConnection({
    ...connection,
    accessTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

function changeConnectionOpenId(repository: TikTokRepository, openId: string, guildId = "guild"): void {
  const connection = repository.findConnection(guildId);
  if (!connection) {
    throw new Error(`Missing TikTok connection for ${guildId}.`);
  }
  repository.upsertConnection({
    ...connection,
    openId,
    displayName: `Cuenta ${openId}`,
  });
}

function stubTikTokEnv(): void {
  const config = runtime();
  vi.stubEnv("TIKTOK_CLIENT_KEY", config.clientKey);
  vi.stubEnv("TIKTOK_CLIENT_SECRET", config.clientSecret);
  vi.stubEnv("TIKTOK_REDIRECT_URI", config.redirectUri);
  vi.stubEnv("TIKTOK_CALLBACK_HOST", config.callbackHost);
  vi.stubEnv("TIKTOK_CALLBACK_PORT", "8787");
  vi.stubEnv("TIKTOK_TOKEN_ENCRYPTION_KEY", config.encryptionKey.toString("base64"));
}

function createRepublishCustomId(guildId: string, discordUserId: string, videos: TikTokVideo[], openId = "open-id"): string {
  const session = createTikTokRepublishSession({ guildId, discordUserId, openId, videos });
  return `${TIKTOK_REPUBLISH_SELECT_PREFIX}${session.id}`;
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

function makeConfigManager(configs: ServerConfig[]) {
  const map = new Map(configs.map((config) => [config.guildId, config]));
  return {
    get: (guildId: string) => {
      const config = map.get(guildId);
      if (!config) {
        throw new Error(`Missing config ${guildId}`);
      }
      return config;
    },
    find: (guildId: string) => map.get(guildId),
    list: () => [...map.values()],
  } as never;
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

function makeClient(options: { dmReject?: boolean } = {}) {
  const generalSend = vi.fn((payload: AlertPayload) => {
    void payload;
    return Promise.resolve();
  });
  const logSend = vi.fn((payload: AlertPayload) => {
    void payload;
    return Promise.resolve();
  });
  const dmSend = vi.fn((payload: unknown) => {
    void payload;
    return options.dmReject ? Promise.reject(new Error("DM blocked")) : Promise.resolve();
  });
  return {
    generalSend,
    logSend,
    dmSend,
    channels: {
      fetch: vi.fn((id: string) =>
        Promise.resolve(
          id === "general-id"
            ? { id, name: "general", type: ChannelType.GuildText, send: generalSend }
            : { id, name: "logs", type: ChannelType.GuildText, send: logSend },
        ),
      ),
    },
    users: {
      fetch: vi.fn(() => Promise.resolve({ send: dmSend })),
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

function firstDmPayload(client: ReturnType<typeof makeClient>): { content: string } {
  const payload = client.dmSend.mock.calls[0]?.[0];
  if (!isContentPayload(payload)) {
    throw new Error("No DM payload.");
  }
  return payload;
}

function isContentPayload(value: unknown): value is { content: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as { content?: unknown }).content === "string";
}

function expectRevokeCalled(api: TikTokApiClient, tokenValue: string): void {
  const calls = (api.revokeToken as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  expect(calls).toContainEqual([tokenValue]);
}

function makeButtonInteraction(customId: string, options: { userId: string; guildId: string | null; admin: boolean }) {
  const reply = vi.fn((payload: { content: string; ephemeral: boolean }) => {
    void payload;
    return Promise.resolve();
  });
  const update = vi.fn((payload: { content: string; components: unknown[] }) => {
    void payload;
    return Promise.resolve();
  });
  return {
    customId,
    guildId: options.guildId,
    user: { id: options.userId },
    client: {
      guilds: {
        fetch: vi.fn(() =>
          Promise.resolve({
            members: {
              fetch: vi.fn(() =>
                Promise.resolve({
                  permissions: { has: vi.fn(() => options.admin) },
                }),
              ),
            },
          }),
        ),
      },
    },
    reply,
    update,
  };
}

function firstButtonReply(interaction: {
  reply: { mock: { calls: Array<Array<{ content: string; ephemeral: boolean }>> } };
}): { content: string; ephemeral: boolean } {
  const payload = interaction.reply.mock.calls[0]?.[0];
  if (!payload) {
    throw new Error("No button reply.");
  }
  return payload;
}

function firstUpdate(interaction: {
  update: { mock: { calls: Array<Array<{ content: string; components: unknown[] }>> } };
}): { content: string; components: unknown[] } {
  const payload = interaction.update.mock.calls[0]?.[0];
  if (!payload) {
    throw new Error("No button update.");
  }
  return payload;
}

function makeRepublishButtonInteraction(
  customId: string,
  options: { userId: string; guildId: string; isAdministrator: boolean },
) {
  const reply = vi.fn((payload: { content: string; ephemeral: boolean }) => {
    void payload;
    return Promise.resolve();
  });
  const update = vi.fn((payload: { content: string; components: unknown[] }) => {
    void payload;
    return Promise.resolve();
  });
  return {
    customId,
    guildId: options.guildId,
    user: { id: options.userId },
    memberPermissions: {
      has: (permission: bigint) => options.isAdministrator && permission === PermissionFlagsBits.Administrator,
    },
    reply,
    update,
  };
}

function extractRepublishSessionId(components: unknown[] | undefined, prefix: string): string {
  const customId = extractCustomId(components, prefix);
  return customId.slice(prefix.length);
}

function extractCustomId(components: unknown[] | undefined, prefix: string): string {
  const json = JSON.stringify(components);
  const pattern = new RegExp(`${escapeRegExp(prefix)}[A-Za-z0-9_-]+`);
  const match = json.match(pattern);
  if (!match) {
    throw new Error(`No custom id with prefix ${prefix}.`);
  }
  return match[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeInteraction(subcommand: string, options: {
  isAdministrator?: boolean;
  hasPermission?: (permission: bigint) => boolean;
}) {
  const reply = vi.fn((payload: { content: string; ephemeral: boolean; components?: unknown[] }) => {
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

function firstReply(interaction: ReturnType<typeof makeInteraction>): { content: string; ephemeral: boolean; components?: unknown[] } {
  const payload = interaction.reply.mock.calls[0]?.[0];
  if (!payload) {
    throw new Error("No reply payload.");
  }
  return payload;
}

function makeSelectInteraction(customId: string, videoId: string, options: { userId: string; guildId: string; isAdministrator: boolean }) {
  const client = makeClient();
  const reply = vi.fn((payload: { content: string; ephemeral: boolean }) => {
    void payload;
    return Promise.resolve();
  });
  const update = vi.fn((payload: { content: string; components: unknown[] }) => {
    void payload;
    return Promise.resolve();
  });
  return {
    customId,
    values: [videoId],
    guildId: options.guildId,
    user: { id: options.userId },
    client,
    memberPermissions: {
      has: (permission: bigint) => options.isAdministrator && permission === PermissionFlagsBits.Administrator,
    },
    reply,
    update,
  };
}
