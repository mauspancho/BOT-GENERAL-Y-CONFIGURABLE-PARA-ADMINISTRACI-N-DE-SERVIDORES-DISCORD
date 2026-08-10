import { loadEnv } from "../core/config/env.js";
import { getConfigPath } from "../core/config/paths.js";
import { readServerConfig } from "../core/config/configStore.js";
import { registerGuildCommands } from "../commands/register.js";

const env = loadEnv();
const config = readServerConfig(getConfigPath());
await registerGuildCommands(env.DISCORD_TOKEN, env.DISCORD_CLIENT_ID, config);
console.log("Comandos registrados.");
