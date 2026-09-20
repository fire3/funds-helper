import { type FxDailySeries, type RawFxDailyBar, UpstreamError } from '@funds-helper/sources';
import type { FxDataSource } from '../tools/fx/data-source.ts';

/**
 * 可注入的假汇率数据源。
 *
 * 服务端集成测试的关键路径（上游故障时的降级、方向换算、幂等）都靠它 ——
 * 真实上游不可控，不能拿来做测试断言。
 */
export interface FakeFxSource extends FxDataSource {
  bars: RawFxDailyBar[];
  skippedRows: number;
  /** 让接口抛错：'daily' = 上游故障，'daily:internal' = 非上游错误 */
  failures: Set<string>;
  calls: Record<string, number>;
}

function shiftDate(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** 生成确定性的日线序列（含 open/low/high，便于验证方向换算） */
export function dailySeries(
  startDate: string,
  days: number,
  close: (index: number) => number,
): RawFxDailyBar[] {
  return Array.from({ length: days }, (_, index) => {
    const value = Number(close(index).toFixed(4));
    return {
      date: shiftDate(startDate, index),
      open: value,
      low: Number((value - 0.01).toFixed(4)),
      high: Number((value + 0.01).toFixed(4)),
      close: value,
    };
  });
}

/** 约 10 年（3600 个交易日），足以覆盖 1y/3y/5y 区间与年度统计 */
export function fxBars(): RawFxDailyBar[] {
  return dailySeries('2015-01-01', 3600, (index) => 6.5 + Math.sin(index / 50) * 0.4);
}

export function createFakeFxSource(options: { bars?: RawFxDailyBar[] } = {}): FakeFxSource {
  const source: FakeFxSource = {
    name: 'fake',
    symbol: 'fx_fake',
    bars: options.bars ?? fxBars(),
    skippedRows: 0,
    failures: new Set<string>(),
    calls: {},

    async fetchDailySeries(): Promise<FxDailySeries> {
      source.calls.daily = (source.calls.daily ?? 0) + 1;
      if (source.failures.has('daily')) throw new UpstreamError('模拟：汇率日线接口不可用');
      // 模拟「非上游」的内部错误（如数据库 schema 漂移）：用于验证它不会被伪装成 503
      if (source.failures.has('daily:internal')) throw new Error('模拟：底层数据库错误');
      return { symbol: source.symbol, bars: source.bars, skippedRows: source.skippedRows };
    },
  };

  return source;
}
