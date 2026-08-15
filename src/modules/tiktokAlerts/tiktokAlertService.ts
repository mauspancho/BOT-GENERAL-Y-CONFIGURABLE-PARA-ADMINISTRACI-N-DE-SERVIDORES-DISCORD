import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client } from "discord.js";
import type { ServerConfig } from "../../core/config/schema.js";
import type { TikTokRepository } from "../../repositories/tiktokRepository.js";
import { sendDiscordLog } from "../../services/discordLogService.js";
import { sendGeneralAlert } from "../../services/generalAlertService.js";
import { decryptTikTokToken, encryptTikTokToken, randomOAuthState } from "./tiktokCrypto.js";
import type { TikTokApiClient } from "./tiktokApiClient.js";
import type {
  TikTokAlertOptions,
  TikTokConnection,
  TikTokPendingConnection,
  TikTokRuntimeConfig,
  TikTokTokenResponse,
  TikTokUserInfo,
  TikTokVideo,
} from "./tiktokTypes.js";
import {
  TIKTOK_CONNECT_CANCEL_PREFIX,
  TIKTOK_CONNECT_CONFIRM_PREFIX,
} from "./tiktokCustomIds.js";

const stateTtlMs = 10 * 60 * 1000;
const tokenRefreshSkewMs = 5 * 60 * 1000;
const requiredScopes = ["user.info.basic", "video.list"] as const;

export function createTikTokAuthorization(
  repository: TikTokRepository,
  api: TikTokApiClient,
  values: { guildId: string; discordUserId: string; now?: Date },
): { state: string; url: string } {
  const now = values.now ?? new Date();
  repository.deleteExpiredOAuthStates(now);
  const state = randomOAuthState();
  repository.createOAuthState({
    state,
    guildId: values.guildId,
    discordUserId: values.discordUserId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + stateTtlMs).toISOString(),
    used: false,
  });

  return { state, url: api.buildAuthorizeUrl(state) };
}

export async function completeTikTokOAuth(
  client: Client,
  config: ServerConfig,
  repository: TikTokRepository,
  api: TikTokApiClient,
  runtime: TikTokRuntimeConfig,
  values: { state: string; code: string; now?: Date },
): Promise<TikTokConnection> {
  const now = values.now ?? new Date();
  const oauthState = repository.consumeOAuthState(values.state, now);
  const token = await api.exchangeCode(values.code);
  try {
    validateTikTokScopes(token.scopes);
  } catch (error) {
    await api.revokeToken(token.accessToken).catch(() => undefined);
    throw error;
  }

  const user = await api.getUserInfo(token.accessToken);
  const connection = buildConnection(config.guildId, user, token, runtime, now);
  const pending = toPendingConnection(values.state, oauthState.discordUserId, connection, now);
  repository.createPendingConnection(pending);
  try {
    await notifyPendingTikTokConnection(client, pending);
  } catch {
    repository.deletePendingConnection(pending.state);
    await api.revokeToken(token.accessToken).catch(() => undefined);
    throw new Error("Cuenta autorizada, pero Discord no permitio enviar el mensaje de confirmacion. Habilita los mensajes directos del servidor y vuelve a intentarlo.");
  }

  await sendDiscordLog(
    client,
    config,
    [
      "[TIKTOK]",
      "OAuth recibido; esperando confirmacion.",
      `Administrador: <@${oauthState.discordUserId}>`,
      `Cuenta: ${connection.displayName}`,
      "Resultado: PENDIENTE",
    ].join("\n"),
  );

  return connection;
}

export async function cleanupExpiredTikTokArtifacts(
  repository: TikTokRepository,
  api: TikTokApiClient,
  runtime: TikTokRuntimeConfig,
  now = new Date(),
): Promise<void> {
  repository.deleteExpiredOAuthStates(now);
  const expiredPending = repository.listExpiredPendingConnections(now);
  for (const pending of expiredPending) {
    const accessToken = decryptTikTokToken(pending.encryptedAccessToken, runtime.encryptionKey);
    await api.revokeToken(accessToken).catch(() => undefined);
    repository.deletePendingConnection(pending.state);
  }
}

export async function confirmTikTokPendingConnection(
  repository: TikTokRepository,
  api: TikTokApiClient,
  runtime: TikTokRuntimeConfig,
  values: { state: string; guildId: string; discordUserId: string; now?: Date },
): Promise<TikTokConnection> {
  const pending = repository.consumePendingConnection(values.state, values);
  const connection = toConnection(pending);
  repository.upsertConnection(connection);

  const accessToken = decryptTikTokToken(pending.encryptedAccessToken, runtime.encryptionKey);
  const videos = await api.listVideos(accessToken).catch(() => []);
  for (const video of videos) {
    repository.markVideoPublished(connection.guildId, connection.openId, video.id, video.createTime);
  }
  repository.updatePollingState(connection.guildId, {
    lastCheckAt: (values.now ?? new Date()).toISOString(),
    lastSuccessAt: (values.now ?? new Date()).toISOString(),
    lastVideoId: videos[0]?.id,
  });
  repository.deletePendingConnection(values.state);
  return repository.findConnection(connection.guildId) ?? connection;
}

export async function cancelTikTokPendingConnection(
  repository: TikTokRepository,
  api: TikTokApiClient,
  runtime: TikTokRuntimeConfig,
  values: { state: string; guildId: string; discordUserId: string; now?: Date },
): Promise<void> {
  const pending = repository.consumePendingConnection(values.state, values);
  const accessToken = decryptTikTokToken(pending.encryptedAccessToken, runtime.encryptionKey);
  await api.revokeToken(accessToken).catch(() => undefined);
  repository.deletePendingConnection(values.state);
}

export async function refreshTikTokConnectionIfNeeded(
  repository: TikTokRepository,
  api: TikTokApiClient,
  runtime: TikTokRuntimeConfig,
  connection: TikTokConnection,
  now = new Date(),
): Promise<{ connection: TikTokConnection; accessToken: string; refreshed: boolean }> {
  const accessToken = decryptTikTokToken(connection.encryptedAccessToken, runtime.encryptionKey);
  if (new Date(connection.accessTokenExpiresAt).getTime() - tokenRefreshSkewMs > now.getTime()) {
    return { connection, accessToken, refreshed: false };
  }

  const refreshToken = decryptTikTokToken(connection.encryptedRefreshToken, runtime.encryptionKey);
  const token = await api.refreshToken(refreshToken);
  const updated = {
    ...connection,
    encryptedAccessToken: encryptTikTokToken(token.accessToken, runtime.encryptionKey),
    encryptedRefreshToken: encryptTikTokToken(token.refreshToken, runtime.encryptionKey),
    accessTokenExpiresAt: new Date(now.getTime() + token.expiresIn * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(now.getTime() + token.refreshExpiresIn * 1000).toISOString(),
  };
  repository.updateConnectionTokens(connection.guildId, updated);
  return { connection: updated, accessToken: token.accessToken, refreshed: true };
}

export async function checkTikTokVideos(
  client: Client,
  config: ServerConfig,
  repository: TikTokRepository,
  api: TikTokApiClient,
  runtime: TikTokRuntimeConfig,
  options: TikTokAlertOptions,
): Promise<number> {
  const connection = repository.findConnection(config.guildId);
  if (!connection?.enabled) {
    return 0;
  }

  const now = new Date();
  const refreshed = await refreshTikTokConnectionIfNeeded(repository, api, runtime, connection, now);
  const videos = await api.listVideos(refreshed.accessToken);
  const connectedAt = new Date(refreshed.connection.connectedAt).getTime();
  const newVideos = videos
    .filter((video) => !repository.hasPublishedVideo(config.guildId, refreshed.connection.openId, video.id))
    .filter((video) => !video.createTime || video.createTime * 1000 >= connectedAt)
    .sort((left, right) => (left.createTime ?? 0) - (right.createTime ?? 0));

  for (const video of newVideos) {
    await publishTikTokVideo(client, config, refreshed.connection, video, options);
    repository.markVideoPublished(config.guildId, refreshed.connection.openId, video.id, video.createTime);
    repository.updatePollingState(config.guildId, {
      lastCheckAt: now.toISOString(),
      lastSuccessAt: now.toISOString(),
      lastVideoId: video.id,
    });
  }

  if (newVideos.length === 0) {
    repository.updatePollingState(config.guildId, {
      lastCheckAt: now.toISOString(),
      lastSuccessAt: now.toISOString(),
    });
  }

  return newVideos.length;
}

export async function sendTikTokTestAlert(
  client: Client,
  config: ServerConfig,
  repository: TikTokRepository,
  api: TikTokApiClient,
  runtime: TikTokRuntimeConfig,
): Promise<TikTokVideo | undefined> {
  const connection = repository.findConnection(config.guildId);
  if (!connection) {
    throw new Error("No hay una cuenta TikTok conectada.");
  }
  const refreshed = await refreshTikTokConnectionIfNeeded(repository, api, runtime, connection);
  const [video] = await api.listVideos(refreshed.accessToken, 1);
  if (!video) {
    return undefined;
  }

  await publishTikTokVideo(client, config, refreshed.connection, video, {
    mention: config.tiktokAlerts.mention,
    manualTest: true,
  });
  repository.markVideoPublished(config.guildId, refreshed.connection.openId, video.id, video.createTime);
  repository.updatePollingState(config.guildId, {
    lastCheckAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    lastVideoId: video.id,
  });
  return video;
}

export async function republishTikTokVideo(
  client: Client,
  config: ServerConfig,
  repository: TikTokRepository,
  api: TikTokApiClient,
  runtime: TikTokRuntimeConfig,
  videoId: string,
): Promise<TikTokVideo> {
  const connection = repository.findConnection(config.guildId);
  if (!connection) {
    throw new Error("No hay una cuenta TikTok conectada.");
  }
  const refreshed = await refreshTikTokConnectionIfNeeded(repository, api, runtime, connection);
  const videos = await api.listVideos(refreshed.accessToken, 20);
  const video = videos.find((candidate) => candidate.id === videoId);
  if (!video) {
    throw new Error("El video seleccionado ya no esta disponible para esta cuenta TikTok.");
  }

  await publishTikTokVideo(client, config, refreshed.connection, video, {
    mention: config.tiktokAlerts.mention,
    manualRepublish: true,
  });
  return video;
}

export async function disconnectTikTok(
  repository: TikTokRepository,
  api: TikTokApiClient,
  runtime: TikTokRuntimeConfig,
  guildId: string,
): Promise<void> {
  const connection = repository.findConnection(guildId);
  if (connection) {
    const accessToken = decryptTikTokToken(connection.encryptedAccessToken, runtime.encryptionKey);
    await api.revokeToken(accessToken).catch(() => undefined);
  }
  repository.deleteConnection(guildId);
}

function buildConnection(
  guildId: string,
  user: TikTokUserInfo,
  token: TikTokTokenResponse,
  runtime: TikTokRuntimeConfig,
  now: Date,
): TikTokConnection {
  return {
    guildId,
    openId: user.openId,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    scopes: token.scopes,
    encryptedAccessToken: encryptTikTokToken(token.accessToken, runtime.encryptionKey),
    encryptedRefreshToken: encryptTikTokToken(token.refreshToken, runtime.encryptionKey),
    connectedAt: now.toISOString(),
    accessTokenExpiresAt: new Date(now.getTime() + token.expiresIn * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(now.getTime() + token.refreshExpiresIn * 1000).toISOString(),
    enabled: true,
  };
}

function toPendingConnection(
  state: string,
  discordUserId: string,
  connection: TikTokConnection,
  now: Date,
): TikTokPendingConnection {
  return {
    state,
    guildId: connection.guildId,
    discordUserId,
    openId: connection.openId,
    displayName: connection.displayName,
    avatarUrl: connection.avatarUrl,
    scopes: connection.scopes,
    encryptedAccessToken: connection.encryptedAccessToken,
    encryptedRefreshToken: connection.encryptedRefreshToken,
    connectedAt: connection.connectedAt,
    accessTokenExpiresAt: connection.accessTokenExpiresAt,
    refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
    expiresAt: new Date(now.getTime() + stateTtlMs).toISOString(),
  };
}

function toConnection(pending: TikTokPendingConnection): TikTokConnection {
  return {
    guildId: pending.guildId,
    openId: pending.openId,
    displayName: pending.displayName,
    avatarUrl: pending.avatarUrl,
    scopes: pending.scopes,
    encryptedAccessToken: pending.encryptedAccessToken,
    encryptedRefreshToken: pending.encryptedRefreshToken,
    connectedAt: pending.connectedAt,
    accessTokenExpiresAt: pending.accessTokenExpiresAt,
    refreshTokenExpiresAt: pending.refreshTokenExpiresAt,
    enabled: true,
  };
}

export function validateTikTokScopes(scopes: string[]): void {
  const scopeSet = new Set(scopes);
  const missing = requiredScopes.filter((scope) => !scopeSet.has(scope));
  if (missing.length > 0) {
    throw new Error(`TikTok no autorizo los scopes requeridos: ${missing.join(", ")}.`);
  }
}

async function notifyPendingTikTokConnection(client: Client, pending: TikTokPendingConnection): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TIKTOK_CONNECT_CONFIRM_PREFIX}${pending.state}`)
      .setLabel("Confirmar cuenta")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${TIKTOK_CONNECT_CANCEL_PREFIX}${pending.state}`)
      .setLabel("Cancelar")
      .setStyle(ButtonStyle.Secondary),
  );
  const message = [`Cuenta TikTok detectada:`, pending.displayName, "", "Confirma si esta es la cuenta correcta."].join("\n");
  await client.users.fetch(pending.discordUserId).then((user) =>
    user.send({
      content: message,
      components: [row],
    }),
  );
}

async function publishTikTokVideo(
  client: Client,
  config: ServerConfig,
  connection: TikTokConnection,
  video: TikTokVideo,
  options: TikTokAlertOptions,
): Promise<void> {
  const description = video.videoDescription ?? video.title ?? "Nuevo video publicado.";
  await sendGeneralAlert(client, config, {
    type: "informacion",
    title: options.manualRepublish ? "TikTok republicado" : options.manualTest ? "TikTok prueba manual" : "Nuevo video en TikTok",
    message: [
      `${connection.displayName} acaba de publicar un nuevo video.`,
      "",
      description,
      ...(video.shareUrl ? ["", `Ver video:\n${video.shareUrl}`] : []),
    ].join("\n"),
    mention: options.mention,
    source: options.manualTest ? "tiktok-prueba" : "tiktok",
    ...(video.shareUrl ? { url: video.shareUrl } : {}),
    ...(video.coverImageUrl ? { thumbnailUrl: video.coverImageUrl } : {}),
  });
}
