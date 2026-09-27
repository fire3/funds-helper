import type { IndexDefinition } from '@funds-helper/core';
import { type RawIndexBar, UpstreamError } from '@funds-helper/sources';
import type { IndexBarFetch, IndexLiveQuote, IndicesDataSource } from '../data-sources/indices.ts';

/**
 * 可注入的假指数数据源。
 *
 * 集成测试的关键路径（多源降级语义、幂等、部分失败可见、批量实时补齐）都靠它 ——
 * 真实上游（Yahoo 429 / 东财 503）不可控，不能拿来做测试断言。
 */
export interface FakeIndicesSource extends IndicesDataSource {
  /** 全局故障开关：'fetch' = 上游故障，'fetch:internal' = 非上游错误 */
  failures: Set<string>;
  /** 按指数键的故障开关（测「部分失败」：单个指数挂了不影响其余） */
  failCodes: Set<string>;
  calls: Record<string, number>;
  /** 每个指数的假日线；缺省时按 key 自动生成 */
  series: Map<string, RawIndexBar[]>;
}

function shiftDate(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** 生成确定性的日线序列（含 open/low/high，与 fx 假数据同构） */
export function indexBars(startDate: string, days: number, base: number): RawIndexBar[] {
  return Array.from({ length: days }, (_, index) => {
    const value = Number((base + Math.sin(index / 50) * (base * 0.05) + index * 0.01).toFixed(2));
    return {
      date: shiftDate(startDate, index),
      open: value,
      low: Number((value * 0.995).toFixed(2)),
      high: Number((value * 1.005).toFixed(2)),
      close: value,
    };
  });
}

/**
 * 默认序列：SPX 给约 10 年（3600 行，覆盖 1y/3y/5y 区间与年度统计），
 * 其余指数给 300 行 —— 概览只需要「最新 + 次新」两根，
 * 22 × 3600 行的假数据会让每次 captureAll 变慢而测试什么都没验证到。
 */
function defaultSeries(def: IndexDefinition): RawIndexBar[] {
  return def.key === 'SPX'
    ? indexBars('2015-01-01', 3600, 2000)
    : indexBars('2025-12-01', 300, 100 + def.key.length * 10);
}

export function createFakeIndicesSource(
  options: { series?: Map<string, RawIndexBar[]> } = {},
): FakeIndicesSource {
  const source: FakeIndicesSource = {
    name: 'fake',
    failures: new Set<string>(),
    failCodes: new Set<string>(),
    calls: {},
    series: options.series ?? new Map<string, RawIndexBar[]>(),

    async fetchBars(def): Promise<IndexBarFetch> {
      source.calls.fetch = (source.calls.fetch ?? 0) + 1;
      if (source.failures.has('fetch')) throw new UpstreamError('模拟：指数日线接口不可用');
      // 模拟「非上游」的内部错误：用于验证它不会被伪装成 503
      if (source.failures.has('fetch:internal')) throw new Error('模拟：底层数据库错误');
      if (source.failCodes.has(def.key)) {
        throw new UpstreamError(`模拟：${def.key} 单指数故障`);
      }

      let bars = source.series.get(def.key);
      if (bars === undefined) {
        bars = defaultSeries(def);
        source.series.set(def.key, bars);
      }
      // 与真实源一致：since 只影响增量；假数据直接回全量（upsert 幂等，语义相同）
      return { source: 'fake', bars, skippedRows: 0, currency: def.currency };
    },

    async fetchLiveQuotes(defs): Promise<IndexLiveQuote[]> {
      source.calls.liveQuotes = (source.calls.liveQuotes ?? 0) + 1;
      if (source.failures.has('live')) throw new UpstreamError('模拟：批量实时接口不可用');
      // 与真实东财一致：只覆盖有 em 代码的指数（em=null 的四个指数批量实时也补不了）
      return defs
        .filter((def) => def.em !== null)
        .map((def) => ({
          key: def.key,
          source: 'fake-live',
          price: 12345.67,
          open: 12300,
          high: 12400,
          low: 12200,
          prevClose: 12300,
          change: 45.67,
          changePct: 0.37,
        }));
    },
  };

  return source;
}
