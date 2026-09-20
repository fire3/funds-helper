import { describe, expect, it } from 'vitest';
import type { FxBar } from './model.ts';
import {
  annualizedVolatility,
  convertBar,
  convertRate,
  dayChange,
  downsample,
  extremes,
  intervalChanges,
  shiftDate,
  sliceRange,
  yearlyStats,
} from './series.ts';

function bar(date: string, close: number, spread = 0.01): FxBar {
  return { date, open: close, low: close - spread, high: close + spread, close };
}

/** 从 startDate 起连续 days 天，收盘价由 close(index) 决定 */
function series(startDate: string, days: number, close: (index: number) => number): FxBar[] {
  return Array.from({ length: days }, (_, index) => bar(shiftDate(startDate, index), close(index)));
}

describe('shiftDate', () => {
  it('跨月与跨年', () => {
    expect(shiftDate('2026-09-18', -365)).toBe('2025-09-18');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDate('2024-02-28', 1)).toBe('2024-02-29');
  });
});

describe('方向换算', () => {
  it('CNY/USD 就是取倒数', () => {
    expect(convertRate(6.5, 'CNY/USD')).toBeCloseTo(0.15384615, 6);
    expect(convertRate(6.5, 'USD/CNY')).toBe(6.5);
  });

  it('取倒数必须同时互换 low/high（否则反向的高低带会错位）', () => {
    const converted = convertBar(bar('2026-09-18', 6.5, 0.2), 'CNY/USD');
    expect(converted.close).toBeCloseTo(1 / 6.5, 8);
    // 反向后的最低 = 1 / 原最高，最高 = 1 / 原最低
    expect(converted.low).toBeCloseTo(1 / 6.7, 8);
    expect(converted.high).toBeCloseTo(1 / 6.3, 8);
    expect(converted.low ?? 0).toBeLessThan(converted.high ?? 0);
  });

  it('missing 字段保持 null', () => {
    const converted = convertBar(
      { date: '2026-09-18', open: null, low: null, high: null, close: 6.5 },
      'CNY/USD',
    );
    expect(converted.open).toBeNull();
    expect(converted.high).toBeNull();
  });

  it('USD/CNY 原样返回，不做无谓的浮点运算', () => {
    const source = bar('2026-09-18', 6.5);
    expect(convertBar(source, 'USD/CNY')).toBe(source);
  });
});

describe('sliceRange', () => {
  const bars = series('2018-01-01', 3000, (index) => 6 + index * 0.0001);

  it('锚定最后一个交易日，而不是当前时间', () => {
    const last = bars.at(-1);
    const sliced = sliceRange(bars, '1y');
    expect(sliced.at(-1)?.date).toBe(last?.date);
    expect(sliced[0]?.date).toBe(shiftDate(last?.date ?? '', -365));
  });

  it('区间越短点数越少', () => {
    const one = sliceRange(bars, '1y').length;
    const three = sliceRange(bars, '3y').length;
    expect(one).toBeLessThan(three);
    expect(three).toBeLessThan(sliceRange(bars, 'all').length);
  });

  it('all 返回全量', () => {
    expect(sliceRange(bars, 'all')).toHaveLength(bars.length);
  });

  it('空序列返回空', () => {
    expect(sliceRange([], '1y')).toEqual([]);
  });
});

describe('downsample', () => {
  const bars = series('1994-08-30', 8000, (index) => 8 - index * 0.0002);

  it('把长序列抽到阈值以内，且保留首尾', () => {
    const sampled = downsample(bars, 1600);
    expect(sampled.length).toBeLessThanOrEqual(1601);
    expect(sampled.length).toBeGreaterThan(1500);
    expect(sampled[0]?.date).toBe(bars[0]?.date);
    expect(sampled.at(-1)?.date).toBe(bars.at(-1)?.date);
  });

  it('未超阈值时原样返回', () => {
    const short = bars.slice(0, 100);
    expect(downsample(short, 1600)).toHaveLength(100);
  });
});

describe('intervalChanges', () => {
  const bars = series('2018-01-01', 3000, (index) => 6 + index * 0.001);

  it('全部区间 = 首末收盘价之间的涨跌', () => {
    const all = intervalChanges(bars).find((item) => item.key === 'all');
    const first = bars[0]?.close ?? 0;
    const last = bars.at(-1)?.close ?? 0;
    expect(all?.from).toBe(bars[0]?.date);
    expect(all?.to).toBe(bars.at(-1)?.date);
    expect(all?.startRate).toBeCloseTo(first, 8);
    expect(all?.endRate).toBeCloseTo(last, 8);
    expect(all?.change).toBeCloseTo(last - first, 8);
    expect(all?.changePct).toBeCloseTo(((last - first) / first) * 100, 8);
  });

  it('年初至今从当年 1 月 1 日起算', () => {
    const ytd = intervalChanges(bars).find((item) => item.key === 'ytd');
    expect(ytd?.from).toBe(`${bars.at(-1)?.date.slice(0, 4)}-01-01`);
  });

  it('始终返回全部统计区间，形状稳定', () => {
    expect(intervalChanges(bars).map((item) => item.key)).toEqual([
      '1m',
      '3m',
      '6m',
      '1y',
      '3y',
      '5y',
      'ytd',
      'all',
    ]);
    // 数据不足时字段为 null，而不是少一行
    const short = intervalChanges(series('2026-09-01', 1, () => 7));
    expect(short).toHaveLength(8);
    expect(short.find((item) => item.key === '5y')?.changePct).toBeNull();
  });

  it('空序列返回空数组', () => {
    expect(intervalChanges([])).toEqual([]);
  });
});

describe('yearlyStats', () => {
  const bars = [
    bar('2025-12-31', 7.0),
    bar('2026-01-02', 7.1),
    bar('2026-06-30', 6.9),
    bar('2026-09-18', 7.2),
  ];

  it('按年分组并按年份升序', () => {
    const stats = yearlyStats(bars);
    expect(stats.map((item) => item.year)).toEqual(['2025', '2026']);
  });

  it('年内取首末收盘价、日内最高最低与收盘均值', () => {
    const stats = yearlyStats(bars);
    const y2026 = stats.find((item) => item.year === '2026');
    expect(y2026?.open).toBe(7.1);
    expect(y2026?.close).toBe(7.2);
    expect(y2026?.low).toBeCloseTo(6.89, 8);
    expect(y2026?.high).toBeCloseTo(7.21, 8);
    expect(y2026?.avg).toBeCloseTo((7.1 + 6.9 + 7.2) / 3, 8);
    expect(y2026?.changePct).toBeCloseTo(((7.2 - 7.1) / 7.1) * 100, 8);
  });
});

describe('extremes / dayChange', () => {
  const bars = [bar('2026-09-16', 7.3), bar('2026-09-17', 6.1), bar('2026-09-18', 6.5)];

  it('极值带日期，且按收盘价取', () => {
    const { high, low } = extremes(bars);
    expect(high).toEqual({ date: '2026-09-16', rate: 7.3 });
    expect(low).toEqual({ date: '2026-09-17', rate: 6.1 });
  });

  it('空序列的极值为 null', () => {
    expect(extremes([])).toEqual({ high: null, low: null });
  });

  it('日变动取最后两根', () => {
    const change = dayChange(bars);
    expect(change?.latest).toEqual({ date: '2026-09-18', rate: 6.5 });
    expect(change?.previous).toEqual({ date: '2026-09-17', rate: 6.1 });
    expect(change?.change).toBeCloseTo(0.4, 8);
    expect(change?.changePct).toBeCloseTo((0.4 / 6.1) * 100, 8);
  });

  it('只有一根时没有日变动', () => {
    expect(dayChange([bar('2026-09-18', 6.5)])).toBeNull();
    expect(dayChange([])).toBeNull();
  });
});

describe('annualizedVolatility', () => {
  it('恒定的汇率没有波动', () => {
    const bars = series('2025-09-18', 300, () => 7);
    expect(annualizedVolatility(bars)).toBe(0);
  });

  it('样本不足时返回 null（而不是给出误导性的数字）', () => {
    expect(annualizedVolatility(series('2026-09-01', 5, () => 7))).toBeNull();
    expect(annualizedVolatility([])).toBeNull();
  });

  it('按交易日计数，量级合理', () => {
    // 交替 ±0.5% 的日收益
    const bars = series('2025-09-18', 300, (index) => 7 * (index % 2 === 0 ? 1 : 0.995));
    const volatility = annualizedVolatility(bars);
    expect(volatility).not.toBeNull();
    expect(volatility ?? 0).toBeGreaterThan(5);
    expect(volatility ?? 0).toBeLessThan(15);
  });
});
