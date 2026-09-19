import type { FundRecord } from '@funds-helper/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  facetCounts,
  filterFunds,
  fromSearchParams,
  type QdiiFilters,
  refine,
  toggleValue,
  toSearchParams,
} from './filters.ts';

function fund(overrides: Partial<FundRecord> = {}): FundRecord {
  return {
    code: '270042',
    name: '广发纳斯达克100ETF联接人民币(QDII)A',
    fundType: '指数型-海外股票',
    currency: 'CNY',
    region: '纳斯达克100',
    theme: '宽基指数',
    status: '限大额',
    redeemStatus: '开放赎回',
    dailyLimit: 2,
    limitText: '2 元',
    minPurchase: 2,
    minPurchaseText: '2 元',
    nextOpenDate: null,
    nav: 8.1177,
    navDate: '09-11',
    fee: '0.13%',
    onExchange: false,
    buyable: true,
    capturedAt: '2026-09-14T02:00:00.000Z',
    dataDate: '2026-09-14',
    ...overrides,
  };
}

function filters(overrides: Partial<QdiiFilters> = {}): QdiiFilters {
  return { ...DEFAULT_FILTERS, ...overrides };
}

const SAMPLE: FundRecord[] = [
  fund(),
  fund({
    code: '000834',
    name: '大成纳斯达克100ETF联接(QDII)A',
    dailyLimit: 10,
    limitText: '10 元',
  }),
  fund({
    code: '050025',
    name: '博时标普500ETF联接A',
    region: '标普500',
    status: '暂停申购',
    buyable: false,
    dailyLimit: 100,
  }),
  fund({
    code: '015641',
    name: '华夏全球股票(QDII)(人民币)',
    region: '全球',
    status: '开放申购',
    dailyLimit: null,
    limitText: '无限额',
  }),
  fund({
    code: '513100',
    name: '纳指ETF国泰',
    region: '纳斯达克',
    status: '场内交易',
    redeemStatus: '场内交易',
    buyable: false,
    onExchange: true,
    dailyLimit: null,
  }),
  fund({
    code: '006282',
    name: '某美元份额基金',
    currency: 'USD',
    region: '美国',
    status: '限大额',
    dailyLimit: null,
  }),
];

describe('默认筛选', () => {
  it('默认只看可买（开放申购 + 限大额）', () => {
    const result = filterFunds(SAMPLE, filters());
    expect(result.map((item) => item.code).sort()).toEqual(['000834', '015641', '270042']);
  });

  it('默认只看人民币份额（屏蔽美元份额的 0 值噪声）', () => {
    const result = filterFunds(SAMPLE, filters({ status: '全部' }));
    expect(result.map((item) => item.code)).not.toContain('006282');
  });
});

describe('双维度筛选 —— 维内 OR、维度间 AND', () => {
  it('地区维内取并集', () => {
    const result = filterFunds(SAMPLE, filters({ regions: ['纳斯达克100'] }));
    expect(result.map((item) => item.code).sort()).toEqual(['000834', '270042']);
  });

  it('两个地区取并集', () => {
    const result = filterFunds(
      SAMPLE,
      filters({ regions: ['纳斯达克100', '标普500'], status: '全部' }),
    );
    expect(result.map((item) => item.code).sort()).toEqual(['000834', '050025', '270042']);
  });

  it('地区与主题之间取交集', () => {
    const result = filterFunds(SAMPLE, filters({ regions: ['纳斯达克100'], themes: ['宽基指数'] }));
    expect(result).toHaveLength(2);

    const none = filterFunds(SAMPLE, filters({ regions: ['纳斯达克100'], themes: ['半导体'] }));
    expect(none).toEqual([]);
  });
});

describe('额度档位', () => {
  it('≤10 元只保留限额不超过 10 的', () => {
    const result = filterFunds(SAMPLE, filters({ status: '全部', band: '10' }));
    expect(result.map((item) => item.code).sort()).toEqual(['000834', '270042']);
  });

  it('无限额不满足任何有上限的档位', () => {
    const result = filterFunds(SAMPLE, filters({ status: '全部', band: '1000000' }));
    expect(result.map((item) => item.code)).not.toContain('015641');
  });

  it('「不限」不施加额度约束', () => {
    const result = filterFunds(SAMPLE, filters({ status: '全部', band: 'INF' }));
    expect(result.map((item) => item.code)).toContain('015641');
  });
});

describe('状态筛选', () => {
  it('可买 = 开放申购 + 限大额', () => {
    const result = filterFunds(SAMPLE, filters({ status: '可买', currency: 'ALL' }));
    expect(result.map((item) => item.code).sort()).toEqual([
      '000834',
      '006282',
      '015641',
      '270042',
    ]);
  });

  it('单选具体状态', () => {
    const result = filterFunds(SAMPLE, filters({ status: '暂停申购', currency: 'ALL' }));
    expect(result.map((item) => item.code)).toEqual(['050025']);
  });

  it('全部不施加状态约束', () => {
    expect(filterFunds(SAMPLE, filters({ status: '全部', currency: 'ALL' }))).toHaveLength(6);
  });
});

describe('搜索', () => {
  it('按代码或名称匹配', () => {
    expect(
      filterFunds(SAMPLE, filters({ status: '全部', currency: 'ALL', keyword: '270042' })),
    ).toHaveLength(1);
    expect(
      filterFunds(SAMPLE, filters({ status: '全部', currency: 'ALL', keyword: '纳斯达克100' })),
    ).toHaveLength(2);
  });

  it('大小写不敏感', () => {
    const result = filterFunds(
      SAMPLE,
      filters({ status: '全部', currency: 'ALL', keyword: 'etf' }),
    );
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('排序', () => {
  it('可买优先：开放申购排在限大额之前', () => {
    const result = refine(SAMPLE, filters({ status: '全部', currency: 'ALL', sort: 'status' }));
    const codes = result.map((item) => item.code);
    expect(codes.indexOf('015641')).toBeLessThan(codes.indexOf('270042'));
  });

  it('额度从紧升序，无限额排最后', () => {
    const result = refine(SAMPLE, filters({ status: '全部', currency: 'ALL', sort: 'limit-asc' }));
    expect(result[0]?.code).toBe('270042');
    expect(result.at(-1)?.dailyLimit).toBeNull();
  });

  it('已筛选的结果顺序稳定（同额度按代码）', () => {
    const once = refine(SAMPLE, filters({ status: '全部', currency: 'ALL', sort: 'limit-asc' }));
    const twice = refine(SAMPLE, filters({ status: '全部', currency: 'ALL', sort: 'limit-asc' }));
    expect(once.map((item) => item.code)).toEqual(twice.map((item) => item.code));
  });
});

describe('URL 同步（查询可分享）', () => {
  it('只写入非默认项', () => {
    const params = toSearchParams(filters());
    expect([...params.keys()]).toEqual([]);
  });

  it('多选维度写成重复参数', () => {
    const params = toSearchParams(
      filters({ regions: ['纳斯达克100', '美国'], themes: ['半导体'] }),
    );
    expect(params.getAll('region')).toEqual(['纳斯达克100', '美国']);
    expect(params.getAll('theme')).toEqual(['半导体']);
  });

  it('往返一致', () => {
    const original = filters({
      regions: ['纳斯达克100'],
      themes: ['医药生物', '半导体'],
      status: '全部',
      currency: 'ALL',
      band: '100',
      keyword: '纳指',
      sort: 'limit-asc',
    });
    expect(fromSearchParams(toSearchParams(original))).toEqual(original);
  });

  it('默认值不会写进 URL，读回时补默认值', () => {
    const parsed = fromSearchParams(new URLSearchParams(''));
    expect(parsed).toEqual(DEFAULT_FILTERS);
  });

  it('非法 sort 回退到默认值', () => {
    expect(fromSearchParams(new URLSearchParams('sort=bogus')).sort).toBe(DEFAULT_FILTERS.sort);
  });
});

describe('分面计数', () => {
  it('地区数量随币种筛选变化', () => {
    const all = facetCounts(SAMPLE, filters({ status: '全部', currency: 'ALL' }), 'region');
    expect(all.get('纳斯达克100')).toBe(2);
    expect(all.get('美国')).toBe(1);

    const cny = facetCounts(SAMPLE, filters({ status: '全部', currency: 'CNY' }), 'region');
    expect(cny.get('纳斯达克100')).toBe(2);
    expect(cny.get('美国') ?? 0).toBe(0);

    const usd = facetCounts(SAMPLE, filters({ status: '全部', currency: 'USD' }), 'region');
    expect(usd.get('美国')).toBe(1);
    expect(usd.get('纳斯达克100') ?? 0).toBe(0);
  });

  it('主题数量随币种筛选变化', () => {
    const cny = facetCounts(SAMPLE, filters({ status: '全部', currency: 'CNY' }), 'theme');
    expect(cny.get('宽基指数')).toBe(5);

    const usd = facetCounts(SAMPLE, filters({ status: '全部', currency: 'USD' }), 'theme');
    expect(usd.get('宽基指数')).toBe(1);
  });

  it('统计时排除该维度自身的选择，同维其它选项不被清零', () => {
    const counts = facetCounts(
      SAMPLE,
      filters({ status: '全部', currency: 'ALL', regions: ['纳斯达克100'] }),
      'region',
    );
    expect(counts.get('标普500')).toBe(1);
    expect(counts.get('全球')).toBe(1);

    const themes = facetCounts(
      SAMPLE,
      filters({ status: '全部', currency: 'ALL', regions: ['纳斯达克100'] }),
      'theme',
    );
    expect(themes.get('宽基指数')).toBe(2);
  });

  it('数量随其它维度条件变化', () => {
    const buyable = facetCounts(SAMPLE, filters({ status: '可买', currency: 'ALL' }), 'region');
    expect(buyable.get('纳斯达克100')).toBe(2);
    expect(buyable.get('标普500') ?? 0).toBe(0);
  });
});

describe('toggleValue', () => {
  it('不存在则加入，存在则移除', () => {
    expect(toggleValue([], 'a')).toEqual(['a']);
    expect(toggleValue(['a'], 'a')).toEqual([]);
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('不修改原数组', () => {
    const original = ['a'];
    toggleValue(original, 'b');
    expect(original).toEqual(['a']);
  });
});
