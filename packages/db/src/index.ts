/**
 * @funds-helper/db —— SQLite 持久化层。
 *
 * 依赖 Node 内置的 `node:sqlite`，零原生编译、零 ORM。
 * 本包只放**框架级**能力（连接、迁移、备份、任务日志）；
 * 工具专属的 SQL 放在各自的服务端切片里（见 apps/server/src/tools/<id>/repository.ts）。
 */

export * from './backup.ts';
export * from './client.ts';
export * from './migrate.ts';
export * from './migrations/index.ts';
export * from './repositories/job-run.ts';
export * from './repositories/setting.ts';
