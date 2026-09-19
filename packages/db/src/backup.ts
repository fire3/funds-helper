import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * 迁移前备份数据库（SQLite 是单文件，复制即可）。
 * 只保留最近 `keep` 份，避免无限增长。
 */
export function backupDatabase(dbPath: string, keep = 5): string | null {
  if (dbPath === ':memory:' || !existsSync(dbPath)) return null;

  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.bak.`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  // 毫秒级时间戳仍可能撞名（同一毫秒内连续备份），撞了就加序号，
  // 否则后来的备份会静默覆盖前一份
  let target = join(dir, `${prefix}${stamp}`);
  let suffix = 1;
  while (existsSync(target)) {
    target = join(dir, `${prefix}${stamp}-${suffix}`);
    suffix += 1;
  }

  copyFileSync(dbPath, target);

  const existing = readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort();
  for (const name of existing.slice(0, Math.max(0, existing.length - keep))) {
    rmSync(join(dir, name), { force: true });
  }

  return target;
}
