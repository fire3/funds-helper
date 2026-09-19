import type { Db } from './client.ts';
import { MIGRATIONS, type Migration } from './migrations/index.ts';

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migration (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);`;

/** 尚未应用的迁移（按 id 升序） */
export function pendingMigrations(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
): Migration[] {
  db.exec(MIGRATION_TABLE);
  const applied = new Set(
    db.all<{ id: string }>('SELECT id FROM schema_migration').map((row) => row.id),
  );
  return migrations.filter((migration) => !applied.has(migration.id));
}

/**
 * 执行未应用的迁移，返回本次实际应用的 id 列表。
 *
 * 每条迁移在**独立事务**内执行：失败时已成功的迁移保持已应用状态，
 * 下一次启动会从失败的那条继续，不会重复执行前面的。
 */
export function runMigrations(db: Db, migrations: readonly Migration[] = MIGRATIONS): string[] {
  const applied: string[] = [];
  for (const migration of pendingMigrations(db, migrations)) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)', [
        migration.id,
        new Date().toISOString(),
      ]);
    });
    applied.push(migration.id);
  }
  return applied;
}
