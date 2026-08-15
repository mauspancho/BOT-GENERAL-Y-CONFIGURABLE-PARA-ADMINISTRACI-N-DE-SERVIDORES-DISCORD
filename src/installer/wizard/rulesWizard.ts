import path from "node:path";
import { editor, input, select } from "@inquirer/prompts";
import { projectRoot } from "../../core/config/paths.js";
import { loadRulesFile, normalizeRules } from "../../services/rulesContentService.js";
import type { PlannedFileOperation } from "../configEdit/plannedFileOperations.js";
import { managedRulesAbsolutePath, managedRulesSourcePath } from "../configEdit/rulesStorage.js";

export interface RulesWizardResult {
  sourcePath: string;
  fileOperations: PlannedFileOperation[];
}

export async function configureRules(guildId: string): Promise<RulesWizardResult> {
  const mode = await select({
    message: "Configuracion de reglas",
    choices: [
      { name: "Importar archivo .md/.txt", value: "import" },
      { name: "Escribir reglas desde la CLI", value: "write" },
      { name: "Usar plantilla predeterminada", value: "template" },
      { name: "No configurar reglas ahora", value: "skip" },
    ],
  });

  const target = managedRulesAbsolutePath(guildId);

  if (mode === "import") {
    const source = await input({ message: "Ruta del archivo de reglas:" });
    loadRulesFile(source);
    return {
      sourcePath: managedRulesSourcePath(guildId),
      fileOperations: [{ type: "copyFile", sourcePath: source, targetPath: target }],
    };
  }

  if (mode === "write") {
    const content = await editor({ message: "Escribe las reglas:" });
    return {
      sourcePath: managedRulesSourcePath(guildId),
      fileOperations: [{ type: "writeText", path: target, content: `${normalizeRules(content)}\n` }],
    };
  }

  if (mode === "template") {
    const source = path.join(projectRoot, "templates", "default-rules.md");
    return {
      sourcePath: managedRulesSourcePath(guildId),
      fileOperations: [{ type: "copyFile", sourcePath: source, targetPath: target }],
    };
  }

  return {
    sourcePath: managedRulesSourcePath(guildId),
    fileOperations: [
      {
        type: "writeText",
        path: target,
        content: "# Reglas\n\nConfigura las reglas con npm run setup.\n",
      },
    ],
  };
}
