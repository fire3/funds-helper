import {
  FX_DEFAULT_RANGE,
  FX_DIRECTIONS,
  FX_RANGE_KEYS,
  type FxDirection,
  type FxRangeKey,
} from '@funds-helper/core';
import type { FxRefreshResponse } from '@funds-helper/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ToolContext } from '../types.ts';
import type { FxCaptureStats, FxService } from './service.ts';

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
 * 非法参数**回落默认值**而不是 400 —— 与 QDII / 美元份额的 `clampInt` 一致：
 * 分享链接里一个笔误不该变成错误页，而默认值总是安全的。
 */
function parseRange(value: unknown): FxRangeKey {
  const raw = first(value);
  return raw !== undefined && (FX_RANGE_KEYS as readonly string[]).includes(raw)
    ? (raw as FxRangeKey)
    : FX_DEFAULT_RANGE;
}

function parseDirection(value: unknown): FxDirection {
  return first(value) === FX_DIRECTIONS.CnyUsd ? FX_DIRECTIONS.CnyUsd : FX_DIRECTIONS.UsdCny;
}

export function registerFxRoutes(app: FastifyInstance, ctx: ToolContext, service: FxService): void {
  /** 走势点 + 区间涨跌 + 年度表现 + 概要，一次返回 */
  app.get('/dataset', async (request) => {
    const query = queryOf(request);
    return service.getDataset({
      range: parseRange(query.range),
      direction: parseDirection(query.direction),
      force: flag(query.refresh),
    });
  });

  /**
   * 手动触发一次抓取。
   * 走调度器而不是直接调 service：这样手动刷新同样留下 job_run 记录。
   */
  app.post('/refresh', async () => {
    const result = await ctx.jobs.execute('fx.daily', 'manual');
    const stats = (result?.stats ?? {}) as Partial<FxCaptureStats>;

    const response: FxRefreshResponse = {
      ok: true,
      bars: stats.bars ?? 0,
      inserted: stats.inserted ?? 0,
      dataDate: stats.dataDate ?? null,
      durationMs: stats.durationMs ?? 0,
      message:
        `已拉取 ${stats.bars ?? 0} 根汇率日线` +
        `（最新数据日期 ${stats.dataDate ?? '未知'}），新增 ${stats.inserted ?? 0} 条`,
    };
    return response;
  });
}
