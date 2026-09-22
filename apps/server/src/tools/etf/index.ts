import { TOOL_CATALOG } from '@funds-helper/shared';
import type { FastifyInstance } from 'fastify';
import { createEastmoneyDataSource } from '../../data-sources/eastmoney.ts';
import type { JobDefinition, ServerTool, ToolContext } from '../types.ts';
import type { EtfDataSource } from './data-source.ts';
import { etfJobs } from './jobs.ts';
import { EtfRepository } from './repository.ts';
import { registerEtfRoutes } from './routes.ts';
import { EtfService } from './service.ts';

export interface CreateEtfToolOptions {
  /** 测试注入替身数据源（服务端集成测试靠它验证降级路径） */
  source?: EtfDataSource;
  now?: () => number;
}

/**
 * ETF 汇总工具 —— 工具箱的第四个工具。
 *
 * 与前三个工具共享框架能力（三级降级、`freshness` 契约、调度器与 `job_run` 留痕），
 * 也共享东财数据源，但**增量在于把两个上游 join 起来**：
 * 行情（接口 A）+ 跟踪指数/分类（接口 B）+ 单只概况（接口 C）。
 */
export function createEtfTool(options: CreateEtfToolOptions = {}): ServerTool {
  let memo: { ctx: ToolContext; service: EtfService } | null = null;

  const serviceFor = (ctx: ToolContext): EtfService => {
    if (memo && memo.ctx === ctx) return memo.service;

    const service = new EtfService({
      db: ctx.db,
      repo: new EtfRepository(ctx.db),
      source: options.source ?? createEastmoneyDataSource(ctx.http),
      cache: ctx.cache,
      config: ctx.config,
      logger: ctx.logger,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    memo = { ctx, service };
    return service;
  };

  return {
    descriptor: TOOL_CATALOG.etf,
    async register(app: FastifyInstance, ctx: ToolContext): Promise<void> {
      registerEtfRoutes(app, ctx, serviceFor(ctx));
    },
    jobs(ctx: ToolContext): JobDefinition[] {
      return etfJobs(serviceFor(ctx));
    },
  };
}
