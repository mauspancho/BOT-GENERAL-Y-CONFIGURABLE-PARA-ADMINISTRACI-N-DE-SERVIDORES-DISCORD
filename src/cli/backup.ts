import { createBackup } from "../installer/backup/backupService.js";

const result = createBackup("cli");
console.log(`Backup creado: ${result.name}`);
console.log(`Ruta: ${result.path}`);
console.log(`Incluye: ${result.included.join(", ")}`);
