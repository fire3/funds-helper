import { describe, expect, it } from 'vitest';
import { buildAdvice, periodLabel, periodRank, summarizeNav } from './advice.ts';
import type { FundLimit } from './model.ts';
import { PurchaseStatus } from './model.ts';

function fund(overrides: Partial<FundLimit> = {}): FundLimit {
  return {
    code: '270042',
    name: '广发纳斯达克100ETF联接人民币(QDII)A',
    fundType: '指数型-海外股票',
    currency: 'CNY',
    status: PurchaseStatus.Limited,
    dailyLimit: 2,
    minPurchase: 2,
    nextOpenDate: null,
    redeemStatus: '开放赎回',
    nav: 8.1177,
    navDate: '09-11',
    fee: '0.13%',
    ...overrides,
  };
}

describe('periodLabel —— Y 是月、N 是年（反直觉，必须测）', () => {
  it('按上游枚举正确映射', () => {
    expect(periodLabel('Z')).toBe('近1周');
    expect(periodLabel('Y')).toBe('近1月');
    expect(periodLabel('3Y')).toBe('近3月');
    expect(periodLabel('6Y')).toBe('近6月');
    expect(periodLabel('1N')).toBe('近1年');
    expect(periodLabel('3N')).toBe('近3年');
    expect(periodLabel('JN')).toBe('今年来');
    expect(periodLabel('LN')).toBe('成立来');
  });

  it('未知键原样返回', () => {
    expect(periodLabel('XX')).toBe('XX');
  });

  it('排序权重覆盖全部已定义周期', () => {
    expect(periodRank('Z')).toBeLessThan(periodRank('LN'));
    expect(periodRank('unknown')).toBeGreaterThanOrEqual(periodRank('LN'));
  });
});

describe('summarizeNav —— 区间涨幅与最大回撤', () => {
  // 最后一个数据点 2026-09-30 → 近1月窗口 cutoff = 2026-08-31，四个点都落在窗口内
  const trend = [
    { date: '2026-09-01', nav: 100 },
    { date: '2026-09-10', nav: 120 }, // 阶段高点
    { date: '2026-09-20', nav: 90 }, // 相对高点回撤 -25%
    { date: '2026-09-30', nav: 110 },
  ];

  it('近1月涨幅按区间首尾计算', () => {
    const rows = summarizeNav(trend);
    const month = rows.find((r) => r.label === '近1月');
    expect(month?.returnPct).toBe(10); // 110/100 - 1
  });

  it('最大回撤取区间内相对最高点的最大跌幅（负值）', () => {
    const rows = summarizeNav(trend);
    const month = rows.find((r) => r.label === '近1月');
    expect(month?.maxDrawdownPct).toBe(-25); // 90/120 - 1
  });

  it('窗口外的数据点不参与计算', () => {
    const rows = summarizeNav([
      { date: '2025-01-01', nav: 50 },
      { date: '2026-09-30', nav: 110 },
    ]);
    // 近1月窗口内只有 1 个点 → null，而不是拿 2025 年的点算出 +120%
    expect(rows.find((r) => r.label === '近1月')?.returnPct).toBeNull();
  });

  it('数据点不足的区间返回 null 而非 0（避免误读为「无涨跌」）', () => {
    const rows = summarizeNav([{ date: '2026-09-30', nav: 1 }]);
    expect(rows.every((r) => r.returnPct === null)).toBe(true);
  });

  it('空走势不报错', () => {
    const rows = summarizeNav([]);
    expect(rows).toHaveLength(5);
    expect(rows[0]?.returnPct).toBeNull();
  });

  it('忽略非正净值（脏数据）', () => {
    const rows = summarizeNav([
      { date: '2026-09-01', nav: 100 },
      { date: '2026-09-15', nav: 0 },
      { date: '2026-09-30', nav: 110 },
    ]);
    expect(rows.find((r) => r.label === '近1月')?.returnPct).toBe(10);
  });
});

describe('buildAdvice', () => {
  it('额度极紧时给出警示', () => {
    const advice = buildAdvice({ fund: fund({ dailyLimit: 2 }) });
    const item = advice.find((a) => a.title.includes('额度极紧'));
    expect(item?.tone).toBe('warn');
    expect(item?.title).toContain('2 元');
  });

  it('限额为 0 时给出「暂停申购前兆」提示', () => {
    const advice = buildAdvice({ fund: fund({ dailyLimit: 0 }) });
    expect(advice.some((a) => a.title.includes('日限额为 0') && a.tone === 'warn')).toBe(true);
  });

  it('暂停申购优先提示不可买入', () => {
    const advice = buildAdvice({
      fund: fund({ status: PurchaseStatus.Suspended, dailyLimit: null }),
    });
    expect(advice[0]?.title).toBe('当前暂停申购');
    expect(advice[0]?.tone).toBe('warn');
  });

  it('场内交易提示溢价陷阱', () => {
    const advice = buildAdvice({
      fund: fund({ status: PurchaseStatus.OnExchange, dailyLimit: null }),
    });
    expect(advice.some((a) => a.text.includes('溢价'))).toBe(true);
  });

  it('开放申购且无限额时给出正面结论', () => {
    const advice = buildAdvice({
      fund: fund({ status: PurchaseStatus.Open, dailyLimit: null }),
    });
    expect(advice.some((a) => a.title === '开放申购且无限额' && a.tone === 'good')).toBe(true);
  });

  it('列出同基金其它份额类别', () => {
    const advice = buildAdvice({
      fund: fund(),
      siblings: [
        {
          code: '006479',
          name: '广发纳斯达克100ETF联接人民币(QDII)C',
          dailyLimit: 2,
          limitText: '2 元',
          status: PurchaseStatus.Limited,
        },
      ],
    });
    const item = advice.find((a) => a.title === '同基金其它份额类别');
    expect(item?.text).toContain('006479');
    expect(item?.text).toContain('2 元');
  });

  it('识别 A 类份额并说明成本结构', () => {
    const advice = buildAdvice({ fund: fund() });
    expect(advice.some((a) => a.title === 'A 类份额')).toBe(true);
  });

  it('识别 C 类份额', () => {
    const advice = buildAdvice({
      fund: fund({ name: '广发纳斯达克100ETF联接人民币(QDII)C' }),
    });
    expect(advice.some((a) => a.title === 'C 类份额')).toBe(true);
  });

  it('始终包含赎回费红线提醒', () => {
    const advice = buildAdvice({ fund: fund() });
    expect(advice.some((a) => a.title === '赎回费红线')).toBe(true);
  });

  it('有基金公司信息时补充发行方', () => {
    const advice = buildAdvice({ fund: fund(), company: '广发基金', rate: '0.13%' });
    expect(advice.some((a) => a.text.includes('广发基金'))).toBe(true);
  });
});
