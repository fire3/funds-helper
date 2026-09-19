import { describe, expect, it } from 'vitest';
import { diffFundLimits } from './changes.ts';
import type { FundLimit } from './model.ts';
import { PurchaseStatus } from './model.ts';

function fund(overrides: Partial<FundLimit> = {}): FundLimit {
  return {
    code: '270042',
    name: '广发纳斯达克100ETF联接人民币(QDII)A',
    fundType: '指数型-海外股票',
    currency: 'CNY',
    status: PurchaseStatus.Limited,
    dailyLimit: 100,
    minPurchase: 10,
    nextOpenDate: null,
    redeemStatus: '开放赎回',
    nav: 1,
    navDate: '09-11',
    fee: '0.13%',
    ...overrides,
  };
}

describe('diffFundLimits —— 首次落库只建基线', () => {
  it('没有上一次快照时不产生任何变更事件', () => {
    expect(diffFundLimits([], [fund()])).toEqual([]);
  });
});

describe('diffFundLimits —— 额度变更', () => {
  it('限额变小判为收紧', () => {
    const changes = diffFundLimits([fund({ dailyLimit: 100 })], [fund({ dailyLimit: 2 })]);
    const limit = changes.find((c) => c.field === 'daily_limit');
    expect(limit).toMatchObject({
      code: '270042',
      oldValue: '100',
      newValue: '2',
      direction: 'tightened',
    });
    expect(limit?.ratio).toBeCloseTo(-0.98, 4);
  });

  it('限额变大判为放宽', () => {
    const changes = diffFundLimits([fund({ dailyLimit: 2 })], [fund({ dailyLimit: 1000 })]);
    expect(changes.find((c) => c.field === 'daily_limit')?.direction).toBe('loosened');
  });

  it('从有限额变为无限额 → 放宽（null 视为无穷大）', () => {
    const changes = diffFundLimits([fund({ dailyLimit: 100 })], [fund({ dailyLimit: null })]);
    const limit = changes.find((c) => c.field === 'daily_limit');
    expect(limit?.direction).toBe('loosened');
    expect(limit?.newValue).toBeNull();
    expect(limit?.ratio).toBeNull(); // 相对幅度对无穷大无意义
  });

  it('从无限额变为有限额 → 收紧', () => {
    const changes = diffFundLimits([fund({ dailyLimit: null })], [fund({ dailyLimit: 100 })]);
    expect(changes.find((c) => c.field === 'daily_limit')?.direction).toBe('tightened');
  });

  it('额度不变则不产生事件（避免噪声）', () => {
    expect(diffFundLimits([fund({ dailyLimit: 100 })], [fund({ dailyLimit: 100 })])).toEqual([]);
  });
});

describe('diffFundLimits —— 状态变更', () => {
  it('暂停申购 → 开放申购 判为放宽', () => {
    const changes = diffFundLimits(
      [fund({ status: PurchaseStatus.Suspended })],
      [fund({ status: PurchaseStatus.Open })],
    );
    const status = changes.find((c) => c.field === 'status');
    expect(status).toMatchObject({
      oldValue: '暂停申购',
      newValue: '开放申购',
      direction: 'loosened',
    });
  });

  it('限大额 → 暂停申购 判为收紧', () => {
    const changes = diffFundLimits(
      [fund({ status: PurchaseStatus.Limited })],
      [fund({ status: PurchaseStatus.Suspended })],
    );
    expect(changes.find((c) => c.field === 'status')?.direction).toBe('tightened');
  });

  it('赎回状态恶化判为收紧', () => {
    const changes = diffFundLimits(
      [fund({ redeemStatus: '开放赎回' })],
      [fund({ redeemStatus: '暂停赎回' })],
    );
    expect(changes.find((c) => c.field === 'redeem_status')?.direction).toBe('tightened');
  });
});

describe('diffFundLimits —— 起点与新增基金', () => {
  it('申购起点提高判为收紧', () => {
    const changes = diffFundLimits([fund({ minPurchase: 10 })], [fund({ minPurchase: 100 })]);
    const min = changes.find((c) => c.field === 'min_purchase');
    expect(min?.direction).toBe('tightened');
    expect(min?.ratio).toBeCloseTo(9, 4);
  });

  it('新出现的基金不产生变更事件', () => {
    const previous = [fund({ code: '000001' })];
    const current = [fund({ code: '000001' }), fund({ code: '000002' })];
    expect(diffFundLimits(previous, current)).toEqual([]);
  });

  it('多个字段同时变化时各产生一条事件', () => {
    const changes = diffFundLimits(
      [fund({ dailyLimit: 100, status: PurchaseStatus.Open, minPurchase: 10 })],
      [fund({ dailyLimit: 2, status: PurchaseStatus.Limited, minPurchase: 100 })],
    );
    expect(changes.map((c) => c.field).sort()).toEqual(['daily_limit', 'min_purchase', 'status']);
  });
});
