# Discord Community Bot

Bot general, configurable y modular para administrar comunidades Discord sin hardcodear nombres, IDs ni comportamientos especificos de un cliente.

La V1 esta pensada para una instalacion por servidor Discord, pero la persistencia guarda `guild_id` para no bloquear soporte multi-guild futuro.

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

El setup pedira token, Application/Client ID, seleccionara automaticamente el servidor donde esta el bot y permitira elegir instalacion rapida o personalizada.

El token solo se guarda en `.env`. No se copia en backups normales, logs ni `config/server.json`.

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
- Configuracion funcional: `config/server.json`
- Reglas normalizadas: `data/rules.md`
- Base SQLite: `data/bot.sqlite`
- Logs locales: `logs/app.log`
- Backups: `backups/backup-YYYYMMDD-HHMMSS`

Los IDs de categorias, canales y roles se guardan automaticamente cuando Discord devuelve los recursos creados o reutilizados.

## MVP Implementado

- Proyecto TypeScript estricto.
- Configuracion versionada con Zod.
- CLI interactiva con instalacion rapida y personalizada.
- Seleccion automatica de guild.
- Creacion o reutilizacion de categorias, canales y roles.
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
- Docker, docker-compose y plantilla systemd.
- CI sin secretos Discord para lint, typecheck, tests y build.

## Slash Commands

- `/bot-status`
- `/config-status`
- `/rules`

Los comandos administrativos validan permisos del usuario en el handler, no solo durante el registro.

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

`validate` comprueba entorno, configuracion, reglas, SQLite, conexion Discord, guild, recursos configurados y permisos.

`doctor` produce informacion segura para soporte tecnico: version de Node, version del bot, version de configuracion, guild, modulos, estado de DB, conectividad y permisos faltantes.

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

## Fase 2

La arquitectura deja preparados estos modulos, pero no estan completos en V1:

- self-roles avanzados
- tickets
- sugerencias
- anuncios avanzados
- moderacion ampliada
- anti-raid
- multi-guild en un solo proceso
