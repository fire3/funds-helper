import type { Db, JobRunRepository } from '@funds-helper/db';
import type { ToolDescriptor } from '@funds-helper/shared';
import type { HttpClient } from '@funds-helper/sources';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { TtlCache } from '../cache.ts';
import type { AppConfig } from '../config.ts';

/**
 * 框架注入给工具的上下文。
 * 工具只依赖这些能力，不直接 new 任何全局单例 —— 这样测试可以注入替身。
 */
export interface ToolContext {
  db: Db;
  jobRuns: JobRunRepository;
  http: HttpClient;
  cache: TtlCache;
  config: AppConfig;
  logger: FastifyBaseLogger;
}

export interface JobResult {
  stats?: Record<string, unknown>;
}

export type JobTrigger = 'cron' | 'boot' | 'manual';

/**
 * 任务触发器接口。
 * 收敛成接口而不是具体类，避免 tools ↔ scheduler 的循环依赖，也便于测试替身。
 */
export interface JobRunner {
  execute(name: string, trigger?: JobTrigger): Promise<JobResult | undefined>;
}

export interface JobDefinition {
  /** 全局唯一，如 'qdii.snapshot' */
  name: string;
  /** 标准 5 段 cron 表达式，按 config.timezone 解释 */
  cron: string;
  /** 服务启动后是否立刻跑一次（尽快有数据） */
  runOnBoot?: boolean;
  handler: (ctx: ToolContext) => Promise<JobResult | undefined>;
}

/**
 * 框架注入给工具的上下文。
 * 工具只依赖这些能力，不直接 new 任何全局单例 —— 这样测试可以注入替身。
 */
export interface ToolContext {
  db: Db;
  jobRuns: JobRunRepository;
  http: HttpClient;
  cache: TtlCache;
  config: AppConfig;
  logger: FastifyBaseLogger;
  jobs: JobRunner;
}

/**
 * 服务端工具契约。
 * 新增工具 = 实现这个接口 + 在 registry 里加一行，不改动框架代码。
 */
export interface ServerTool {
  descriptor: ToolDescriptor;
  /** 路由 prefix 由框架统一加为 /api/tools/{id} */
  register(app: FastifyInstance, ctx: ToolContext): Promise<void>;
  /** 该工具需要的定时任务。用函数形式是为了让工具自己管理 service 的生命周期 */
  jobs?(ctx: ToolContext): JobDefinition[];
}
