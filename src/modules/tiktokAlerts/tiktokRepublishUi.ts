import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import {
  TIKTOK_REPUBLISH_NEXT_PREFIX,
  TIKTOK_REPUBLISH_PREVIOUS_PREFIX,
  TIKTOK_REPUBLISH_SELECT_PREFIX,
} from "./tiktokCustomIds.js";
import type { TikTokRepublishPage, TikTokRepublishSession } from "./tiktokRepublishState.js";
import type { TikTokVideo } from "./tiktokTypes.js";

export function buildTikTokRepublishMessage(
  session: TikTokRepublishSession,
  page: TikTokRepublishPage,
): {
  content: string;
  components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>>;
} {
  const pageNumber = session.currentPageIndex + 1;
  const content = `Selecciona el video que deseas republicar de ${session.displayName}. Pagina ${pageNumber}.`;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${TIKTOK_REPUBLISH_SELECT_PREFIX}${session.id}`)
    .setPlaceholder(`Videos de ${session.displayName}`)
    .addOptions(page.videos.slice(0, 20).map(toRepublishOption));
  const menuRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  const navigationRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TIKTOK_REPUBLISH_PREVIOUS_PREFIX}${session.id}`)
      .setLabel("Anterior")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(session.currentPageIndex === 0),
    new ButtonBuilder()
      .setCustomId(`${TIKTOK_REPUBLISH_NEXT_PREFIX}${session.id}`)
      .setLabel("Siguiente")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!page.hasMore && session.currentPageIndex >= session.pages.length - 1),
  );
  return { content, components: [menuRow, navigationRow] };
}

function toRepublishOption(video: TikTokVideo): { label: string; description: string; value: string } {
  const text = video.title ?? video.videoDescription ?? "Video TikTok";
  const date = video.createTime ? new Date(video.createTime * 1000).toLocaleDateString("es-MX") : "sin fecha";
  return {
    label: trimDiscordOption(text, 100),
    description: trimDiscordOption(`${date} - ID ${maskVideoId(video.id)}`, 100),
    value: video.id,
  };
}

function trimDiscordOption(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function maskVideoId(videoId: string): string {
  return videoId.length <= 8 ? videoId : `${videoId.slice(0, 4)}...${videoId.slice(-4)}`;
}
