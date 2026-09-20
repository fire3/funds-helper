import { TOOL_CATALOG } from '@funds-helper/shared';
import type { FastifyInstance } from 'fastify';
import { createSinaFxDataSource } from '../../data-sources/sina.ts';
import type { JobDefinition, ServerTool, ToolContext } from '../types.ts';
import type { FxDataSource } from './data-source.ts';
import { fxJobs } from './jobs.ts';
import { FxRepository } from './repository.ts';
import { registerFxRoutes } from './routes.ts';
import { FxService } from './service.ts';

export interface CreateFxToolOptions {
  /** 测试注入替身数据源（服务端集成测试靠它验证降级路径） */
  source?: FxDataSource;
  now?: () => number;
}

/**
 * 人民币汇率工具 —— 工具箱的第三个工具。
 *
 * 与前两个工具共享框架能力（三级降级、`freshness` 契约、调度器与 `job_run` 留痕），
 * 但**不共享上游**：汇率的来源是新浪财经，与天天基金完全独立。
 */
export function createFxTool(options: CreateFxToolOptions = {}): ServerTool {
  let memo: { ctx: ToolContext; service: FxService } | null = null;

  const serviceFor = (ctx: ToolContext): FxService => {
    if (memo && memo.ctx === ctx) return memo.service;

    const service = new FxService({
      db: ctx.db,
      repo: new FxRepository(ctx.db),
      source: options.source ?? createSinaFxDataSource(ctx.http),
      cache: ctx.cache,
      config: ctx.config,
      logger: ctx.logger,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    memo = { ctx, service };
    return service;
  };

  return {
    descriptor: TOOL_CATALOG.fx,
    async register(app: FastifyInstance, ctx: ToolContext): Promise<void> {
      registerFxRoutes(app, ctx, serviceFor(ctx));
    },
    jobs(ctx: ToolContext): JobDefinition[] {
      return fxJobs(serviceFor(ctx));
    },
  };
}
