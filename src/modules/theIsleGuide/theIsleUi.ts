import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type APIEmbed,
} from "discord.js";
import type { DinosaurSpecies, DinosaurType, TheIsleGuideData } from "./theIsleTypes.js";

export const THE_ISLE_PANEL_TYPE = "theIsleGuide";
export const THE_ISLE_TYPE_SELECT_ID = "the-isle:v1:type";
export const THE_ISLE_SPECIES_SELECT_PREFIX = "the-isle:v1:species";

const typeLabels: Record<DinosaurType, string> = {
  carnivore: "Carnivoros",
  herbivore: "Herbivoros",
  omnivore: "Omnivoros",
};

export function buildTheIslePanelPayload() {
  const embed = new EmbedBuilder()
    .setTitle("THE ISLE EVRIMA")
    .setDescription("Guia de especies y mutaciones\n\nSelecciona una categoria para consultar especies.");

  const select = new StringSelectMenuBuilder()
    .setCustomId(THE_ISLE_TYPE_SELECT_ID)
    .setPlaceholder("Selecciona un tipo")
    .addOptions(
      { label: typeLabels.carnivore, value: "carnivore" },
      { label: typeLabels.herbivore, value: "herbivore" },
      { label: typeLabels.omnivore, value: "omnivore" },
    );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  };
}

export function buildSpeciesSelectRows(data: TheIsleGuideData, type: DinosaurType) {
  const species = data.species.filter((entry) => entry.enabled && entry.type === type);
  if (species.length === 0) {
    return [];
  }

  return chunk(species, 25)
    .slice(0, 5)
    .map((page, index) => {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`${THE_ISLE_SPECIES_SELECT_PREFIX}:${type}:${index}`)
        .setPlaceholder(index === 0 ? "Selecciona una especie" : `Selecciona una especie (${index + 1})`)
        .addOptions(page.map((entry) => ({ label: entry.name, value: entry.id })));

      return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    });
}

export function buildSpeciesEmbed(data: TheIsleGuideData, species: DinosaurSpecies): APIEmbed {
  const embed = new EmbedBuilder()
    .setTitle(species.name)
    .addFields(
      { name: "Tipo", value: typeLabels[species.type], inline: true },
      {
        name: "Mutaciones recomendadas",
        value: species.recommendedMutations.map((mutation, index) => `${index + 1}. ${mutation}`).join("\n"),
      },
      { name: "Enfoque", value: species.description || "Sin descripcion." },
      {
        name: "Alternativas",
        value: species.alternatives.length > 0 ? species.alternatives.map((item) => `- ${item}`).join("\n") : "Sin alternativas.",
      },
      {
        name: "Datos",
        value: `Evrima ${data.gameVersion}\nActualizado: ${data.updatedAt}`,
      },
    )
    .setFooter({ text: "Las builds son recomendaciones de la comunidad y pueden cambiar entre parches." });

  if (species.notes) {
    embed.addFields({ name: "Notas", value: species.notes });
  }

  return embed.toJSON();
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
