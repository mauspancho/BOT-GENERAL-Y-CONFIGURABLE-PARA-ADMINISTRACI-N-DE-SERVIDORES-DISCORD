import crypto from "node:crypto";
import type { TikTokVideo, TikTokVideoPage } from "./tiktokTypes.js";

export interface TikTokRepublishPage {
  videos: TikTokVideo[];
  cursor?: number | undefined;
  hasMore: boolean;
}

export interface TikTokRepublishSession {
  id: string;
  guildId: string;
  discordUserId: string;
  openId: string;
  displayName: string;
  pages: TikTokRepublishPage[];
  currentPageIndex: number;
  expiresAt: number;
}

const ttlMs = 10 * 60 * 1000;
const sessions = new Map<string, TikTokRepublishSession>();

export function createTikTokRepublishSession(values: {
  guildId: string;
  discordUserId: string;
  openId?: string | undefined;
  displayName?: string | undefined;
  videos?: TikTokVideo[] | undefined;
  page?: TikTokVideoPage | undefined;
  now?: Date;
}): TikTokRepublishSession {
  cleanupTikTokRepublishSessions(values.now);
  const id = crypto.randomBytes(12).toString("base64url");
  const session: TikTokRepublishSession = {
    id,
    guildId: values.guildId,
    discordUserId: values.discordUserId,
    openId: values.openId ?? "open-id",
    displayName: values.displayName ?? "TikTok",
    pages: [toRepublishPage(values.page ?? { videos: values.videos ?? [], hasMore: false })],
    currentPageIndex: 0,
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

export function getCurrentTikTokRepublishPage(session: TikTokRepublishSession): TikTokRepublishPage {
  return session.pages[session.currentPageIndex] ?? { videos: [], hasMore: false };
}

export function getCurrentTikTokRepublishVideoIds(session: TikTokRepublishSession): string[] {
  return getCurrentTikTokRepublishPage(session).videos.map((video) => video.id);
}

export function findCurrentTikTokRepublishVideo(session: TikTokRepublishSession, videoId: string): TikTokVideo | undefined {
  return getCurrentTikTokRepublishPage(session).videos.find((video) => video.id === videoId);
}

export function appendTikTokRepublishPage(session: TikTokRepublishSession, page: TikTokVideoPage): TikTokRepublishPage {
  const nextPage = toRepublishPage(page);
  session.pages = [...session.pages.slice(0, session.currentPageIndex + 1), nextPage];
  session.currentPageIndex += 1;
  return nextPage;
}

export function moveTikTokRepublishPage(session: TikTokRepublishSession, direction: "next" | "previous"): TikTokRepublishPage {
  if (direction === "next" && session.currentPageIndex < session.pages.length - 1) {
    session.currentPageIndex += 1;
  }
  if (direction === "previous" && session.currentPageIndex > 0) {
    session.currentPageIndex -= 1;
  }
  return getCurrentTikTokRepublishPage(session);
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

function toRepublishPage(page: TikTokVideoPage): TikTokRepublishPage {
  return {
    videos: page.videos,
    cursor: page.cursor,
    hasMore: page.hasMore,
  };
}
