import type { Db } from '../client.ts';

export interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
}

/**
 * 运行时配置（KV）。
 *
 * 只负责存取**字符串**：值的合法性与默认值由调用方（工具层）负责 ——
 * 这样框架不需要认识业务枚举，加一个开关也不用动这里。
 */
export class SettingRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(key: string): string | null {
    return (
      this.db.get<{ value: string }>('SELECT value FROM app_setting WHERE key = ?', [key])?.value ??
      null
    );
  }

  set(key: string, value: string): void {
    this.db.run(
      `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, new Date().toISOString()],
    );
  }

  delete(key: string): void {
    this.db.run('DELETE FROM app_setting WHERE key = ?', [key]);
  }

  all(): SettingRow[] {
    return this.db.all<SettingRow>('SELECT * FROM app_setting ORDER BY key');
  }
}
