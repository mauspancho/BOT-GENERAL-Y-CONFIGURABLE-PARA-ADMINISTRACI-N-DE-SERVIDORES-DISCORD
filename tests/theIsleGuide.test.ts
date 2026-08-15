import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTheIsleGuideMarkdown, enabledSpecies } from "../src/modules/theIsleGuide/theIsleParser.js";
import { buildSpeciesEmbed, buildSpeciesSelectRows } from "../src/modules/theIsleGuide/theIsleUi.js";
import { THE_ISLE_TYPE_SELECT_ID } from "../src/modules/theIsleGuide/theIsleUi.js";
import { theIsleGuideModule } from "../src/modules/theIsleGuide/theIsleGuideModule.js";
import { createDefaultModules, type ServerConfig } from "../src/core/config/schema.js";
import {
  createTheIsleGuideConfig,
  LEGACY_THE_ISLE_GUIDE_SOURCE_PATH,
  getTheIsleGuideSourcePath,
  loadConfiguredTheIsleGuideFile,
  resolveTheIsleGuidePath,
  validateTheIsleGuideSourcePath,
} from "../src/modules/theIsleGuide/theIsleGuideConfig.js";
import { readServerConfig, writeServerConfig } from "../src/core/config/configStore.js";
import { handleTheIsleSelect } from "../src/modules/theIsleGuide/theIsleInteractionService.js";
import { guideCommand } from "../src/commands/guide.js";
import { createBackup } from "../src/installer/backup/backupService.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanupPath of cleanupPaths.splice(0)) {
    fs.rmSync(cleanupPath, { recursive: true, force: true });
  }
});

describe("The Isle guide", () => {
  it("parses one species with build and alternatives", () => {
    const data = parseTheIsleGuideMarkdown(sampleMarkdown("Carnotaurus"));

    expect(data.gameVersion).toBe("0.21.772");
    expect(data.species[0]).toMatchObject({
      id: "carnotaurus",
      name: "Carnotaurus",
      type: "carnivore",
      enabled: true,
      recommendedMutations: ["Mutation A", "Mutation B"],
      alternatives: ["Alternative A"],
    });
  });

  it("parses multiple species and ignores disabled in enabledSpecies", () => {
    const data = parseTheIsleGuideMarkdown(`${sampleMarkdown("Carnotaurus")}\n## Dryosaurus\n\ntype: herbivore\nenabled: false\n\n### Build recomendada\n\n- Mutation C\n`);

    expect(data.species).toHaveLength(2);
    expect(enabledSpecies(data)).toHaveLength(1);
  });

  it("rejects duplicate species IDs", () => {
    expect(() =>
      parseTheIsleGuideMarkdown(`${sampleMarkdown("Carnotaurus")}\n## Carnotaurus\n\ntype: carnivore\nenabled: true\n\n### Build recomendada\n\n- Mutation C\n`),
    ).toThrow(/duplicado/i);
  });

  it("does not generate more than 25 species options", () => {
    const species = Array.from({ length: 30 }, (_, index) => `## Species ${index}\n\ntype: carnivore\nenabled: true\n\n### Build recomendada\n\n- Mutation\n`).join("\n");
    const data = parseTheIsleGuideMarkdown(header() + species);

    const rows = buildSpeciesSelectRows(data, "carnivore");
    const json = rows[0]?.toJSON();

    expect(json?.components[0]?.options).toHaveLength(25);
    expect(rows[1]?.toJSON().components[0]?.options).toHaveLength(5);
  });

  it("selection embed returns species data", () => {
    const data = parseTheIsleGuideMarkdown(sampleMarkdown("Carnotaurus"));
    const embed = buildSpeciesEmbed(data, data.species[0]!);

    expect(embed.title).toBe("Carnotaurus");
    expect(JSON.stringify(embed)).toContain("Mutation A");
    expect(JSON.stringify(embed)).toContain("Evrima 0.21.772");
  });

  it("markdown changes do not require code changes", () => {
    const data = parseTheIsleGuideMarkdown(sampleMarkdown("NuevaEspecie"));

    expect(data.species[0]?.id).toBe("nuevaespecie");
  });

  it("disabled module does not start panel work", () => {
    const config = makeConfig(false);

    expect(theIsleGuideModule.enabled(config)).toBe(false);
  });

  it("malformed markdown produces a clear error", () => {
    expect(() => parseTheIsleGuideMarkdown("# Missing metadata")).toThrow(/version/i);
  });

  it("accepts a valid absolute source path", () => {
    const filePath = writeTempGuide(sampleMarkdown("Carnotaurus"));
    const summary = validateTheIsleGuideSourcePath(filePath);

    expect(summary.resolvedPath).toBe(filePath);
    expect(summary.totalSpecies).toBe(1);
    expect(summary.countsByType.carnivore).toBe(1);
  });

  it("accepts a valid relative source path resolved from the project root", () => {
    const relativePath = writeRelativeGuide("tmp-the-isle-relative.md", sampleMarkdown("Dryosaurus", "herbivore"));
    const config = makeConfig(true, relativePath);

    expect(resolveTheIsleGuidePath(config)).toBe(path.resolve(process.cwd(), relativePath));
    expect(loadConfiguredTheIsleGuideFile(config).species[0]?.name).toBe("Dryosaurus");
  });

  it("rejects a missing source file", () => {
    expect(() => validateTheIsleGuideSourcePath(path.join(os.tmpdir(), "missing-the-isle.md"))).toThrow(/No existe/i);
  });

  it("rejects a file without read permission when the OS reports it", () => {
    const filePath = writeTempGuide(sampleMarkdown("Carnotaurus"));
    vi.spyOn(fs, "accessSync").mockImplementationOnce(() => {
      throw new Error("EACCES");
    });

    expect(() => validateTheIsleGuideSourcePath(filePath)).toThrow(/EACCES/i);
  });

  it("rejects invalid markdown at setup validation time", () => {
    const filePath = writeTempGuide("# The Isle\n\nversion: 0.21.772\n");

    expect(() => validateTheIsleGuideSourcePath(filePath)).toThrow(/updated/i);
  });

  it("writes sourcePath to server.json", () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, "server.json");
    const sourcePath = writeTempGuide(sampleMarkdown("Carnotaurus"));
    const config = makeConfig(true, sourcePath);

    writeServerConfig(configPath, config);
    const loaded = readServerConfig(configPath);

    expect(loaded.theIsleGuide.sourcePath).toBe(sourcePath);
  });

  it("interaction service reads the configured sourcePath", async () => {
    const sourcePath = writeTempGuide(sampleMarkdown("Dryosaurus", "herbivore"));
    const config = makeConfig(true, sourcePath);
    const reply = vi.fn();
    const interaction = {
      customId: THE_ISLE_TYPE_SELECT_ID,
      values: ["herbivore"],
      reply,
    };

    await handleTheIsleSelect(interaction as never, config);

    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain("Dryosaurus");
  });

  it("/guide reload reads the configured sourcePath and reports the loaded version", async () => {
    const sourcePath = writeTempGuide(sampleMarkdown("Carnotaurus", "carnivore", "0.21.773"));
    const config = makeConfig(true, sourcePath);
    const editReply = vi.fn();
    const interaction = {
      memberPermissions: { has: () => true },
      deferReply: vi.fn(),
      editReply,
      client: {},
    };

    await guideCommand.execute(interaction as never, { config, database: {} as never });

    expect(editReply.mock.calls[0]?.[0]).toContain(sourcePath);
    expect(editReply.mock.calls[0]?.[0]).toContain("0.21.773");
  });

  it("builds a changed sourcePath for modify configuration flows", () => {
    const modules = createDefaultModules();
    modules.theIsleGuide = true;
    const sourcePath = writeTempGuide(sampleMarkdown("Carnotaurus"));

    expect(createTheIsleGuideConfig(modules, sourcePath)).toEqual({
      enabled: true,
      sourcePath,
    });
  });

  it("keeps old configs working through the compatibility sourcePath fallback", () => {
    const config = makeConfig(true);

    expect(getTheIsleGuideSourcePath(config)).toBe(LEGACY_THE_ISLE_GUIDE_SOURCE_PATH);
  });

  it("does not require sourcePath when the module is disabled", () => {
    const modules = createDefaultModules();
    modules.theIsleGuide = false;

    expect(createTheIsleGuideConfig(modules)).toEqual({ enabled: false });
  });

  it("requires sourcePath for a new enabled setup config", () => {
    const modules = createDefaultModules();
    modules.theIsleGuide = true;

    expect(() => createTheIsleGuideConfig(modules)).toThrow(/sourcePath/i);
  });

  it("does not let runtime services depend on the legacy bundled source path", () => {
    const runtimeFiles = [
      "src/modules/theIsleGuide/theIsleInteractionService.ts",
      "src/modules/theIsleGuide/theIsleGuideModule.ts",
      "src/commands/guide.ts",
      "src/modules/theIsleGuide/theIslePanelService.ts",
    ];

    for (const runtimeFile of runtimeFiles) {
      expect(fs.readFileSync(path.resolve(process.cwd(), runtimeFile), "utf8")).not.toContain(
        LEGACY_THE_ISLE_GUIDE_SOURCE_PATH,
      );
    }
  });

  it("external file changes are visible after /guide reload", async () => {
    const sourcePath = writeTempGuide(sampleMarkdown("Carnotaurus", "carnivore", "0.21.772"));
    fs.writeFileSync(sourcePath, sampleMarkdown("Carnotaurus", "carnivore", "0.21.774"), "utf8");
    const editReply = vi.fn();

    await guideCommand.execute(
      {
        memberPermissions: { has: () => true },
        deferReply: vi.fn(),
        editReply,
        client: {},
      } as never,
      { config: makeConfig(true, sourcePath), database: {} as never },
    );

    expect(editReply.mock.calls[0]?.[0]).toContain("0.21.774");
  });

  it("backup keeps server config but does not copy external The Isle files", () => {
    const tempRoot = makeTempDir();
    const externalDir = makeTempDir();
    const externalFile = path.join(externalDir, "dinosaurs.md");
    fs.writeFileSync(externalFile, sampleMarkdown("Carnotaurus"), "utf8");
    fs.mkdirSync(path.join(tempRoot, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, "config", "server.json"),
      JSON.stringify(makeConfig(true, externalFile), null, 2),
      "utf8",
    );
    vi.stubEnv("CONFIG_PATH", path.join(tempRoot, "config", "server.json"));
    vi.stubEnv("DATABASE_PATH", path.join(tempRoot, "data", "bot.sqlite"));
    vi.stubEnv("BACKUPS_PATH", path.join(tempRoot, "backups"));

    const backup = createBackup("test");
    cleanupPaths.push(backup.path);

    expect(backup.included).toContain("config/");
    expect(backup.included).not.toContain("data/the-isle/");
  });
});

function header(): string {
  return "# The Isle Evrima - Guia\n\nversion: 0.21.772\nupdated: 2026-08-10\n\n";
}

function sampleMarkdown(name: string, type = "carnivore", version = "0.21.772"): string {
  return `${header().replace("0.21.772", version)}## ${name}\n\ntype: ${type}\nenabled: true\n\n### Build recomendada\n\n- Mutation A\n- Mutation B\n\n### Descripcion\n\nBuild de prueba.\n\n### Alternativas\n\n- Alternative A\n\n### Notas\n\nNota de prueba.\n`;
}

function makeConfig(enabled: boolean, sourcePath?: string): ServerConfig {
  const modules = createDefaultModules();
  modules.theIsleGuide = enabled;
  return {
    version: 1,
    guildId: "guild",
    communityName: "Comunidad",
    locale: "es",
    categories: {},
    channels: {},
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
    theIsleGuide: sourcePath
      ? {
          enabled,
          sourcePath,
        }
      : {
          enabled,
        },
    tiktokAlerts: {
      enabled: false,
      pollingIntervalSeconds: 300,
      mention: "ninguna",
    },
  };
}

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "the-isle-guide-"));
  cleanupPaths.push(tempDir);
  return tempDir;
}

function writeTempGuide(markdown: string): string {
  const tempDir = makeTempDir();
  const filePath = path.join(tempDir, "dinosaurs.md");
  fs.writeFileSync(filePath, markdown, "utf8");
  return filePath;
}

function writeRelativeGuide(relativePath: string, markdown: string): string {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, markdown, "utf8");
  cleanupPaths.push(absolutePath);
  return relativePath;
}
