import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SqlParams = readonly (string | number | null)[];

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/**
 * 极简 SQLite 封装。
 *
 * 刻意**不引入 ORM**：用 Node 26 内置的 `node:sqlite`，零原生编译、零额外依赖，
 * SQL 全部显式可读（本项目 SQL 不复杂，ORM 的收益小于它带来的抽象成本）。
 */
export interface Db {
  readonly raw: DatabaseSync;
  exec(sql: string): void;
  run(sql: string, params?: SqlParams): RunResult;
  all<T>(sql: string, params?: SqlParams): T[];
  get<T>(sql: string, params?: SqlParams): T | undefined;
  transaction<T>(fn: () => T): T;
  close(): void;
}

class SqliteDb implements Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    // 外键约束（SQLite 默认关闭）
    this.raw.exec('PRAGMA foreign_keys = ON');
    // 写锁竞争时等待，而不是立刻报 SQLITE_BUSY
    this.raw.exec('PRAGMA busy_timeout = 5000');
    // WAL 提升读写并发；`:memory:` 下会返回 memory，属正常
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, params: SqlParams = []): RunResult {
    const statement = this.raw.prepare(sql);
    const result = statement.run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  all<T>(sql: string, params: SqlParams = []): T[] {
    const statement = this.raw.prepare(sql);
    return statement.all(...params) as T[];
  }

  get<T>(sql: string, params: SqlParams = []): T | undefined {
    const statement = this.raw.prepare(sql);
    return statement.get(...params) as T | undefined;
  }

  /**
   * 事务。嵌套调用时复用一个事务（SQLite 不支持嵌套 BEGIN），
   * 由最外层负责 COMMIT / ROLLBACK。
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();

    this.exec('BEGIN');
    this.depth += 1;
    try {
      const result = fn();
      this.exec('COMMIT');
      return result;
    } catch (error) {
      this.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  close(): void {
    this.raw.close();
  }
}

/** 打开数据库；`:memory:` 用于测试。会自动创建父目录。 */
export function openDb(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  return new SqliteDb(path);
}
