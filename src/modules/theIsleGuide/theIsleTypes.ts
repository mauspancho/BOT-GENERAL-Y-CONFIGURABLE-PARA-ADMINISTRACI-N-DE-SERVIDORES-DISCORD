export const dinosaurTypes = ["carnivore", "herbivore", "omnivore"] as const;

export type DinosaurType = (typeof dinosaurTypes)[number];

export interface TheIsleGuideData {
  gameVersion: string;
  updatedAt: string;
  sources?: string;
  species: DinosaurSpecies[];
}

export interface DinosaurSpecies {
  id: string;
  name: string;
  type: DinosaurType;
  enabled: boolean;
  recommendedMutations: string[];
  alternatives: string[];
  description: string;
  notes: string;
}
