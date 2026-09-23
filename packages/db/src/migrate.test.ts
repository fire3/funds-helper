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
      'etf_period_return',
      'app_setting',
      'schema_migration',
    ]) {
      expect(tables).toContain(expected);
    }
    db.close();
  });

  it('etf_spot_daily 具备 shares 列（0011 起随快照积累份额，净申购代理）', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const columns = db
      .all<{ name: string }>('PRAGMA table_info(etf_spot_daily)')
      .map((row) => row.name);
    expect(columns).toContain('shares');
    db.close();
  });

  it('etf_period_return 以 code 为主键（每周重抓覆盖同一行，幂等）', () => {
    const db = openDb(':memory:');
    runMigrations(db);

    const insert = db.run(
      `INSERT INTO etf_period_return (code, data_date, captured_at, ret_6m, ret_1y, ret_3y, bench_1y, bench_3y)
       VALUES ('510300', '2026-09-22', '2026-09-23T00:00:00.000Z', 6, 12, 36, 5, 15)`,
    );
    expect(insert.changes).toBe(1);
    // 同一只 ETF 再抓一次 → 覆盖而不是报唯一键冲突
    expect(() =>
      db.run(
        `INSERT INTO etf_period_return (code, data_date, captured_at, ret_6m, ret_1y, ret_3y, bench_1y, bench_3y)
         VALUES ('510300', '2026-09-30', '2026-10-01T00:00:00.000Z', 7, 13, 37, 6, 16)
         ON CONFLICT(code) DO UPDATE SET
           data_date = excluded.data_date, captured_at = excluded.captured_at,
           ret_6m = excluded.ret_6m, ret_1y = excluded.ret_1y, ret_3y = excluded.ret_3y,
           bench_1y = excluded.bench_1y, bench_3y = excluded.bench_3y`,
      ),
    ).not.toThrow();
    const row = db.get<{ ret_1y: number; data_date: string }>(
      'SELECT ret_1y, data_date FROM etf_period_return WHERE code = ?',
      ['510300'],
    );
    expect(row).toEqual({ ret_1y: 13, data_date: '2026-09-30' });
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

  it('0010 把 0009 旧结构（联合主键）收敛到 feeder_code 单列主键', () => {
    const db = openDb(':memory:');
    // 模拟 0009 定稿前建的库：迁移已记账、表却是 (etf_code, feeder_code) 联合主键。
    // 只跑到 0010 —— 之后的迁移（如 0011 的 ALTER）依赖其它已建表，不属于本用例的场景。
    const upTo0010 = MIGRATIONS.filter((m) => m.id <= '0010-etf-feeder-fund-pk');
    db.exec(`CREATE TABLE schema_migration (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    for (const migration of upTo0010.filter((m) => m.id < '0010')) {
      db.run('INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)', [
        migration.id,
        '2026-09-22T00:00:00.000Z',
      ]);
    }
    db.exec(`
      CREATE TABLE etf_feeder_fund (
        etf_code    TEXT NOT NULL,
        feeder_code TEXT NOT NULL,
        feeder_name TEXT NOT NULL,
        report_date TEXT,
        captured_at TEXT NOT NULL,
        PRIMARY KEY (etf_code, feeder_code)
      );
      CREATE INDEX idx_etf_feeder_fund_etf ON etf_feeder_fund(etf_code);
      INSERT INTO etf_feeder_fund VALUES
        ('510300', '460300', '某某ETF联接A', '2026-03-31', '2026-06-01T00:00:00.000Z'),
        ('159915', '460300', '某某ETF联接A', '2026-06-30', '2026-09-01T00:00:00.000Z'),
        ('510300', '006131', '某某ETF联接C', NULL,        '2026-09-01T00:00:00.000Z');
    `);

    expect(runMigrations(db, upTo0010)).toEqual(['0010-etf-feeder-fund-pk']);

    // 冲突键有落点了：换目标 ETF 走 UPDATE 而不是抛错
    expect(() =>
      db.run(
        `INSERT INTO etf_feeder_fund (feeder_code, etf_code, feeder_name, report_date, captured_at)
         VALUES ('460300', '510300', '某某ETF联接A', '2026-06-30', '2026-09-23T00:00:00.000Z')
         ON CONFLICT(feeder_code) DO UPDATE SET etf_code = excluded.etf_code`,
      ),
    ).not.toThrow();

    const rows = db.all<{ feeder_code: string; etf_code: string }>(
      'SELECT feeder_code, etf_code FROM etf_feeder_fund ORDER BY feeder_code',
    );
    expect(rows).toEqual([
      { feeder_code: '006131', etf_code: '510300' },
      { feeder_code: '460300', etf_code: '510300' },
    ]);

    const pkColumns = db
      .all<{ name: string; pk: number }>('PRAGMA table_info(etf_feeder_fund)')
      .filter((column) => column.pk > 0)
      .map((column) => column.name);
    expect(pkColumns).toEqual(['feeder_code']);

    const indexes = db
      .all<{ name: string }>('PRAGMA index_list(etf_feeder_fund)')
      .map((index) => index.name);
    expect(indexes).toContain('idx_etf_feeder_fund_etf');
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
