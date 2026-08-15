# Discord Community Bot

Bot general, configurable y modular para administrar varias comunidades Discord en una sola instancia, sin hardcodear nombres, IDs ni comportamientos especificos de un cliente.

## Requisitos

- Node.js LTS 20 o superior.
- npm.
- Una aplicacion Discord con bot creado.
- Permisos de administracion en el servidor donde se instalara.

## Crear La Aplicacion Discord

1. Entra al Discord Developer Portal.
2. Crea una aplicacion.
3. Crea un bot y copia el token.
4. En Bot > Privileged Gateway Intents habilita `Server Members Intent`.
5. No habilites `Message Content Intent`; este proyecto usa slash commands, botones y eventos.
6. En OAuth2 genera una URL con scopes `bot` y `applications.commands`.
7. Permisos recomendados: Manage Channels, Manage Roles, View Channels, Send Messages, Embed Links, Read Message History, Manage Messages y Use Application Commands.
8. Agrega `Kick Members` solo si configuras rechazo de reglas con expulsion.
9. Invita el bot al servidor.

## Instalacion

```bash
npm install
npm run setup
```

El setup pedira token, Application/Client ID, mostrara los servidores donde esta el bot y permitira agregar o modificar cada servidor de forma independiente.

El token solo se guarda en `.env`. No se copia en backups normales, logs ni archivos de configuracion.

Durante la instalacion, el wizard escanea la estructura actual del servidor antes de crear recursos. Si encuentra categorias o canales compatibles por ID, nombre exacto normalizado o alias conocidos como `general`, `reglas`, `bienvenida`, `anuncios`, `roles` o `logs`, reutiliza esos recursos y guarda sus IDs. Si hay coincidencias ambiguas, no elige automaticamente: deja el recurso pendiente para decision explicita. El setup nunca mueve canales existentes de categoria de forma silenciosa ni duplica un canal que ya pudo reutilizar.

## Comandos Disponibles

```bash
npm run dev
npm run build
npm start
npm run setup
npm run validate
npm run doctor
npm run doctor -- --output diagnostic.json
npm run backup
npm run commands:register
npm run lint
npm run typecheck
npm test
```

## Configuracion

- Secretos y datos de proceso: `.env`
- Configuracion funcional por servidor: `config/guilds/<guildId>.json`
- Reglas normalizadas: `data/rules.md`
- Base SQLite: `data/bot.sqlite`
- Logs locales: `logs/app.log`
- Backups: `backups/backup-YYYYMMDD-HHMMSS`

Los IDs de categorias, canales y roles se guardan automaticamente cuando Discord devuelve los recursos creados o reutilizados.

Si existe una instalacion anterior con `config/server.json`, el bot la migra de forma segura en el primer arranque o setup: lee su `guildId`, crea `config/guilds/<guildId>.json`, deja el original intacto y crea un backup `config/server.json.pre-multiguild-*.bak`.

## MVP Implementado

- Proyecto TypeScript estricto.
- Configuracion versionada con Zod.
- CLI interactiva con instalacion rapida y personalizada.
- Administracion multi-guild con una configuracion por servidor.
- Inventario seguro y reutilizacion de categorias, canales y roles existentes.
- Captura automatica de IDs.
- Validacion de permisos por modulo.
- Reglas externas `.md` o `.txt`.
- Division de reglas largas para embeds Discord.
- Panel unico persistente de reglas con botones.
- Flujo de aceptar/rechazar reglas.
- Rol pendiente y rol miembro.
- Bienvenida en canal y/o DM con variables `{user}`, `{username}`, `{server}`, `{memberCount}`.
- Canal de logs administrativo.
- SQLite con migraciones y repositorios.
- Backups sin secretos.
- Doctor exportable sin token.
- Modulo opcional The Isle Evrima con archivo Markdown externo configurable.
- Docker, docker-compose y plantilla systemd.
- CI sin secretos Discord para lint, typecheck, tests y build.

## Slash Commands

- `/bot-status`
- `/config-status`
- `/rules`
- `/guide reload` cuando `theIsleGuide` esta activo.
- `/alerta enviar` cuando `generalAlerts` esta activo.
- `/tiktok conectar|estado|activar|desactivar|desconectar|prueba|republicar` cuando `tiktokAlerts` esta activo.

Los comandos administrativos validan permisos del usuario en el handler, no solo durante el registro.

## Alertas Al Canal General

El modulo `generalAlerts` esta activo por defecto y usa siempre el canal logico `general` guardado por el instalador en `config.channels.general.id`. No requiere `GENERAL_CHAT_CHANNEL_ID` ni pide un ID adicional en `.env`.

`/alerta enviar` permite a administradores publicar una alerta en `#general` con tipo y mencion opcional. El comando requiere `Administrator`, no funciona por DM y vuelve a validar permisos dentro del handler. Las menciones se controlan con `allowedMentions`: el texto del mensaje no puede generar menciones arbitrarias; solo se envia `@everyone` o `@here` cuando el administrador elige explicitamente `mencion`.

## TikTok Alerts

El modulo `tiktokAlerts` usa la API oficial de TikTok, no scraping. Requiere `generalAlerts` activo y publica siempre mediante `config.channels.general.id`; no crea canales nuevos.

Las credenciales de la app TikTok Developer son globales en `.env`, pero cada guild tiene su propia conexion TikTok en SQLite mediante `guild_id`: `state` OAuth, `open_id`, access token, refresh token, videos publicados, polling y logs quedan aislados por servidor. El callback HTTP es unico para toda la instancia y resuelve el guild correcto usando el `state` recibido desde TikTok.

Pasos de configuracion:

1. Crea una app en TikTok Developer.
2. Habilita Login Kit.
3. Habilita los scopes `user.info.basic` y `video.list`.
4. Registra el Redirect URI `https://tiktok.linuxred.lat/tiktok/callback`.
5. Configura Cloudflare para enviar ese endpoint HTTPS al callback local del bot, por defecto `http://127.0.0.1:8787/tiktok/callback`.
6. Ejecuta `npm run setup` y activa `Alertas automaticas de TikTok`.
7. Introduce TikTok Client Key, TikTok Client Secret, Redirect URI, callback host, callback port, polling y mencion por defecto.
8. Ejecuta `/tiktok conectar` en Discord y autoriza la cuenta TikTok que se va a monitorear.
9. Revisa `/tiktok estado`.
10. Ejecuta `/tiktok prueba` para publicar una alerta manual usando el mismo pipeline del monitor.
11. Usa `/tiktok republicar` si necesitas volver a publicar manualmente un video ya existente.

`/tiktok republicar` muestra un menu efimero con los videos recientes de la cuenta conectada, limitado a 20 opciones. Solo el administrador que abrio el menu puede usarlo, dentro del mismo servidor. La republicacion manual puede volver a enviar un video ya publicado, pero no modifica el dedupe automatico, el baseline, `lastVideoId`, `lastCheckAt`, `lastSuccessAt` ni el estado del polling.

Variables gestionadas en `.env`:

```text
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_REDIRECT_URI=https://tiktok.linuxred.lat/tiktok/callback
TIKTOK_CALLBACK_HOST=127.0.0.1
TIKTOK_CALLBACK_PORT=8787
TIKTOK_TOKEN_ENCRYPTION_KEY=
```

No pongas secretos reales en archivos versionados. El setup conserva variables existentes de `.env` y genera `TIKTOK_TOKEN_ENCRYPTION_KEY` una sola vez si no existe.

Los access/refresh tokens se guardan en SQLite cifrados con AES-256-GCM. La base de datos puede incluirse en backups porque los tokens estan cifrados, pero `.env` no se respalda. Si restauras un backup sin la misma `TIKTOK_TOKEN_ENCRYPTION_KEY`, esos tokens TikTok no podran descifrarse y tendras que reconectar la cuenta.

## The Isle Evrima Guide

El modulo `theIsleGuide` usa una fuente Markdown configurable:

```json
"theIsleGuide": {
  "enabled": true,
  "sourcePath": "/ruta/al/archivo/dinosaurs.md"
}
```

La ruta se solicita en `npm run setup` cuando activas `The Isle Evrima Guide`. Puede ser absoluta o relativa; las rutas relativas se resuelven desde el directorio raiz del proyecto. El archivo no tiene que estar dentro del repositorio y no se copia a `data/`.

Puedes modificar ese Markdown externamente y ejecutar `/guide reload` para volver a leerlo sin recompilar el bot. El usuario del sistema operativo que ejecuta el proceso del bot debe tener permiso de lectura sobre `sourcePath`, especialmente si lo corres con systemd.

## Backups Y Restauracion

Crear backup:

```bash
npm run backup
```

Restaurar desde el menu:

```bash
npm run setup
```

Antes de restaurar se crea un backup automatico del estado actual. `.env` y el token Discord no se incluyen.

## Validacion Y Diagnostico

```bash
npm run validate
npm run doctor -- --output diagnostic.json
```

`validate` comprueba entorno, configuraciones por guild, reglas, SQLite, conexion Discord, guilds, recursos configurados y permisos.

`doctor` produce informacion segura para soporte tecnico: version de Node, version del bot, configuraciones por guild, modulos, estado de DB, conectividad y permisos faltantes.

## Docker

```bash
docker compose up --build -d
```

Se montan volumenes para:

- `/app/config`
- `/app/data`
- `/app/logs`
- `/app/backups`

No metas secretos dentro de la imagen. Usa `.env`.

## systemd

Plantilla base:

```text
deploy/systemd/discord-community-bot.service
```

Edita `WorkingDirectory`, `EnvironmentFile`, `User` y `Group` segun tu servidor, por ejemplo `/opt/discord-community-bot`.

Tambien puedes generar una plantilla con la ruta actual:

```bash
node scripts/generate-systemd-service.mjs
```

## Desarrollo De Modulos

Cada modulo implementa una interfaz comun:

```ts
interface BotModule {
  name: string;
  enabled(config): boolean;
  validate(context): Promise<ValidationResult>;
  register(context): Promise<void>;
  start(context): Promise<void>;
  stop?(context): Promise<void>;
}
```

Un modulo desactivado no registra comandos innecesarios, no exige permisos extra y no debe requerir canales que no utiliza.

## Privacidad

La V1 guarda solo datos necesarios:

- `guild_id`
- `user_id`
- fecha de aceptacion de reglas
- version de reglas aceptada
- mensajes persistentes del bot
- auditoria local de cambios estructurales

No almacena perfiles completos ni contenido de mensajes de usuarios.
