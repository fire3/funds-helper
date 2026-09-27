import {
  INDEX_DEFAULT_CODE,
  INDEX_DEFAULT_RANGE,
  INDEX_RANGE_KEYS,
  type IndexRangeKey,
} from '@funds-helper/core';
import type { IndexRefreshResponse } from '@funds-helper/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ToolContext } from '../types.ts';
import type { IndicesCaptureStats, IndicesService } from './service.ts';

function queryOf(request: FastifyRequest): Record<string, unknown> {
  const query: unknown = request.query ?? {};
  return typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
}

function flag(value: unknown): boolean {
  return value === '1' || value === 'true';
}

/** 同名参数只取第一个（`?range=a&range=b` 不该让行为不可预测） */
function first(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const [head] = value;
    return typeof head === 'string' ? head : undefined;
  }
  return undefined;
}

/**
 * 非法参数**回落默认值**而不是 400 —— 与 fx / QDII 的既有约定一致：
 * 分享链接里一个笔误不该变成错误页，而页面始终清晰展示当前选中的是哪个指数。
 * （service 对未知 code 也有同样兜底，这里只是第一道。）
 */
function parseRange(value: unknown): IndexRangeKey {
  const raw = first(value);
  return raw !== undefined && (INDEX_RANGE_KEYS as readonly string[]).includes(raw)
    ? (raw as IndexRangeKey)
    : INDEX_DEFAULT_RANGE;
}

export function registerIndicesRoutes(
  app: FastifyInstance,
  ctx: ToolContext,
  service: IndicesService,
): void {
  /** 全部指数的最新收盘与日涨跌（按地区分组），一次返回 */
  app.get('/overview', async (request) => {
    const query = queryOf(request);
    return service.getOverview(flag(query.refresh));
  });

  /** 单指数走势 + 区间涨跌 + 年度表现 + 概要 */
  app.get('/dataset', async (request) => {
    const query = queryOf(request);
    // 注册表键是大写：小写入参归一化（手写 URL / 直接 curl 也不该落到别的指数上）
    const raw = first(query.code) ?? INDEX_DEFAULT_CODE;
    return service.getDataset({
      code: raw.toUpperCase(),
      range: parseRange(query.range),
      force: flag(query.refresh),
    });
  });

  /**
   * 手动触发一次抓取。
   * 走调度器而不是直接调 service：这样手动刷新同样留下 job_run 记录。
   */
  app.post('/refresh', async () => {
    const result = await ctx.jobs.execute('indices.daily', 'manual');
    const stats = (result?.stats ?? {}) as Partial<IndicesCaptureStats>;

    const failed = stats.failed ?? [];
    const response: IndexRefreshResponse = {
      ok: failed.length === 0,
      indices: stats.indices ?? 0,
      bars: stats.bars ?? 0,
      inserted: stats.inserted ?? 0,
      dataDate: stats.dataDate ?? null,
      failed,
      durationMs: stats.durationMs ?? 0,
      message:
        `${stats.indices ?? 0} 个指数已更新，写入 ${stats.bars ?? 0} 行（新增 ${stats.inserted ?? 0} 行），` +
        `最新数据日期 ${stats.dataDate ?? '未知'}` +
        (failed.length > 0
          ? `；${failed.length} 个失败：${failed.map((item) => item.code).join(', ')}`
          : ''),
    };
    return response;
  });
}
