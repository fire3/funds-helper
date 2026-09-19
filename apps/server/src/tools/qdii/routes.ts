import type { QdiiRefreshResponse } from '@funds-helper/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ToolContext } from '../types.ts';
import type { CaptureStats, QdiiService } from './service.ts';

function queryOf(request: FastifyRequest): Record<string, unknown> {
  const query: unknown = request.query ?? {};
  return typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
}

function flag(value: unknown): boolean {
  return value === '1' || value === 'true';
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function registerQdiiRoutes(
  app: FastifyInstance,
  ctx: ToolContext,
  service: QdiiService,
): void {
  /** 全量数据集：一次返回，筛选/排序全部在前端完成 */
  app.get('/dataset', async (request) => service.getDataset(flag(queryOf(request).refresh)));

  /** 单只基金详情：四类上游数据聚合，按 code 缓存 */
  app.get('/funds/:code', async (request) => {
    const params: unknown = request.params ?? {};
    const code = (params as { code?: string }).code ?? '';
    return service.getFundDetail(code, flag(queryOf(request).refresh));
  });

  /** 场内折溢价排行 */
  app.get('/premium', async (request) => service.getPremium(flag(queryOf(request).refresh)));

  /** 额度变更记录（本工具相对 qdii-helper 的增量能力） */
  app.get('/changes', async (request) => {
    const query = queryOf(request);
    return service.getChanges(
      clampInt(query.days, 30, 1, 365),
      clampInt(query.limit, 200, 1, 1000),
    );
  });

  /**
   * 手动触发一次快照抓取。
   * 走调度器而不是直接调 service：这样手动刷新同样留下 job_run 记录。
   */
  app.post('/refresh', async () => {
    const result = await ctx.jobs.execute('qdii.snapshot', 'manual');
    const stats = (result?.stats ?? {}) as Partial<CaptureStats>;

    const response: QdiiRefreshResponse = {
      ok: true,
      total: stats.total ?? 0,
      inserted: stats.inserted ?? 0,
      changed: stats.changed ?? 0,
      durationMs: stats.durationMs ?? 0,
      message:
        `已拉取 ${stats.total ?? 0} 只 QDII` +
        `（数据日期 ${stats.dataDate ?? '未知'}），` +
        `新增 ${stats.inserted ?? 0} 条快照，检测到 ${stats.changed ?? 0} 项额度变更`,
    };
    return response;
  });
}
