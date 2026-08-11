import type { StringSelectMenuInteraction } from "discord.js";
import type { ServerConfig } from "../../core/config/schema.js";
import { isTheIsleGuideEnabled, loadConfiguredTheIsleGuideFile } from "./theIsleGuideConfig.js";
import {
  THE_ISLE_SPECIES_SELECT_PREFIX,
  THE_ISLE_TYPE_SELECT_ID,
  buildSpeciesEmbed,
  buildSpeciesSelectRows,
} from "./theIsleUi.js";
import type { DinosaurType } from "./theIsleTypes.js";

export async function handleTheIsleSelect(
  interaction: StringSelectMenuInteraction,
  config: ServerConfig,
): Promise<boolean> {
  if (!isTheIsleGuideEnabled(config)) {
    return false;
  }

  if (interaction.customId === THE_ISLE_TYPE_SELECT_ID) {
    const selectedType = interaction.values[0] as DinosaurType | undefined;
    if (!selectedType) {
      await interaction.reply({ content: "Seleccion invalida.", ephemeral: true });
      return true;
    }

    const data = loadConfiguredTheIsleGuideFile(config);
    const rows = buildSpeciesSelectRows(data, selectedType);
    await interaction.reply({
      content: rows.length > 0 ? "Selecciona una especie:" : "No hay especies activas para esta categoria.",
      components: rows,
      ephemeral: true,
    });
    return true;
  }

  if (interaction.customId.startsWith(THE_ISLE_SPECIES_SELECT_PREFIX)) {
    const speciesId = interaction.values[0];
    const data = loadConfiguredTheIsleGuideFile(config);
    const species = data.species.find((entry) => entry.enabled && entry.id === speciesId);
    if (!species) {
      await interaction.reply({ content: "La especie seleccionada ya no esta disponible.", ephemeral: true });
      return true;
    }

    await interaction.reply({ embeds: [buildSpeciesEmbed(data, species)], ephemeral: true });
    return true;
  }

  return false;
}
