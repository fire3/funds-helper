import { TOOL_CATALOG } from '@funds-helper/shared';
import type { FastifyInstance } from 'fastify';
import { createEastmoneyDataSource } from '../../data-sources/eastmoney.ts';
import type { JobDefinition, ServerTool, ToolContext } from '../types.ts';
import type { UsdDataSource } from './data-source.ts';
import { usdJobs } from './jobs.ts';
import { UsdRepository } from './repository.ts';
import { registerUsdRoutes } from './routes.ts';
import { UsdService } from './service.ts';

export interface CreateUsdToolOptions {
  /** 测试注入替身数据源（服务端集成测试靠它验证降级路径） */
  source?: UsdDataSource;
  now?: () => number;
}

/**
 * 美元份额工具 —— 工具箱的第二个工具，验证「新增工具 = 切片 + 注册一行」的扩展性。
 *
 * 与 QDII 工具共享：东财数据源（`../../data-sources/eastmoney.ts`）、
 * 详情区块聚合（`../../fund-detail/sections.ts`）、通用领域逻辑（`@funds-helper/core`）。
 */
export function createUsdTool(options: CreateUsdToolOptions = {}): ServerTool {
  let memo: { ctx: ToolContext; service: UsdService } | null = null;

  const serviceFor = (ctx: ToolContext): UsdService => {
    if (memo && memo.ctx === ctx) return memo.service;

    const service = new UsdService({
      db: ctx.db,
      repo: new UsdRepository(ctx.db),
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
    descriptor: TOOL_CATALOG.usd,
    async register(app: FastifyInstance, ctx: ToolContext): Promise<void> {
      registerUsdRoutes(app, ctx, serviceFor(ctx));
    },
    jobs(ctx: ToolContext): JobDefinition[] {
      return usdJobs(serviceFor(ctx));
    },
  };
}
