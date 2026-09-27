import { TOOL_CATALOG } from '@funds-helper/shared';
import type { FastifyInstance } from 'fastify';
import { createIndicesDataSource } from '../../data-sources/indices.ts';
import type { JobDefinition, ServerTool, ToolContext } from '../types.ts';
import type { IndicesDataSource } from './data-source.ts';
import { indicesJobs } from './jobs.ts';
import { IndicesRepository } from './repository.ts';
import { registerIndicesRoutes } from './routes.ts';
import { IndicesService } from './service.ts';

export interface CreateIndicesToolOptions {
  /** 测试注入替身数据源（集成测试的降级/幂等路径靠它） */
  source?: IndicesDataSource;
  now?: () => number;
}

/**
 * 国际行情工具 —— 工具箱的第六个工具。
 *
 * 与其它工具共享框架能力（三级降级、`freshness` 契约、调度器与 `job_run` 留痕），
 * 上游是**四源编排**：新浪 gi / 腾讯（稳定国内源，主）→ 东财 K 线 → Yahoo（兜底），
 * 见 `docs/design/indices-tool.md` §3。
 */
export function createIndicesTool(options: CreateIndicesToolOptions = {}): ServerTool {
  let memo: { ctx: ToolContext; service: IndicesService } | null = null;

  const serviceFor = (ctx: ToolContext): IndicesService => {
    if (memo && memo.ctx === ctx) return memo.service;

    const service = new IndicesService({
      db: ctx.db,
      repo: new IndicesRepository(ctx.db),
      source: options.source ?? createIndicesDataSource(ctx.http),
      cache: ctx.cache,
      config: ctx.config,
      logger: ctx.logger,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    memo = { ctx, service };
    return service;
  };

  return {
    descriptor: TOOL_CATALOG.indices,
    async register(app: FastifyInstance, ctx: ToolContext): Promise<void> {
      registerIndicesRoutes(app, ctx, serviceFor(ctx));
    },
    jobs(ctx: ToolContext): JobDefinition[] {
      return indicesJobs(serviceFor(ctx));
    },
  };
}
