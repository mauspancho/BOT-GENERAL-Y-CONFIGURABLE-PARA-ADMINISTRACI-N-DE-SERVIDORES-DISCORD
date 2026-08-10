export class AppError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class ConfigurationError extends AppError {
  public constructor(message: string) {
    super("CONFIGURATION_ERROR", message);
  }
}

export class DiscordPermissionError extends AppError {
  public constructor(message: string) {
    super("DISCORD_PERMISSION_ERROR", message);
  }
}

export class DiscordResourceNotFoundError extends AppError {
  public constructor(message: string) {
    super("DISCORD_RESOURCE_NOT_FOUND", message);
  }
}

export class InstallerError extends AppError {
  public constructor(message: string) {
    super("INSTALLER_ERROR", message);
  }
}

export class DatabaseError extends AppError {
  public constructor(message: string) {
    super("DATABASE_ERROR", message);
  }
}
