import type {
  TikTokRuntimeConfig,
  TikTokTokenResponse,
  TikTokUserInfo,
  TikTokVideo,
  TikTokVideoPage,
} from "./tiktokTypes.js";

type Fetcher = typeof fetch;

interface TikTokErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
}

export class TikTokApiClient {
  public constructor(
    private readonly runtime: Pick<TikTokRuntimeConfig, "clientKey" | "clientSecret" | "redirectUri">,
    private readonly fetcher: Fetcher = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  public buildAuthorizeUrl(state: string): string {
    const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
    url.searchParams.set("client_key", this.runtime.clientKey);
    url.searchParams.set("scope", "user.info.basic,video.list");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", this.runtime.redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  public async exchangeCode(code: string): Promise<TikTokTokenResponse> {
    return this.postToken({
      client_key: this.runtime.clientKey,
      client_secret: this.runtime.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: this.runtime.redirectUri,
    });
  }

  public async refreshToken(refreshToken: string): Promise<TikTokTokenResponse> {
    return this.postToken({
      client_key: this.runtime.clientKey,
      client_secret: this.runtime.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  public async revokeToken(accessToken: string): Promise<void> {
    await this.requestJson("https://open.tiktokapis.com/v2/oauth/revoke/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: this.runtime.clientKey,
        client_secret: this.runtime.clientSecret,
        token: accessToken,
      }),
    });
  }

  public async getUserInfo(accessToken: string): Promise<TikTokUserInfo> {
    const url = new URL("https://open.tiktokapis.com/v2/user/info/");
    url.searchParams.set("fields", "open_id,display_name,avatar_url");
    const json = await this.requestJson(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = asRecord(asRecord(json).data).user;
    const userRecord = asRecord(user);
    return {
      openId: readString(userRecord, "open_id"),
      displayName: readString(userRecord, "display_name"),
      avatarUrl: readOptionalString(userRecord, "avatar_url"),
    };
  }

  public async listVideos(accessToken: string, maxCount = 20): Promise<TikTokVideo[]> {
    return (await this.listVideosPage(accessToken, { maxCount })).videos;
  }

  public async listVideosPage(
    accessToken: string,
    options: { maxCount?: number; cursor?: number | undefined } = {},
  ): Promise<TikTokVideoPage> {
    const url = new URL("https://open.tiktokapis.com/v2/video/list/");
    url.searchParams.set("fields", "id,title,video_description,share_url,cover_image_url,create_time");
    const body: Record<string, number> = { max_count: options.maxCount ?? 20 };
    if (options.cursor !== undefined) {
      body.cursor = options.cursor;
    }
    const json = await this.requestJson(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = asRecord(asRecord(json).data);
    const videos = data.videos;
    if (!Array.isArray(videos)) {
      return {
        videos: [],
        cursor: readOptionalNumber(data, "cursor"),
        hasMore: readOptionalBoolean(data, "has_more") ?? false,
      };
    }

    return {
      videos: videos.map((entry) => {
        const record = asRecord(entry);
        return {
          id: readString(record, "id"),
          title: readOptionalString(record, "title"),
          videoDescription: readOptionalString(record, "video_description"),
          shareUrl: readOptionalString(record, "share_url"),
          coverImageUrl: readOptionalString(record, "cover_image_url"),
          createTime: readOptionalNumber(record, "create_time"),
        };
      }),
      cursor: readOptionalNumber(data, "cursor"),
      hasMore: readOptionalBoolean(data, "has_more") ?? false,
    };
  }

  private async postToken(values: Record<string, string>): Promise<TikTokTokenResponse> {
    const json = await this.requestJson("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
    });
    const record = asRecord(json);
    return {
      openId: readString(record, "open_id"),
      scopes: readString(record, "scope").split(",").filter(Boolean),
      accessToken: readString(record, "access_token"),
      expiresIn: readNumber(record, "expires_in"),
      refreshToken: readString(record, "refresh_token"),
      refreshExpiresIn: readNumber(record, "refresh_expires_in"),
    };
  }

  private async requestJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, { ...init, signal: controller.signal });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error: TikTokErrorResponse = asRecord(json);
        throw new Error(error.error_description ?? error.message ?? error.error ?? `TikTok HTTP ${response.status}`);
      }
      return json;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Respuesta TikTok sin ${key}.`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new Error(`Respuesta TikTok sin ${key}.`);
  }
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}
