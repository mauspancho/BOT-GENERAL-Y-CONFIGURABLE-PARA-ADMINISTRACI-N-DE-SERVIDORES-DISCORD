import { describe, expect, it } from "vitest";
import { hashRules, splitDiscordText } from "../src/services/rulesContentService.js";

describe("rules content service", () => {
  it("splits long rules without dropping content", () => {
    const content = Array.from({ length: 300 }, (_, index) => `Regla ${index + 1}: texto de prueba.`).join("\n");
    const chunks = splitDiscordText(content, 500);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n").replaceAll(/\s+/g, " ")).toContain("Regla 300");
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
  });

  it("hashes content deterministically", () => {
    expect(hashRules("abc")).toBe(hashRules("abc"));
  });
});
