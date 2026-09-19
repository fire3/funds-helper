import { describe, expect, it } from 'vitest';
import type { RawFundRow } from '../fund/model.ts';
import { buildFundLimit } from '../fund/normalize.ts';
import { describeUsdLimit, isChannelNotSold } from './limit.ts';

function row(overrides: Partial<RawFundRow> = {}): RawFundRow {
  return {
    code: '011000',
    name: '嘉实美国成长股票美元现汇',
    fundType: 'QDII-普通股票',
    nav: '1.2345',
    navDate: '09-11',
    purchaseStatus: '限大额',
    redeemStatus: '开放赎回',
    nextOpenDate: null,
    minPurchase: '10.0',
    dailyLimit: '0',
    fee: '0.15%',
    ...overrides,
  };
}

describe('isChannelNotSold —— 区分「渠道不售的 0」与「真无限额」', () => {
  it('原始值为 0 且归一化后为 null → 渠道不售', () => {
    const r = row({ dailyLimit: '0' });
    expect(isChannelNotSold(buildFundLimit(r), r.dailyLimit)).toBe(true);
  });

  it('哨兵值（真无限额）→ 不是渠道不售', () => {
    const r = row({ purchaseStatus: '开放申购', dailyLimit: '100000000000' });
    expect(isChannelNotSold(buildFundLimit(r), r.dailyLimit)).toBe(false);
  });

  it('场内交易 / 暂停申购的 0 不算渠道不售', () => {
    const exchange = row({ purchaseStatus: '场内交易', redeemStatus: '场内交易', dailyLimit: '0' });
    expect(isChannelNotSold(buildFundLimit(exchange), exchange.dailyLimit)).toBe(false);
    const suspended = row({ purchaseStatus: '暂停申购', dailyLimit: '0' });
    expect(isChannelNotSold(buildFundLimit(suspended), suspended.dailyLimit)).toBe(false);
  });
});

describe('describeUsdLimit', () => {
  it('渠道不售：标注「渠道不适用」而不是「无限额」', () => {
    const r = row({ dailyLimit: '0' });
    const info = describeUsdLimit(buildFundLimit(r), true);
    expect(info.text).toBe('渠道不适用');
    expect(info.note).toContain('银行');
  });

  it('真无限额展示「无限额」', () => {
    const r = row({ purchaseStatus: '开放申购', dailyLimit: '100000000000' });
    expect(describeUsdLimit(buildFundLimit(r), false).text).toBe('无限额');
  });

  it('存在真实正数限额时按美元展示', () => {
    const r = row({ dailyLimit: '5000' });
    expect(describeUsdLimit(buildFundLimit(r), false).text).toBe('5,000.00 美元');
  });

  it('暂停申购 / 场内交易优先于额度展示', () => {
    const suspended = row({ purchaseStatus: '暂停申购', dailyLimit: '100.0' });
    expect(describeUsdLimit(buildFundLimit(suspended), false).text).toBe('暂停申购');

    const exchange = row({ purchaseStatus: '场内交易', redeemStatus: '场内交易', dailyLimit: '0' });
    expect(describeUsdLimit(buildFundLimit(exchange), false).text).toBe('场内交易');
  });
});
