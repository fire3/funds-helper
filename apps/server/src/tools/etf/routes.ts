import type { EtfRefreshResponse } from '@funds-helper/shared';
import { ETF_SPOT_SOURCES } from '@funds-helper/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ToolContext } from '../types.ts';
import type { EtfCaptureStats, EtfService } from './service.ts';

function queryOf(request: FastifyRequest): Record<string, unknown> {
  const query: unknown = request.query ?? {};
  return typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
}

function flag(value: unknown): boolean {
  return value === '1' || value === 'true';
}

export function registerEtfRoutes(
  app: FastifyInstance,
  ctx: ToolContext,
  service: EtfService,
): void {
  /** 全量数据集（行情 + 目录 + 统计）：一次返回，筛选/排序全部在前端完成 */
  app.get('/dataset', async (request) => service.getDataset(flag(queryOf(request).refresh)));

  /** 单只 ETF 详情：接口 C + 通用区块，按 code 缓存 */
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
    const result = await ctx.jobs.execute('etf.snapshot', 'manual');
    const stats = (result?.stats ?? {}) as Partial<EtfCaptureStats>;
    // stats 理论上一定带 source；缺失时按默认渠道兜底（不要让响应少一个必填字段）
    const source = stats.source ?? 'sina';
    const channel = ETF_SPOT_SOURCES[source];

    const response: EtfRefreshResponse = {
      ok: true,
      source,
      spot: stats.spot ?? 0,
      profile: stats.profile ?? 0,
      inserted: stats.inserted ?? 0,
      dataDate: stats.dataDate ?? null,
      durationMs: stats.durationMs ?? 0,
      message:
        `已通过「${channel.name}」拉取 ${stats.spot ?? 0} 只 ETF 行情` +
        `（数据日期 ${stats.dataDate ?? '未知'}）` +
        (channel.missing.length > 0 ? `，该渠道不含${channel.missing.join('、')}` : '') +
        `、${stats.profile ?? 0} 条目录` +
        (stats.profileError === undefined ? '' : `（目录失败：${stats.profileError}）`),
    };
    return response;
  });
}
