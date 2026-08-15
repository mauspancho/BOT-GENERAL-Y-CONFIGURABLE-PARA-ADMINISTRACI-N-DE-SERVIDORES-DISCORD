import crypto from "node:crypto";
import type { TikTokVideo } from "./tiktokTypes.js";

export interface TikTokRepublishSession {
  id: string;
  guildId: string;
  discordUserId: string;
  videoIds: string[];
  expiresAt: number;
}

const ttlMs = 10 * 60 * 1000;
const sessions = new Map<string, TikTokRepublishSession>();

export function createTikTokRepublishSession(values: {
  guildId: string;
  discordUserId: string;
  videos: TikTokVideo[];
  now?: Date;
}): TikTokRepublishSession {
  cleanupTikTokRepublishSessions(values.now);
  const id = crypto.randomBytes(12).toString("base64url");
  const session: TikTokRepublishSession = {
    id,
    guildId: values.guildId,
    discordUserId: values.discordUserId,
    videoIds: values.videos.map((video) => video.id),
    expiresAt: (values.now ?? new Date()).getTime() + ttlMs,
  };
  sessions.set(id, session);
  return session;
}

export function getTikTokRepublishSession(id: string, now = new Date()): TikTokRepublishSession | undefined {
  const session = sessions.get(id);
  if (!session) {
    return undefined;
  }
  if (session.expiresAt <= now.getTime()) {
    sessions.delete(id);
    return undefined;
  }
  return session;
}

export function deleteTikTokRepublishSession(id: string): void {
  sessions.delete(id);
}

export function cleanupTikTokRepublishSessions(now = new Date()): void {
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now.getTime()) {
      sessions.delete(id);
    }
  }
}
