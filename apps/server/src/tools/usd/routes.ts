import type { UsdRefreshResponse } from '@funds-helper/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ToolContext } from '../types.ts';
import type { UsdCaptureStats, UsdService } from './service.ts';

function queryOf(request: FastifyRequest): Record<string, unknown> {
  const query: unknown = request.query ?? {};
  return typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
}

function flag(value: unknown): boolean {
  return value === '1' || value === 'true';
}

export function registerUsdRoutes(
  app: FastifyInstance,
  ctx: ToolContext,
  service: UsdService,
): void {
  /** 全量数据集：一次返回，筛选/排序全部在前端完成 */
  app.get('/dataset', async (request) => service.getDataset(flag(queryOf(request).refresh)));

  /** 单只基金详情：通用区块 + 人民币份额对照，按 code 缓存 */
  app.get('/funds/:code', async (request) => {
    const params: unknown = request.params ?? {};
    const code = (params as { code?: string }).code ?? '';
    return service.getFundDetail(code, flag(queryOf(request).refresh));
  });

  /**
   * 手动触发一次快照抓取。
   * 走调度器而不是直接调 service：这样手动刷新同样留下 job_run 记录。
   */
  app.post('/refresh', async () => {
    const result = await ctx.jobs.execute('usd.snapshot', 'manual');
    const stats = (result?.stats ?? {}) as Partial<UsdCaptureStats>;

    const response: UsdRefreshResponse = {
      ok: true,
      total: stats.total ?? 0,
      inserted: stats.inserted ?? 0,
      changed: stats.changed ?? 0,
      durationMs: stats.durationMs ?? 0,
      message:
        `已拉取 ${stats.total ?? 0} 只美元份额` +
        `（数据日期 ${stats.dataDate ?? '未知'}），新增 ${stats.inserted ?? 0} 条快照`,
    };
    return response;
  });
}
