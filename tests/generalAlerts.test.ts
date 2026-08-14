import fs from "node:fs";
import path from "node:path";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { alertCommand } from "../src/commands/alert.js";
import { enabledCommands } from "../src/commands/index.js";
import { createDefaultModules, type ServerConfig } from "../src/core/config/schema.js";
import { preflightStructurePlan } from "../src/installer/discord/setupDiscord.js";
import { createQuickInstallConfig } from "../src/installer/wizard/configFactory.js";
import { enabledModules } from "../src/modules/index.js";
import { sendGeneralAlert } from "../src/services/generalAlertService.js";
import { makeGuildMock } from "./support/discordMocks.js";

interface AlertSendPayload {
  content?: string;
  embeds?: unknown[];
  allowedMentions?: {
    parse: string[];
    users: string[];
    roles: string[];
    repliedUser?: boolean;
  };
}

interface ReplyPayload {
  content: string;
  ephemeral: boolean;
}

interface MockClient {
  generalSend: ReturnType<typeof vi.fn<(payload: AlertSendPayload) => Promise<void>>>;
  logSend: ReturnType<typeof vi.fn<(payload: AlertSendPayload) => Promise<void>>>;
  channels: {
    fetch: ReturnType<typeof vi.fn<(id: string) => Promise<MockTextChannel | null>>>;
  };
}

interface MockTextChannel {
  id: string;
  name: string;
  type: ChannelType.GuildText;
  send: (payload: AlertSendPayload) => Promise<void>;
}

interface MockInteraction extends MockClient {
  client: MockClient;
  commandName: string;
  inGuild: () => boolean;
  memberPermissions: { has: (permission: bigint) => boolean };
  user: { id: string };
  options: {
    getSubcommand: () => string;
    getString: (name: string, required?: boolean) => string | null;
  };
  reply: ReturnType<typeof vi.fn<(payload: ReplyPayload) => Promise<void>>>;
}

describe("general alerts", () => {
  it("registers /alerta when the module is enabled", () => {
    expect(enabledCommands(makeConfig(true)).map((command) => command.name)).toContain("alerta");
    expect(enabledModules(makeConfig(true)).map((module) => module.name)).toContain("generalAlerts");
  });

  it("does not register /alerta when the module is disabled", () => {
    expect(enabledCommands(makeConfig(false)).map((command) => command.name)).not.toContain("alerta");
  });

  it("sets Discord default permissions to Administrator and disables DMs", () => {
    const json = alertCommand.data(makeConfig(true));

    expect(json.default_member_permissions).toBe(PermissionFlagsBits.Administrator.toString());
    expect(json.dm_permission).toBe(false);
  });

  it("rejects a normal user", async () => {
    const interaction = makeInteraction({ isAdministrator: false });

    await alertCommand.execute(interaction as never, { config: makeConfig(true), database: {} as never });

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Este comando requiere permiso de Administrador.",
      ephemeral: true,
    });
    expect(interaction.client.channels.fetch).not.toHaveBeenCalled();
  });

  it("rejects ManageGuild without Administrator", async () => {
    const interaction = makeInteraction({
      hasPermission: (permission) => permission === PermissionFlagsBits.ManageGuild,
    });

    await alertCommand.execute(interaction as never, { config: makeConfig(true), database: {} as never });

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Este comando requiere permiso de Administrador.",
      ephemeral: true,
    });
    expect(interaction.client.channels.fetch).not.toHaveBeenCalled();
  });

  it("allows Administrator to send an alert", async () => {
    const interaction = makeInteraction({ isAdministrator: true });

    await alertCommand.execute(interaction as never, { config: makeConfig(true), database: {} as never });

    expect(interaction.generalSend).toHaveBeenCalledOnce();
    const reply = firstReplyPayload(interaction);
    expect(reply.content).toContain("Alerta enviada correctamente a #general.");
    expect(reply.ephemeral).toBe(true);
  });

  it("uses config.channels.general.id", async () => {
    const client = makeClient();
    await sendGeneralAlert(client as never, makeConfig(true), { message: "Hola" });

    expect(client.channels.fetch).toHaveBeenCalledWith("general-id");
  });

  it("does not use GENERAL_CHAT_CHANNEL_ID", () => {
    const sourceFiles = ["src/services/generalAlertService.ts", "src/commands/alert.ts"];

    for (const sourceFile of sourceFiles) {
      expect(fs.readFileSync(path.resolve(process.cwd(), sourceFile), "utf8")).not.toContain(
        "GENERAL_CHAT_CHANNEL_ID",
      );
    }
  });

  it("returns a controlled error when the configured channel no longer exists", async () => {
    const client = makeClient({ missingGeneral: true });

    await expect(sendGeneralAlert(client as never, makeConfig(true), { message: "Hola" })).rejects.toThrow(
      /canal general configurado ya no existe/i,
    );
  });

  it("rejects an empty message", async () => {
    await expect(sendGeneralAlert(makeClient() as never, makeConfig(true), { message: "   " })).rejects.toThrow(
      /no puede estar vacio/i,
    );
  });

  it("sends a normal alert without mention", async () => {
    const client = makeClient();

    await sendGeneralAlert(client as never, makeConfig(true), { message: "Servidor activo" });

    const payload = firstAlertPayload(client);
    expect(payload.content).toBeUndefined();
    expect(payload.allowedMentions).toMatchObject({ parse: [] });
  });

  it("mentions everyone only when explicitly selected", async () => {
    const client = makeClient();

    await sendGeneralAlert(client as never, makeConfig(true), {
      message: "Reinicio en 10 minutos",
      mention: "everyone",
    });

    const payload = firstAlertPayload(client);
    expect(payload.content).toBe("@everyone");
    expect(payload.allowedMentions).toMatchObject({ parse: ["everyone"], users: [], roles: [] });
  });

  it("mentions here only when explicitly selected", async () => {
    const client = makeClient();

    await sendGeneralAlert(client as never, makeConfig(true), {
      message: "Prueba de alerta",
      mention: "here",
    });

    const payload = firstAlertPayload(client);
    expect(payload.content).toBe("@here");
    expect(payload.allowedMentions).toMatchObject({ parse: ["everyone"], users: [], roles: [] });
  });

  it("prevents arbitrary mentions from the admin text", async () => {
    const client = makeClient();

    await sendGeneralAlert(client as never, makeConfig(true), {
      message: "Hola @everyone <@123> <@&456>",
      mention: "ninguna",
    });

    const payload = firstAlertPayload(client);
    expect(payload.content).toBeUndefined();
    expect(payload.allowedMentions).toMatchObject({ parse: [], users: [], roles: [] });
  });

  it("sends an ephemeral confirmation", async () => {
    const interaction = makeInteraction({ isAdministrator: true });

    await alertCommand.execute(interaction as never, { config: makeConfig(true), database: {} as never });

    expect(firstReplyPayload(interaction).ephemeral).toBe(true);
  });

  it("logs the event in the logs channel", async () => {
    const client = makeClient();

    await sendGeneralAlert(client as never, makeConfig(true), {
      message: "Mantenimiento",
      type: "mantenimiento",
      mention: "everyone",
      source: "<@admin>",
    });

    const logPayload = client.logSend.mock.calls[0]?.[0];
    expect(JSON.stringify(logPayload)).toContain("[ALERTA GENERAL]");
  });

  it("does not create an additional channel when enabled", () => {
    const enabledModules = minimalModules();
    enabledModules.generalAlerts = true;
    const disabledModules = minimalModules();
    disabledModules.generalAlerts = false;

    const enabledConfig = createQuickInstallConfig("guild", "Comunidad", enabledModules, promptValues);
    const disabledConfig = createQuickInstallConfig("guild", "Comunidad", disabledModules, promptValues);

    expect(Object.keys(enabledConfig.channels).sort()).toEqual(Object.keys(disabledConfig.channels).sort());
    expect(Object.keys(enabledConfig.channels).sort()).toEqual(["general"]);
  });

  it("setup config can enable and disable generalAlerts", () => {
    const enabledModules = minimalModules();
    enabledModules.generalAlerts = true;
    const disabledModules = minimalModules();
    disabledModules.generalAlerts = false;

    expect(createQuickInstallConfig("guild", "Comunidad", enabledModules, promptValues).modules.generalAlerts).toBe(true);
    expect(createQuickInstallConfig("guild", "Comunidad", disabledModules, promptValues).modules.generalAlerts).toBe(false);
  });

  it("preflight requires the logical general channel when generalAlerts is enabled", () => {
    const config = makeConfig(true);
    delete config.channels.general;

    const result = preflightStructurePlan(makeGuildMock({ features: [] }), config);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("modulo generalAlerts");
  });
});

const promptValues = {
  informationCategory: "INFORMACION",
  communityCategory: "COMUNIDAD",
  administrationCategory: "ADMINISTRACION",
  welcomeChannel: "bienvenida",
  rulesChannel: "reglas",
  announcementsChannel: "anuncios",
  selfRolesChannel: "roles",
  generalChannel: "general",
  logsChannel: "logs",
  theIsleGuideChannel: "mutaciones",
  theIsleGuideSourcePath: "./data/the-isle/dinosaurs.md",
  pendingRole: "Sin verificar",
  memberRole: "Miembro",
};

function makeConfig(generalAlerts: boolean): ServerConfig {
  const modules = minimalModules();
  modules.generalAlerts = generalAlerts;
  modules.logs = true;

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
  };
}

function minimalModules(): ServerConfig["modules"] {
  const modules = createDefaultModules();
  modules.welcome = false;
  modules.rules = false;
  modules.selfRoles = false;
  modules.announcements = false;
  modules.tickets = false;
  modules.suggestions = false;
  modules.moderation = false;
  modules.logs = false;
  modules.theIsleGuide = false;
  return modules;
}

function makeClient(options: { missingGeneral?: boolean } = {}): MockClient {
  const generalSend = vi.fn((payload: AlertSendPayload) => {
    void payload;
    return Promise.resolve();
  });
  const logSend = vi.fn((payload: AlertSendPayload) => {
    void payload;
    return Promise.resolve();
  });
  const channels = new Map<string, MockTextChannel | null>([
    [
      "general-id",
      options.missingGeneral
        ? null
        : {
            id: "general-id",
            name: "general",
            type: ChannelType.GuildText,
            send: generalSend,
          },
    ],
    [
      "logs-id",
      {
        id: "logs-id",
        name: "logs",
        type: ChannelType.GuildText,
        send: logSend,
      },
    ],
  ]);

  return {
    generalSend,
    logSend,
    channels: {
      fetch: vi.fn((id: string) => Promise.resolve(channels.get(id) ?? null)),
    },
  };
}

function makeInteraction(options: {
  isAdministrator?: boolean;
  hasPermission?: (permission: bigint) => boolean;
}): MockInteraction {
  const client = makeClient();
  const reply = vi.fn((payload: ReplyPayload) => {
    void payload;
    return Promise.resolve();
  });
  const hasPermission =
    options.hasPermission ??
    ((permission: bigint) => Boolean(options.isAdministrator) && permission === PermissionFlagsBits.Administrator);

  return {
    ...client,
    client,
    commandName: "alerta",
    inGuild: () => true,
    memberPermissions: { has: hasPermission },
    user: { id: "admin-id" },
    options: {
      getSubcommand: () => "enviar",
      getString: (name: string, required?: boolean) => {
        if (name === "mensaje") {
          return "El servidor se reiniciara en 10 minutos";
        }
        if (required) {
          throw new Error(`Missing required option: ${name}`);
        }
        return null;
      },
    },
    reply,
  };
}

function firstAlertPayload(client: MockClient): AlertSendPayload {
  const payload = client.generalSend.mock.calls[0]?.[0];
  if (!payload) {
    throw new Error("No alert payload was sent.");
  }
  return payload;
}

function firstReplyPayload(interaction: MockInteraction): ReplyPayload {
  const payload = interaction.reply.mock.calls[0]?.[0];
  if (!payload) {
    throw new Error("No reply payload was sent.");
  }
  return payload;
}
