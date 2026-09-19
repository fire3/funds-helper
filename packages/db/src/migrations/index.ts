import { SQL as INIT } from './0001-init.ts';

export interface Migration {
  id: string;
  sql: string;
}

/**
 * 迁移注册表（按 id 升序执行）。
 *
 * **约定**：已发布的迁移不可修改，只能追加新文件 —— 否则已有数据库无法收敛。
 * 新增一个工具的 schema 时，在这里追加一条。
 */
export const MIGRATIONS: readonly Migration[] = [{ id: '0001-init', sql: INIT }];
