import { describe, expect, it } from 'vitest';
import {
  buildComparableNav,
  describeNavEvents,
  describeNavSummaryBasis,
  extractNavEvents,
  parseNavEvent,
  type RawNavPoint,
} from './nav.ts';

/** 159507 通信ETF广发的真实形态：2026-06-08 每份分拆 3 份 */
const splitPoints: RawNavPoint[] = [
  { date: '2026-06-03', nav: 3.1673, change: 4.13, unitMoney: null },
  { date: '2026-06-04', nav: 3.1711, change: 0.12, unitMoney: null },
  { date: '2026-06-05', nav: 3.1334, change: -1.19, unitMoney: null },
  {
    date: '2026-06-08',
    nav: 1.0103,
    change: -3.27,
    unitMoney: '拆分：每份基金份额分拆3.0份',
  },
  { date: '2026-06-09', nav: 1.0597, change: 4.89, unitMoney: null },
];

const splitAccumulated = [
  { date: '2026-06-03', nav: 3.1673 },
  { date: '2026-06-04', nav: 3.1711 },
  { date: '2026-06-05', nav: 3.1334 },
  { date: '2026-06-08', nav: 3.0309 },
  { date: '2026-06-09', nav: 3.1791 },
];

describe('parseNavEvent —— 上游 unitMoney 解析', () => {
  it('空串 / null 表示当天没有除权事件', () => {
    expect(parseNavEvent('2026-06-05', '')).toBeNull();
    expect(parseNavEvent('2026-06-05', null)).toBeNull();
    expect(parseNavEvent('2026-06-05', '   ')).toBeNull();
  });

  it('拆分文本解析出比例（159507 的原文）', () => {
    expect(parseNavEvent('2026-06-08', '拆分：每份基金份额分拆3.0份')).toMatchObject({
      kind: 'split',
      ratio: 3,
      amount: null,
    });
  });

  it('分红文本解析出每份派现金额', () => {
    expect(parseNavEvent('2026-06-08', '每份派现金0.0430元')).toMatchObject({
      kind: 'dividend',
      amount: 0.043,
      ratio: null,
    });
  });

  it('认不出的文本按 other 保留（不能静默丢掉一条影响可比性的记录）', () => {
    expect(parseNavEvent('2026-06-08', '其他权益调整')).toMatchObject({
      kind: 'other',
      ratio: null,
      amount: null,
    });
  });

  it('只取有事件的交易日', () => {
    const events = extractNavEvents(splitPoints);
    expect(events).toHaveLength(1);
    expect(events[0]?.date).toBe('2026-06-08');
  });
});

describe('buildComparableNav —— 区间统计的可比口径', () => {
  it('没有除权事件时原样返回单位净值', () => {
    const plain = splitPoints.filter((point) => point.unitMoney === null);
    const series = buildComparableNav(plain, []);
    expect(series.basis).toBe('unit');
    expect(series.points.map((point) => point.nav)).toEqual(plain.map((point) => point.nav));
  });

  it('有分拆时优先用上游累计净值（比值连续，不再是 -68%）', () => {
    const series = buildComparableNav(splitPoints, splitAccumulated);
    expect(series.basis).toBe('accumulated');
    const first = series.points[0];
    const last = series.points.at(-1);
    expect(first && last).toBeTruthy();
    // 单位净值首尾 1.0597/3.1673 = -66.5%；累计净值首尾 3.1791/3.1673 ≈ +0.37%
    expect((last!.nav / first!.nav - 1) * 100).toBeCloseTo(0.37, 1);
  });

  it('累计净值缺失/没做复权时，按拆分比例本地还原', () => {
    const series = buildComparableNav(splitPoints, []);
    expect(series.basis).toBe('split-adjusted');
    const first = series.points[0];
    const last = series.points.at(-1);
    expect(first?.nav).toBeCloseTo(3.1673 * 3, 4);
    expect(last?.nav).toBeCloseTo(1.0597, 4);
  });

  it('累计净值与单位净值完全相同（上游没复权）→ 不采用，退回本地还原', () => {
    const identical = splitPoints.map((point) => ({ date: point.date, nav: point.nav }));
    expect(buildComparableNav(splitPoints, identical).basis).toBe('split-adjusted');
  });

  it('累计净值日期对不齐（长度/日期不同）→ 退回本地还原', () => {
    const short = splitAccumulated.slice(0, 3);
    expect(buildComparableNav(splitPoints, short).basis).toBe('split-adjusted');
  });

  it('分红按「加回每份派现金额」近似', () => {
    const dividendPoints: RawNavPoint[] = [
      { date: '2026-09-01', nav: 1.5, change: 0, unitMoney: null },
      { date: '2026-09-10', nav: 1.46, change: 0.2, unitMoney: '每份派现金0.0430元' },
      { date: '2026-09-30', nav: 1.6, change: 1, unitMoney: null },
    ];
    const series = buildComparableNav(dividendPoints, []);
    expect(series.basis).toBe('split-adjusted');
    expect(series.points[0]?.nav).toBeCloseTo(1.543, 3);
  });
});

describe('describeNavEvents —— 卡片里的解释文案', () => {
  it('分拆解释给出比例、前后净值与真实涨跌，并明确「不是亏损」', () => {
    const [note] = describeNavEvents(splitPoints, extractNavEvents(splitPoints));
    expect(note?.title).toContain('份额分拆');
    expect(note?.title).toContain('3');
    expect(note?.text).toContain('拆分后持有份额'); // 份额变了
    expect(note?.text).toContain('3.1334');
    expect(note?.text).toContain('1.0103');
    expect(note?.text).toContain('-3.27%'); // 上游记录的真实涨跌
    expect(note?.text).toContain('不是亏损');
    expect(note?.text).toContain('复权口径');
  });

  it('分红解释说明跌掉的部分已发放', () => {
    const points: RawNavPoint[] = [
      { date: '2026-09-09', nav: 1.5, change: 0, unitMoney: null },
      { date: '2026-09-10', nav: 1.46, change: 0.2, unitMoney: '每份派现金0.0430元' },
    ];
    const [note] = describeNavEvents(points, extractNavEvents(points));
    expect(note?.title).toContain('分红');
    expect(note?.text).toContain('0.043');
    expect(note?.text).toContain('红利');
  });

  it('解释条数与事件数一一对应（服务端按索引合并 title/text）', () => {
    const notes = describeNavEvents(splitPoints, extractNavEvents(splitPoints));
    expect(notes).toHaveLength(1);
  });
});

describe('describeNavSummaryBasis', () => {
  it('可比序列无需说明口径', () => {
    expect(describeNavSummaryBasis('unit')).toBeNull();
  });

  it('用了累计净值 / 本地还原时说明口径差异', () => {
    expect(describeNavSummaryBasis('accumulated')).toContain('复权口径');
    expect(describeNavSummaryBasis('split-adjusted')).toContain('复权口径');
  });
});
