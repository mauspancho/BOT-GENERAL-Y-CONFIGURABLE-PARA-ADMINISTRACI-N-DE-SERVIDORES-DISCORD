declare module "sql.js" {
  export type SqlValue = string | number | null | Uint8Array;

  export interface Statement {
    bind(values?: SqlValue[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlValue>;
    run(values?: SqlValue[]): void;
    free(): boolean;
  }

  export interface Database {
    exec(sql: string): unknown[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: {
      new (data?: Uint8Array | Buffer): Database;
    };
  }

  export interface InitSqlJsConfig {
    locateFile?: (filename: string) => string;
  }

  export default function initSqlJs(config?: InitSqlJsConfig): Promise<SqlJsStatic>;
}
