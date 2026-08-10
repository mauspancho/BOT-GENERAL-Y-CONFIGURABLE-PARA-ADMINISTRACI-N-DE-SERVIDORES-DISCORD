import fs from "node:fs";
import path from "node:path";
import { editor, input, select } from "@inquirer/prompts";
import { projectRoot } from "../../core/config/paths.js";
import { loadRulesFile, normalizeRules } from "../../services/rulesContentService.js";

export async function configureRules(): Promise<string> {
  const mode = await select({
    message: "Configuracion de reglas",
    choices: [
      { name: "Importar archivo .md/.txt", value: "import" },
      { name: "Escribir reglas desde la CLI", value: "write" },
      { name: "Usar plantilla predeterminada", value: "template" },
      { name: "No configurar reglas ahora", value: "skip" },
    ],
  });

  const target = path.join(projectRoot, "data", "rules.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (mode === "import") {
    const source = await input({ message: "Ruta del archivo de reglas:" });
    const content = loadRulesFile(source);
    fs.writeFileSync(target, `${content}\n`, "utf8");
    return "./data/rules.md";
  }

  if (mode === "write") {
    const content = await editor({ message: "Escribe las reglas:" });
    fs.writeFileSync(target, `${normalizeRules(content)}\n`, "utf8");
    return "./data/rules.md";
  }

  if (mode === "template") {
    const source = path.join(projectRoot, "templates", "default-rules.md");
    fs.copyFileSync(source, target);
    return "./data/rules.md";
  }

  fs.writeFileSync(target, "# Reglas\n\nConfigura las reglas con npm run setup.\n", "utf8");
  return "./data/rules.md";
}
