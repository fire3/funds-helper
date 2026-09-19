import type { UsdFundRecord } from '@funds-helper/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  facetCounts,
  filterFunds,
  fromSearchParams,
  refine,
  toggleValue,
  toSearchParams,
} from './filters.ts';

function fund(overrides: Partial<UsdFundRecord> = {}): UsdFundRecord {
  return {
    code: '011000',
    name: '嘉实美国成长股票美元现汇',
    fundType: 'QDII-普通股票',
    currency: 'USD',
    usdKind: '现汇',
    region: '美国',
    theme: '综合配置',
    status: '限大额',
    redeemStatus: '开放赎回',
    buyable: true,
    onExchange: false,
    dailyLimit: null,
    limitText: '渠道不适用',
    dailyLimitNote: '渠道不售',
    minPurchase: 10,
    minPurchaseText: '10.00 美元',
    nextOpenDate: null,
    nav: 1.23,
    navDate: '09-11',
    fee: '0.15%',
    capturedAt: '2026-09-14T10:00:00.000Z',
    dataDate: '2026-09-14',
    ...overrides,
  };
}

const SAMPLE: UsdFundRecord[] = [
  fund(),
  fund({
    code: '011002',
    name: '广发纳斯达克100ETF联接美元(QDII)A',
    usdKind: '未标注',
    region: '纳斯达克100',
    theme: '宽基指数',
    status: '开放申购',
  }),
  fund({
    code: '011003',
    name: '华夏恒生ETF联接美钞',
    usdKind: '现钞',
    region: '恒生指数/港股',
    theme: '宽基指数',
    status: '暂停申购',
    buyable: false,
  }),
];

describe('filterFunds', () => {
  it('默认只看可买（以状态为准）', () => {
    const result = filterFunds(SAMPLE, DEFAULT_FILTERS);
    expect(result.map((item) => item.code)).toEqual(['011000', '011002']);
  });

  it('份额形式维内取并集', () => {
    const result = filterFunds(SAMPLE, {
      ...DEFAULT_FILTERS,
      status: '全部',
      usdKinds: ['现汇', '现钞'],
    });
    expect(result.map((item) => item.code)).toEqual(['011000', '011003']);
  });

  it('维度间取交集：现汇 + 美国', () => {
    const result = filterFunds(SAMPLE, {
      ...DEFAULT_FILTERS,
      status: '全部',
      usdKinds: ['现汇'],
      regions: ['美国'],
    });
    expect(result.map((item) => item.code)).toEqual(['011000']);
  });

  it('关键字匹配代码或名称', () => {
    const result = filterFunds(SAMPLE, { ...DEFAULT_FILTERS, status: '全部', keyword: '011003' });
    expect(result.map((item) => item.code)).toEqual(['011003']);
  });
});

describe('refine', () => {
  it('可买优先：开放申购排在限大额之前', () => {
    const result = refine(SAMPLE, { ...DEFAULT_FILTERS, status: '全部' });
    expect(result[0]?.code).toBe('011002');
  });
});

describe('facetCounts', () => {
  it('地区计数随其它条件变化', () => {
    const counts = facetCounts(SAMPLE, DEFAULT_FILTERS, 'region');
    expect(counts.get('纳斯达克100')).toBe(1);
    // 暂停申购的恒生份额不可买，默认口径下不应计入
    expect(counts.get('恒生指数/港股')).toBeUndefined();
  });
});

describe('URL 双向同步', () => {
  it('解出多选维度', () => {
    const params = new URLSearchParams('kind=现汇&kind=现钞&region=美国&status=全部&q=纳指');
    const filters = fromSearchParams(params);
    expect(filters.usdKinds).toEqual(['现汇', '现钞']);
    expect(filters.regions).toEqual(['美国']);
    expect(filters.status).toBe('全部');
    expect(filters.keyword).toBe('纳指');
  });

  it('只写入与默认不同的项', () => {
    const params = toSearchParams(DEFAULT_FILTERS);
    expect(params.toString()).toBe('');
    const nonDefault = toSearchParams({ ...DEFAULT_FILTERS, status: '全部', usdKinds: ['现汇'] });
    expect(nonDefault.getAll('kind')).toEqual(['现汇']);
    expect(nonDefault.get('status')).toBe('全部');
  });
});

describe('toggleValue', () => {
  it('未选中则加入，已选中则移除', () => {
    expect(toggleValue([], '现汇')).toEqual(['现汇']);
    expect(toggleValue(['现汇', '现钞'], '现汇')).toEqual(['现钞']);
  });
});
