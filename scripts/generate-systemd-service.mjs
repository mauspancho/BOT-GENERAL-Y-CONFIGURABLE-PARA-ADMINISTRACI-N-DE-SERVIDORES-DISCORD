import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const service = `[Unit]
Description=Discord Community Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${cwd}
EnvironmentFile=${path.join(cwd, ".env")}
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
`;

fs.mkdirSync(path.join(cwd, "deploy", "systemd"), { recursive: true });
fs.writeFileSync(path.join(cwd, "deploy", "systemd", "discord-community-bot.generated.service"), service);
console.log("Servicio generado en deploy/systemd/discord-community-bot.generated.service");
