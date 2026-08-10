import type { GuildMember } from "discord.js";

export function renderTemplate(
  template: string,
  values: {
    user: string;
    username: string;
    server: string;
    memberCount: number;
  },
): string {
  return template
    .replaceAll("{user}", values.user)
    .replaceAll("{username}", values.username)
    .replaceAll("{server}", values.server)
    .replaceAll("{memberCount}", String(values.memberCount));
}

export function renderMemberTemplate(template: string, member: GuildMember): string {
  return renderTemplate(template, {
    user: `<@${member.id}>`,
    username: member.user.username,
    server: member.guild.name,
    memberCount: member.guild.memberCount,
  });
}
