import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/services/templateService.js";

describe("template service", () => {
  it("renders supported variables", () => {
    expect(
      renderTemplate("Hola {user} en {server}. Somos {memberCount}.", {
        user: "<@1>",
        username: "Maus",
        server: "Comunidad",
        memberCount: 7,
      }),
    ).toBe("Hola <@1> en Comunidad. Somos 7.");
  });
});
