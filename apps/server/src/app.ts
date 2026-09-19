import { backupDatabase, type Db, JobRunRepository, openDb, runMigrations } from '@funds-helper/db';
import { HttpClient } from '@funds-helper/sources';
import Fastify, { type FastifyInstance } from 'fastify';
import { TtlCache } from './cache.ts';
import { type AppConfig, loadConfig } from './config.ts';
import { registerErrorHandler, registerNotFoundHandler } from './plugins/errors.ts';
import { registerStatic } from './plugins/static.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerToolRoutes } from './routes/tools.ts';
import { Scheduler } from './scheduler.ts';
import { createServerTools } from './tools/registry.ts';
import type { ServerTool, ToolContext } from './tools/types.ts';

export interface BuildAppOptions {
  config?: AppConfig;
  /** 注入工具注册表（测试用） */
  tools?: ServerTool[];
  /** 注入已打开的数据库（测试用 :memory:） */
  db?: Db;
  http?: HttpClient;
  serveStatic?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  config: AppConfig;
  db: Db;
  cache: TtlCache;
  scheduler: Scheduler;
  close(): Promise<void>;
}

/**
 * 组装 Fastify 实例。
 *
 * 刻意接受依赖注入：测试可以塞入 :memory: 数据库与替身上游，
 * 不需要起真实端口（用 `app.inject()` 即可）。
 *
 * 注意：这里**不会启动定时器** —— 由入口 `index.ts` 按 config.jobsEnabled 决定，
 * 避免测试环境里跑出真实的 cron。
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? loadConfig();
  const ownsDb = options.db === undefined;
  const db = options.db ?? openDb(config.dbPath);

  // 迁移前备份（仅文件库），保留最近 5 份
  if (ownsDb) backupDatabase(config.dbPath);
  runMigrations(db);

  const app = Fastify({ logger: { level: config.logLevel } });
  const cache = new TtlCache(config.memoryCacheTtlSec * 1000);
  const http =
    options.http ??
    new HttpClient({
      timeoutMs: config.upstreamTimeoutMs,
      concurrency: config.upstreamConcurrency,
      minIntervalMs: config.upstreamMinIntervalMs,
      logger: app.log,
    });

  const jobRuns = new JobRunRepository(db);
  const scheduler = new Scheduler({ timezone: config.timezone, jobRuns, logger: app.log });

  registerErrorHandler(app);

  const tools = options.tools ?? createServerTools();
  const ctx: ToolContext = {
    db,
    jobRuns,
    http,
    cache,
    config,
    logger: app.log,
    jobs: scheduler,
  };

  for (const tool of tools) {
    // prefix 由框架统一加，工具自己不关心挂载点
    await app.register(
      async (instance) => {
        await tool.register(instance, ctx);
      },
      { prefix: `/api/tools/${tool.descriptor.id}` },
    );

    for (const job of tool.jobs?.(ctx) ?? []) scheduler.register(job, ctx);
  }

  registerToolRoutes(app, tools);
  registerHealthRoutes(app, {
    dbPath: config.dbPath,
    jobRuns,
    scheduler,
    tools: tools.map((tool) => tool.descriptor),
    startedAt: Date.now(),
  });

  // 404 处理只能注册一次：托管前端时用 SPA 回退，否则用纯 JSON 错误
  const staticEnabled =
    (options.serveStatic ?? config.serveStatic) && (await registerStatic(app, config.webDistPath));
  if (!staticEnabled) registerNotFoundHandler(app);

  return {
    app,
    config,
    db,
    cache,
    scheduler,
    async close() {
      scheduler.stop();
      await app.close();
      if (ownsDb) db.close();
    },
  };
}
