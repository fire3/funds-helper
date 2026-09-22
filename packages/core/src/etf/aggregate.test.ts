import { describe, expect, it } from 'vitest';
import { aggregateEtfStats } from './aggregate.ts';
import type { EtfStatRecord } from './model.ts';

function record(overrides: Partial<EtfStatRecord> = {}): EtfStatRecord {
  return {
    code: '510300',
    name: '沪深300ETF华泰柏瑞',
    category: '宽基',
    market: '沪市',
    scale: 109_391_241_858,
    amount: 2_987_237_086,
    premiumRate: -0.06,
    changePct: 0.11,
    ...overrides,
  };
}

const COVERAGE = { spot: 3, profile: 5, unlisted: 2 };

describe('aggregateEtfStats', () => {
  it('合计规模与成交额（缺失值按 0 计）', () => {
    const stats = aggregateEtfStats(
      [
        record(),
        record({ code: '159915', category: '宽基', market: '深市', scale: null, amount: null }),
      ],
      COVERAGE,
    );
    expect(stats.total).toBe(2);
    expect(stats.totalScale).toBe(109_391_241_858);
    expect(stats.totalAmount).toBe(2_987_237_086);
  });

  it('分类分布按数量 + 规模合计，空分类不进面板', () => {
    const stats = aggregateEtfStats(
      [
        record(),
        record({ code: '159915', category: '宽基', scale: 67_147_934_154 }),
        record({ code: '513100', category: '跨境', scale: 18_955_760_435, premiumRate: 1.5 }),
        record({ code: '511990', category: '货币', scale: 96_725_100_000 }),
      ],
      COVERAGE,
    );

    expect(stats.byCategory.map((item) => item.category)).toEqual(['宽基', '跨境', '货币']);
    const broad = stats.byCategory.find((item) => item.category === '宽基');
    expect(broad).toMatchObject({ count: 2, scale: 109_391_241_858 + 67_147_934_154 });
    expect(stats.byCategory.some((item) => item.category === '债券')).toBe(false);
  });

  it('交易所分布', () => {
    const stats = aggregateEtfStats(
      [record(), record({ code: '159915', market: '深市', scale: 100 })],
      COVERAGE,
    );
    expect(stats.byMarket).toEqual([
      { market: '沪市', count: 1, scale: 109_391_241_858 },
      { market: '深市', count: 1, scale: 100 },
    ]);
  });

  it('折溢价分布与列表徽标同源（describePremium 判档）', () => {
    const stats = aggregateEtfStats(
      [
        record({ premiumRate: -0.06 }), // 平价
        record({ code: 'A', premiumRate: 0.43 }), // 溢价
        record({ code: 'B', premiumRate: 1.5 }), // 高溢价
        record({ code: 'C', premiumRate: -1.7 }), // 高折价
        record({ code: 'D', premiumRate: null }), // 未知
      ],
      COVERAGE,
    );

    expect(stats.premium.counts).toEqual({
      高溢价: 1,
      溢价: 1,
      平价: 1,
      折价: 0,
      高折价: 1,
    });
    expect(stats.premium.unknown).toBe(1);
    expect(stats.premium.maxPremium).toEqual({ code: 'B', name: '沪深300ETF华泰柏瑞', rate: 1.5 });
    expect(stats.premium.maxDiscount).toEqual({
      code: 'C',
      name: '沪深300ETF华泰柏瑞',
      rate: -1.7,
    });
  });

  it('全是折价时没有「最大溢价」榜单（不能把折价当溢价展示）', () => {
    const stats = aggregateEtfStats([record({ premiumRate: -0.5 })], COVERAGE);
    expect(stats.premium.maxPremium).toBeNull();
    expect(stats.premium.maxDiscount?.rate).toBe(-0.5);
  });

  it('极值：规模最大 / 成交最活跃 / 涨跌幅两端', () => {
    const stats = aggregateEtfStats(
      [
        record({ amount: 1 }),
        record({ code: '159915', name: '创业板ETF易方达', scale: 1, amount: 999, changePct: 3.52 }),
        record({ code: '513100', name: '纳指ETF国泰', scale: 2, amount: 1, changePct: -4.2 }),
      ],
      COVERAGE,
    );

    expect(stats.extremes.largest?.code).toBe('510300');
    expect(stats.extremes.mostActive?.code).toBe('159915');
    expect(stats.extremes.bestChange?.code).toBe('159915');
    expect(stats.extremes.worstChange?.code).toBe('513100');
  });

  it('无数据时极值为 null，覆盖率原样透传', () => {
    const stats = aggregateEtfStats([], { spot: 0, profile: 1675, unlisted: 1675 });
    expect(stats.total).toBe(0);
    expect(stats.totalScale).toBe(0);
    expect(stats.byCategory).toEqual([]);
    expect(stats.premium.maxPremium).toBeNull();
    expect(stats.extremes.largest).toBeNull();
    expect(stats.coverage).toEqual({ spot: 0, profile: 1675, unlisted: 1675 });
  });
});
