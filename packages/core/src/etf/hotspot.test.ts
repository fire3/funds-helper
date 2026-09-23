import { describe, expect, it } from 'vitest';
import {
  aggregateThemes,
  ETF_REVERSE_METRIC_LABELS,
  ETF_REVERSE_METRICS,
  ETF_WINDOW_LABELS,
  ETF_WINDOWS,
  type EtfHotspotRecord,
  reverseHotspots,
  themeSignal,
  windowReturn,
} from './hotspot.ts';
import type { EtfCategory } from './model.ts';

function record(overrides: Partial<EtfHotspotRecord> & { code: string }): EtfHotspotRecord {
  return {
    name: `ETF${overrides.code}`,
    indexName: null,
    category: '行业主题' as EtfCategory,
    scale: null,
    amount: null,
    premiumRate: null,
    maxDrawdown1y: null,
    mainInflow: null,
    sharesChangePct: null,
    change1w: null,
    change1m: null,
    change3m: null,
    ytdChange: null,
    ret6m: null,
    ret1y: null,
    ret3y: null,
    ...overrides,
  };
}

describe('窗口与取数口径', () => {
  it('7 个窗口都有中文标签（UI chips 直接用）', () => {
    expect(ETF_WINDOWS).toHaveLength(7);
    for (const window of ETF_WINDOWS) {
      expect(ETF_WINDOW_LABELS[window]).toBeTruthy();
    }
  });

  it('windowReturn 逐窗口取对字段', () => {
    const row = record({
      code: '1',
      change1w: 1,
      change1m: 2,
      change3m: 3,
      ret6m: 4,
      ytdChange: 5,
      ret1y: 6,
      ret3y: 7,
    });
    expect(ETF_WINDOWS.map((window) => windowReturn(row, window))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(windowReturn(record({ code: '2' }), '1y')).toBeNull();
  });
});

describe('aggregateThemes —— 自上而下聚合', () => {
  const A = record({
    code: '1',
    name: '半导体ETF甲',
    change1m: 10,
    ret1y: 20,
    amount: 100,
    scale: 1000,
    premiumRate: 1,
    maxDrawdown1y: -20,
    sharesChangePct: 5,
  });
  const B = record({
    code: '2',
    name: '半导体ETF乙',
    change1m: 20,
    ret1y: null, // 次新：无 1 年数据
    amount: 300,
    scale: 3000,
    premiumRate: 3,
    maxDrawdown1y: -10,
    sharesChangePct: null,
  });
  const C = record({
    code: '3',
    name: '医药ETF丙',
    category: '行业主题',
    change1m: -5,
    ret1y: -8,
    amount: 50,
    scale: 500,
  });

  it('按主题分组，等权均值跳过 null 并记录覆盖数', () => {
    const rows = aggregateThemes([A, B, C]);
    const semi = rows.find((row) => row.theme === '半导体/芯片');
    expect(semi).toBeDefined();
    expect(semi?.count).toBe(2);
    // 1月均值 = (10+20)/2 = 15（等权，不看成交额）
    expect(semi?.meanRet['1m']).toBeCloseTo(15);
    // 1年只有 A 有数据：均值 = 20，覆盖 1/2
    expect(semi?.meanRet['1y']).toBeCloseTo(20);
    expect(semi?.covered['1y']).toBe(1);
    expect(semi?.covered['1m']).toBe(2);
    // 全员无数据的窗口 → null（不是 0）
    expect(semi?.meanRet['3y']).toBeNull();
  });

  it('资金字段：成交额/规模合计，份额与回撤只对有数据的成员求均值', () => {
    const semi = aggregateThemes([A, B, C]).find((row) => row.theme === '半导体/芯片');
    expect(semi?.amount).toBe(400);
    expect(semi?.scale).toBe(4000);
    expect(semi?.amountSharePct).toBeCloseTo((400 / 450) * 100, 5);
    expect(semi?.meanPremium).toBeCloseTo(2);
    expect(semi?.meanDrawdown1y).toBeCloseTo(-15);
    expect(semi?.meanSharesChangePct).toBeCloseTo(5);
    // 医药没有份额/回撤数据 → null 而不是 0
    const med = aggregateThemes([A, B, C]).find((row) => row.theme === '医药医疗');
    expect(med?.meanSharesChangePct).toBeNull();
    expect(med?.meanDrawdown1y).toBeNull();
  });

  it('各窗口独立排名，只在有数据的主题之间比', () => {
    const semi = aggregateThemes([A, B, C]).find((row) => row.theme === '半导体/芯片');
    expect(semi?.ranks['1m']).toBe(1);
    expect(semi?.rankedCount['1m']).toBe(2);
    // 3y 全员无数据 → 无排名
    expect(semi?.ranks['3y']).toBeNull();
    expect(semi?.rankedCount['3y']).toBe(0);
  });
});

describe('themeSignal —— 轮动信号', () => {
  const row = (
    short: number | null,
    shortTotal: number,
    long: number | null,
    longTotal: number,
  ) => ({
    ranks: { '1m': short, '1y': long } as never,
    rankedCount: { '1m': shortTotal, '1y': longTotal } as never,
  });

  it('短长皆前 25% → 持续强势', () => {
    expect(themeSignal(row(2, 8, 2, 8) as never, '1m')).toBe('持续强势');
  });

  it('短强长弱（近1年后 50% 分位）→ 新热点', () => {
    expect(themeSignal(row(2, 8, 4, 8) as never, '1m')).toBe('新热点');
  });

  it('短弱长强 → 退潮', () => {
    expect(themeSignal(row(6, 8, 2, 8) as never, '1m')).toBe('退潮');
  });

  it('中间地带 → 震荡；任一窗口无数据 → 震荡（不伪装成强或弱）', () => {
    expect(themeSignal(row(3, 8, 3, 8) as never, '1m')).toBe('震荡');
    expect(themeSignal(row(null, 0, 2, 8) as never, '1m')).toBe('震荡');
    expect(themeSignal(row(2, 8, null, 0) as never, '1m')).toBe('震荡');
  });
});

describe('reverseHotspots —— 自下而上反查', () => {
  const records = [
    record({ code: '1', name: '半导体ETF甲', change1m: 30, amount: 100, mainInflow: 5_000_000 }),
    record({ code: '2', name: '半导体ETF乙', change1m: 25, amount: 90, mainInflow: 3_000_000 }),
    record({ code: '3', name: '半导体ETF丙', change1m: 22, amount: 80 }),
    record({ code: '4', name: '证券ETF丁', change1m: 20, amount: 500, mainInflow: -1_000_000 }),
    record({ code: '5', name: '医药ETF戊', change1m: 5, amount: 70 }),
    record({ code: '6', name: '军工ETF己', change1m: null, amount: null, mainInflow: null }),
  ];

  it('指标与标签一一对应（UI chips 直接用）', () => {
    expect(ETF_REVERSE_METRICS).toHaveLength(4);
    for (const metric of ETF_REVERSE_METRICS) {
      expect(ETF_REVERSE_METRIC_LABELS[metric]).toBeTruthy();
    }
  });

  it('涨幅 Top-3 反查：半导体命中 3 只（多点开花），组内按指标降序', () => {
    const groups = reverseHotspots(records, { metric: 'ret', window: '1m', k: 3 });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ theme: '半导体/芯片', hits: 3 });
    expect(groups[0]?.members.map((member) => member.code)).toEqual(['1', '2', '3']);
    expect(groups[0]?.headValue).toBe(30);
  });

  it('升序 = 看领跌方向（组序与组内都按升序）', () => {
    const groups = reverseHotspots(records, { metric: 'ret', window: '1m', dir: 'asc', k: 3 });
    expect(groups.flatMap((group) => group.members).map((member) => member.code)).toEqual([
      '5',
      '4',
      '3',
    ]);
  });

  it('命中数优先于指标值排序（3 只上榜 > 1 只第一）', () => {
    const groups = reverseHotspots(records, { metric: 'ret', window: '1m', k: 5 });
    expect(groups.map((group) => group.theme)).toEqual(['半导体/芯片', '证券', '医药医疗']);
    expect(groups.map((group) => group.hits)).toEqual([3, 1, 1]);
  });

  it('资金指标：主力净流入剔除 null（新浪渠道整列为 null 时是空榜，不是全 0）', () => {
    const groups = reverseHotspots(records, { metric: 'mainInflow', k: 10 });
    expect(groups.flatMap((group) => group.members).map((member) => member.code)).toEqual([
      '1',
      '2',
      '4',
    ]);
    expect(groups.flatMap((group) => group.members)).toHaveLength(3);
  });

  it('K 截断作用在 Top-K 之后再分组', () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      record({ code: `${index}`, name: '半导体ETF', change1m: 100 - index }),
    );
    const groups = reverseHotspots(many, { metric: 'ret', window: '1m', k: 10 });
    expect(groups[0]?.hits).toBe(10);
    expect(groups).toHaveLength(1);
  });
});
