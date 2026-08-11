import { describe, expect, it } from "vitest";
import { parseTheIsleGuideMarkdown, enabledSpecies } from "../src/modules/theIsleGuide/theIsleParser.js";
import { buildSpeciesEmbed, buildSpeciesSelectRows } from "../src/modules/theIsleGuide/theIsleUi.js";
import { theIsleGuideModule } from "../src/modules/theIsleGuide/theIsleGuideModule.js";
import { createDefaultModules, type ServerConfig } from "../src/core/config/schema.js";

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
});

function header(): string {
  return "# The Isle Evrima - Guia\n\nversion: 0.21.772\nupdated: 2026-08-10\n\n";
}

function sampleMarkdown(name: string): string {
  return `${header()}## ${name}\n\ntype: carnivore\nenabled: true\n\n### Build recomendada\n\n- Mutation A\n- Mutation B\n\n### Descripcion\n\nBuild de prueba.\n\n### Alternativas\n\n- Alternative A\n\n### Notas\n\nNota de prueba.\n`;
}

function makeConfig(enabled: boolean): ServerConfig {
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
  };
}
