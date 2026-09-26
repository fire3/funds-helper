import { SettingRepository } from '@funds-helper/db';
import { TOOL_CATALOG } from '@funds-helper/shared';
import type { FastifyInstance } from 'fastify';
import type { JobDefinition, ServerTool, ToolContext } from '../types.ts';
import { newsJobs } from './jobs.ts';
import { NewsRepository } from './repository.ts';
import { registerNewsRoutes } from './routes.ts';
import { NewsService } from './service.ts';

export interface CreateNewsToolOptions {
  /** 测试注入可控时钟（窗口边界、陈旧规则、日额度都要它） */
  now?: () => number;
}

/**
 * 信息流与 AI 每日简报（`news`）—— 工具箱的第五个工具。
 *
 * 与前四个工具共享框架能力（调度器、`job_run` 留痕、错误模型），但读路径是新的：
 * **信息流与简报是两条独立读路径** —— 模型挂了、配额用完了、提示词改坏了，
 * 信息流照样能看（design §2）。
 */
export function createNewsTool(options: CreateNewsToolOptions = {}): ServerTool {
  let memo: { ctx: ToolContext; service: NewsService } | null = null;

  const serviceFor = (ctx: ToolContext): NewsService => {
    if (memo !== null && memo.ctx === ctx) return memo.service;

    const service = new NewsService({
      db: ctx.db,
      repo: new NewsRepository(ctx.db),
      settings: new SettingRepository(ctx.db),
      http: ctx.http,
      config: ctx.config,
      logger: ctx.logger,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    memo = { ctx, service };
    return service;
  };

  return {
    descriptor: TOOL_CATALOG.news,
    async register(app: FastifyInstance, ctx: ToolContext): Promise<void> {
      registerNewsRoutes(app, ctx, serviceFor(ctx));
    },
    jobs(ctx: ToolContext): JobDefinition[] {
      return newsJobs(serviceFor(ctx));
    },
  };
}
