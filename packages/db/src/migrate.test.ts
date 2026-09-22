import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase } from './backup.ts';
import { openDb } from './client.ts';
import { pendingMigrations, runMigrations } from './migrate.ts';
import { MIGRATIONS } from './migrations/index.ts';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'funds-helper-db-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDb', () => {
  it('可用 :memory: 打开', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t (a INTEGER)');
    db.run('INSERT INTO t VALUES (?)', [1]);
    expect(db.get<{ a: number }>('SELECT a FROM t')).toEqual({ a: 1 });
    db.close();
  });

  it('自动创建父目录', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'nested', 'deeper', 'funds.db');
    const db = openDb(dbPath);
    db.exec('CREATE TABLE t (a INTEGER)');
    db.close();
    // 再次打开，数据仍在
    const reopened = openDb(dbPath);
    expect(
      reopened.get<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 't'"),
    ).toEqual({
      name: 't',
    });
    reopened.close();
  });

  it('开启外键约束（SQLite 默认关闭）', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY)');
    db.exec('CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))');
    expect(() => db.run('INSERT INTO child VALUES (?, ?)', ['c1', 'missing'])).toThrow();
    db.close();
  });

  it('事务提交与回滚', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t (a INTEGER)');

    db.transaction(() => {
      db.run('INSERT INTO t VALUES (?)', [1]);
    });
    expect(db.all('SELECT a FROM t')).toHaveLength(1);

    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (?)', [2]);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    // 回滚后第 2 条不应存在
    expect(db.all<{ a: number }>('SELECT a FROM t').map((r) => r.a)).toEqual([1]);
    db.close();
  });

  it('嵌套事务复用最外层事务，不会因重复 BEGIN 报错', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t (a INTEGER)');
    db.transaction(() => {
      db.run('INSERT INTO t VALUES (?)', [1]);
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (?)', [2]);
      });
    });
    expect(db.all('SELECT a FROM t')).toHaveLength(2);
    db.close();
  });

  it('lastInsertRowid 可用于自增主键', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, a INTEGER)');
    expect(db.run('INSERT INTO t (a) VALUES (?)', [7]).lastInsertRowid).toBe(1);
    expect(db.run('INSERT INTO t (a) VALUES (?)', [8]).lastInsertRowid).toBe(2);
    db.close();
  });
});

describe('runMigrations', () => {
  it('初始数据库会应用全部迁移并建出所有表', () => {
    const db = openDb(':memory:');
    const applied = runMigrations(db);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));

    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name);

    for (const expected of [
      'job_run',
      'qdii_fund',
      'qdii_limit_snapshot',
      'qdii_limit_change',
      'qdii_notice',
      'qdii_premium',
      'qdii_detail_cache',
      'usd_fund',
      'usd_snapshot',
      'usd_sibling',
      'usd_detail_cache',
      'fx_rate_daily',
      'etf_spot_daily',
      'etf_profile',
      'etf_detail_cache',
      'etf_feeder_fund',
      'app_setting',
      'schema_migration',
    ]) {
      expect(tables).toContain(expected);
    }
    db.close();
  });

  it('usd_snapshot 具备 channel_not_sold 列（这条列由 0003 追加迁移补齐）', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const columns = db
      .all<{ name: string }>('PRAGMA table_info(usd_snapshot)')
      .map((row) => row.name);
    expect(columns).toContain('channel_not_sold');
    db.close();
  });

  it('etf_spot_daily 具备 source 列（这条列由 0006 追加迁移补齐）', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const columns = db
      .all<{ name: string }>('PRAGMA table_info(etf_spot_daily)')
      .map((row) => row.name);
    expect(columns).toContain('source');
    db.close();
  });

  it('etf_feeder_fund 以 feeder_code 为主键：一只 ETF 多个份额，一只联接基金只能有一个目标', () => {
    const db = openDb(':memory:');
    runMigrations(db);

    const insert = (feederCode: string, etfCode: string): void => {
      db.run(
        `INSERT INTO etf_feeder_fund (feeder_code, etf_code, feeder_name, report_date, captured_at)
         VALUES (?, ?, '某某ETF联接A', '2026-06-30', '2026-09-22T00:00:00.000Z')`,
        [feederCode, etfCode],
      );
    };

    // 同一只 ETF 的多个联接份额（A/C/I/Y）：必须都留得下，这正是这张表存在的理由
    insert('460300', '510300');
    insert('006131', '510300');
    // 同一只联接基金不能既挂在 510300 又挂在 159915
    expect(() => insert('460300', '159915')).toThrow();

    const codes = db
      .all<{ feeder_code: string }>(
        'SELECT feeder_code FROM etf_feeder_fund WHERE etf_code = ? ORDER BY feeder_code',
        ['510300'],
      )
      .map((row) => row.feeder_code);
    expect(codes).toEqual(['006131', '460300']);
    db.close();
  });

  it('重复执行是幂等的（第二次不应用任何迁移）', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(runMigrations(db)).toEqual([]);
    expect(pendingMigrations(db)).toEqual([]);
    db.close();
  });

  it('文件库重开后不会重复应用（迁移状态落在库里）', () => {
    const dbPath = join(tempDir(), 'funds.db');
    const first = openDb(dbPath);
    expect(runMigrations(first)).toHaveLength(MIGRATIONS.length);
    first.close();

    const second = openDb(dbPath);
    expect(runMigrations(second)).toEqual([]);
    second.close();
  });

  it('迁移失败时该条不记账，下次可重试', () => {
    const db = openDb(':memory:');
    const custom = [
      { id: 'ok', sql: 'CREATE TABLE ok (a INTEGER);' },
      { id: 'bad', sql: 'THIS IS NOT SQL;' },
    ];

    expect(() => runMigrations(db, custom)).toThrow();

    // 'ok' 已记账，'bad' 未记账 → 下次只会重试 'bad'
    expect(pendingMigrations(db, custom).map((m) => m.id)).toEqual(['bad']);
    expect(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'ok'")).toEqual({
      name: 'ok',
    });
    db.close();
  });
});

describe('backupDatabase', () => {
  it(':memory: 不做备份', () => {
    expect(backupDatabase(':memory:')).toBeNull();
  });

  it('不存在的文件不做备份', () => {
    expect(backupDatabase(join(tempDir(), 'nope.db'))).toBeNull();
  });

  it('复制数据库文件并只保留最近 N 份', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'funds.db');
    const db = openDb(dbPath);
    runMigrations(db);
    db.close();

    for (let i = 0; i < 7; i += 1) {
      expect(backupDatabase(dbPath, 3)).not.toBeNull();
    }

    const backups = readdirSync(dir).filter((name) => name.startsWith('funds.db.bak.'));
    expect(backups).toHaveLength(3);
  });
});
