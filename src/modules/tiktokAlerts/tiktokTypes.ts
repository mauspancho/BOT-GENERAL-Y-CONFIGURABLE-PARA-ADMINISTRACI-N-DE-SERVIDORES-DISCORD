import type { GeneralAlertMention } from "../../services/generalAlertService.js";

export interface TikTokRuntimeConfig {
  clientKey: string;
  clientSecret: string;
  redirectUri: string;
  callbackHost: string;
  callbackPort: number;
  encryptionKey: Buffer;
}

export interface TikTokOAuthState {
  state: string;
  guildId: string;
  discordUserId: string;
  createdAt: string;
  expiresAt: string;
  used: boolean;
}

export interface TikTokConnection {
  guildId: string;
  openId: string;
  displayName: string;
  avatarUrl?: string | undefined;
  scopes: string[];
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  connectedAt: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  enabled: boolean;
  lastCheckAt?: string | undefined;
  lastSuccessAt?: string | undefined;
  lastVideoId?: string | undefined;
}

export interface TikTokPendingConnection {
  state: string;
  guildId: string;
  discordUserId: string;
  openId: string;
  displayName: string;
  avatarUrl?: string | undefined;
  scopes: string[];
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  connectedAt: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  expiresAt: string;
}

export interface TikTokTokenResponse {
  openId: string;
  scopes: string[];
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
}

export interface TikTokUserInfo {
  openId: string;
  displayName: string;
  avatarUrl?: string | undefined;
}

export interface TikTokVideo {
  id: string;
  title?: string | undefined;
  videoDescription?: string | undefined;
  shareUrl?: string | undefined;
  coverImageUrl?: string | undefined;
  createTime?: number | undefined;
}

export interface TikTokAlertOptions {
  mention: GeneralAlertMention;
  manualTest?: boolean;
  manualRepublish?: boolean;
}
