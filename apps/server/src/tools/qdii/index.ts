import { TOOL_CATALOG } from '@funds-helper/shared';
import type { FastifyInstance } from 'fastify';
import type { JobDefinition, ServerTool, ToolContext } from '../types.ts';
import { createEastmoneyDataSource, type QdiiDataSource } from './data-source.ts';
import { qdiiJobs } from './jobs.ts';
import { QdiiRepository } from './repository.ts';
import { registerQdiiRoutes } from './routes.ts';
import { QdiiService } from './service.ts';

export interface CreateQdiiToolOptions {
  /** 测试注入替身数据源（服务端集成测试靠它验证降级路径） */
  source?: QdiiDataSource;
  now?: () => number;
}

/**
 * QDII 额度工具 —— 工具箱的第一个工具。
 *
 * 这个文件是「新增工具」的样板：实现 ServerTool 契约 + 在 registry 注册一行，
 * 不需要改动任何框架代码。
 */
export function createQdiiTool(options: CreateQdiiToolOptions = {}): ServerTool {
  let memo: { ctx: ToolContext; service: QdiiService } | null = null;

  const serviceFor = (ctx: ToolContext): QdiiService => {
    if (memo && memo.ctx === ctx) return memo.service;

    const service = new QdiiService({
      db: ctx.db,
      repo: new QdiiRepository(ctx.db),
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
    descriptor: TOOL_CATALOG.qdii,
    async register(app: FastifyInstance, ctx: ToolContext): Promise<void> {
      registerQdiiRoutes(app, ctx, serviceFor(ctx));
    },
    jobs(ctx: ToolContext): JobDefinition[] {
      return qdiiJobs(serviceFor(ctx));
    },
  };
}
