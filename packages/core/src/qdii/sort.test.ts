import { describe, expect, it } from 'vitest';
import type { FundLimit } from './model.ts';
import { PurchaseStatus } from './model.ts';
import { buildStats, computeLimitBands, STATUS_WEIGHT, sortFunds } from './sort.ts';

function fund(overrides: Partial<FundLimit> = {}): FundLimit {
  return {
    code: '000000',
    name: '测试基金',
    fundType: '指数型-海外股票',
    currency: 'CNY',
    status: PurchaseStatus.Limited,
    dailyLimit: 100,
    minPurchase: 10,
    nextOpenDate: null,
    redeemStatus: '开放赎回',
    nav: 1,
    navDate: '09-11',
    fee: '0.12%',
    ...overrides,
  };
}

describe('sortFunds', () => {
  it('可买优先：开放申购 → 限大额 → 暂停申购 → 场内交易', () => {
    const funds = [
      fund({ code: '000004', status: PurchaseStatus.OnExchange, dailyLimit: null }),
      fund({ code: '000003', status: PurchaseStatus.Suspended, dailyLimit: 50 }),
      fund({ code: '000002', status: PurchaseStatus.Limited, dailyLimit: 100 }),
      fund({ code: '000001', status: PurchaseStatus.Open, dailyLimit: null }),
    ];
    expect(sortFunds(funds, 'status').map((f) => f.code)).toEqual([
      '000001',
      '000002',
      '000003',
      '000004',
    ]);
  });

  it('额度从紧升序，无限额（null）恒排最后', () => {
    const funds = [
      fund({ code: 'c', dailyLimit: null }),
      fund({ code: 'a', dailyLimit: 2 }),
      fund({ code: 'b', dailyLimit: 10 }),
    ];
    expect(sortFunds(funds, 'limit-asc').map((f) => f.code)).toEqual(['a', 'b', 'c']);
  });

  it('额度从松降序，无限额（null）依然排最后', () => {
    const funds = [
      fund({ code: 'c', dailyLimit: null }),
      fund({ code: 'a', dailyLimit: 2 }),
      fund({ code: 'b', dailyLimit: 10 }),
    ];
    expect(sortFunds(funds, 'limit-desc').map((f) => f.code)).toEqual(['b', 'a', 'c']);
  });

  it('额度相同时按代码稳定排序', () => {
    const funds = [fund({ code: '000002' }), fund({ code: '000001' })];
    expect(sortFunds(funds, 'limit-asc').map((f) => f.code)).toEqual(['000001', '000002']);
  });

  it('不修改原数组', () => {
    const funds = [fund({ code: 'b', dailyLimit: 10 }), fund({ code: 'a', dailyLimit: 2 })];
    sortFunds(funds, 'limit-asc');
    expect(funds.map((f) => f.code)).toEqual(['b', 'a']);
  });

  it('状态权重覆盖全部枚举取值', () => {
    for (const status of Object.values(PurchaseStatus)) {
      expect(STATUS_WEIGHT[status]).toBeTypeOf('number');
    }
  });
});

describe('computeLimitBands —— 只统计人民币份额', () => {
  it('排除美元份额（渠道不售、常为 0，会把分布拉偏）', () => {
    const funds = [
      fund({ currency: 'CNY', status: PurchaseStatus.Limited, dailyLimit: 5 }),
      fund({ currency: 'USD', status: PurchaseStatus.Limited, dailyLimit: 5 }),
      fund({ currency: 'HKD', status: PurchaseStatus.Limited, dailyLimit: 5 }),
    ];
    const bands = computeLimitBands(funds);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ name: '限 10 元以内', count: 1 });
  });

  it('排除非「限大额」状态', () => {
    const funds = [
      fund({ status: PurchaseStatus.Open, dailyLimit: 5 }),
      fund({ status: PurchaseStatus.Suspended, dailyLimit: 5 }),
      fund({ status: PurchaseStatus.Limited, dailyLimit: 5 }),
      fund({ status: PurchaseStatus.Limited, dailyLimit: null }),
    ];
    expect(computeLimitBands(funds)).toEqual([
      { name: '限 10 元以内', low: 0, high: 10, count: 1 },
    ]);
  });

  it('档位边界归属正确', () => {
    const funds = [
      fund({ dailyLimit: 10 }), // 10 元以内
      fund({ dailyLimit: 10.01 }), // 100 元以内
      fund({ dailyLimit: 100 }), // 100 元以内
      fund({ dailyLimit: 1000000.01 }), // 100 万元以上
    ];
    const bands = computeLimitBands(funds);
    const byName = Object.fromEntries(bands.map((b) => [b.name, b.count]));
    expect(byName['限 10 元以内']).toBe(1);
    expect(byName['限 100 元以内']).toBe(2);
    expect(byName['限 100 万元以上']).toBe(1);
  });

  it('数量为 0 的档位不返回', () => {
    expect(computeLimitBands([fund({ dailyLimit: 5 })]).map((b) => b.name)).toEqual([
      '限 10 元以内',
    ]);
  });
});

describe('buildStats', () => {
  it('统计状态分布、可买数量与最紧正数限额', () => {
    const funds = [
      fund({ code: '1', status: PurchaseStatus.Open, dailyLimit: null }),
      fund({ code: '2', status: PurchaseStatus.Limited, dailyLimit: 100 }),
      fund({ code: '3', status: PurchaseStatus.Limited, dailyLimit: 2 }),
      fund({ code: '4', status: PurchaseStatus.Limited, dailyLimit: 0 }),
      fund({ code: '5', status: PurchaseStatus.Suspended, dailyLimit: 50 }),
    ];
    const stats = buildStats(funds);
    expect(stats.status[PurchaseStatus.Limited]).toBe(3);
    expect(stats.status[PurchaseStatus.Open]).toBe(1);
    expect(stats.status[PurchaseStatus.Suspended]).toBe(1);
    expect(stats.buyable).toBe(4); // 开放申购 + 限大额
    // 0 元档不参与「最紧」判定
    expect(stats.tightest).toBe(2);
  });

  it('没有正数限额时 tightest 为 null', () => {
    const stats = buildStats([fund({ status: PurchaseStatus.Limited, dailyLimit: 0 })]);
    expect(stats.tightest).toBeNull();
  });

  it('空输入不报错', () => {
    const stats = buildStats([]);
    expect(stats.buyable).toBe(0);
    expect(stats.tightest).toBeNull();
    expect(stats.limitBands).toEqual([]);
  });
});
