import type { EtfRecord } from '@funds-helper/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  facetCounts,
  filterEtfs,
  fromSearchParams,
  refine,
  toggleValue,
  toSearchParams,
} from './filters.ts';

function fund(overrides: Partial<EtfRecord> = {}): EtfRecord {
  return {
    code: '510300',
    name: '沪深300ETF华泰柏瑞',
    market: '沪市',
    category: '宽基',
    categorySource: 'upstream',
    indexCode: '000300',
    indexName: '沪深300',
    price: 4.613,
    changePct: 0.11,
    changeAmt: 0.005,
    open: 4.636,
    high: 4.658,
    low: 4.612,
    prevClose: 4.608,
    amplitude: 1,
    turnover: 0.27,
    volumeRatio: 0.96,
    volume: 6_445_874,
    amount: 2_987_237_086,
    scale: 109_391_241_858,
    shares: 23_713_687_700,
    premiumRate: -0.06,
    premiumLevel: '平价',
    premiumText: '平价 0.06%',
    premiumNote: null,
    listingDate: '2012-05-28',
    change1w: 1.39,
    change1m: 2.1,
    change3m: 5.2,
    ytdChange: 8.4,
    maxDrawdown1y: -11.17,
    quoteAt: '2026-09-22T08:11:33.000Z',
    dataDate: '2026-09-22',
    capturedAt: '2026-09-22T08:20:00.000Z',
    feederFunds: [],
    ...overrides,
  };
}

const SAMPLE: EtfRecord[] = [
  fund(),
  fund({
    code: '159915',
    name: '创业板ETF易方达',
    market: '深市',
    category: '宽基',
    indexName: '创业板指',
    scale: 67_147_934_154,
    amount: 1_500_000_000,
    premiumRate: 0.43,
    premiumLevel: '溢价',
    feederFunds: [
      { code: '110026', name: '易方达创业板ETF联接A' },
      { code: '004744', name: '易方达创业板ETF联接C' },
    ],
  }),
  fund({
    code: '512880',
    name: '证券ETF国泰',
    category: '行业主题',
    indexName: '证券公司',
    scale: 60_445_587_092,
    premiumRate: 1.5,
    premiumLevel: '高溢价',
    premiumNote: '溢价 1.50% …',
  }),
  fund({
    code: '513100',
    name: '纳指ETF国泰',
    category: '跨境',
    scale: 18_955_760_435,
    // 成交额只有 0.3 亿：档位筛选要能把它排除掉
    amount: 30_000_000,
    premiumRate: -2,
    premiumLevel: '高折价',
    // 跨境 QDII 的联接基金：份额后缀更多
    feederFunds: [{ code: '050025', name: '博时标普500ETF联接A' }],
  }),
  fund({
    code: '159985',
    name: '豆粕ETF华夏',
    market: '深市',
    category: '商品',
    scale: 3_525_126_576,
    amount: null,
    premiumRate: null,
    premiumLevel: '未知',
    premiumText: '—',
  }),
  // 规模缺失（未披露规模的新 ETF）：设了规模档位时必须被排除
  fund({
    code: '512480',
    name: '半导体ETF国联',
    category: '行业主题',
    scale: null,
    amount: 500_000_000,
    premiumRate: null,
    premiumLevel: '未知',
    premiumText: '—',
  }),
];

describe('filterEtfs', () => {
  it('默认不过滤，按规模降序（refine）', () => {
    expect(refine(SAMPLE, DEFAULT_FILTERS).map((item) => item.code)).toEqual([
      '510300',
      '159915',
      '512880',
      '513100',
      '159985',
      '512480', // 规模缺失恒排最后
    ]);
  });

  it('分类维内取并集', () => {
    const result = filterEtfs(SAMPLE, { ...DEFAULT_FILTERS, categories: ['跨境', '商品'] });
    expect(result.map((item) => item.code)).toEqual(['513100', '159985']);
  });

  it('维度间取交集：宽基 + 深市', () => {
    const result = filterEtfs(SAMPLE, {
      ...DEFAULT_FILTERS,
      categories: ['宽基'],
      markets: ['深市'],
    });
    expect(result.map((item) => item.code)).toEqual(['159915']);
  });

  it('折溢价方向按 premiumLevel 判定（与列表徽标同源）', () => {
    expect(
      filterEtfs(SAMPLE, { ...DEFAULT_FILTERS, premiums: ['premium'] }).map((item) => item.code),
    ).toEqual(['159915', '512880']);
    expect(
      filterEtfs(SAMPLE, { ...DEFAULT_FILTERS, premiums: ['discount'] }).map((item) => item.code),
    ).toEqual(['513100']);
    expect(
      filterEtfs(SAMPLE, { ...DEFAULT_FILTERS, premiums: ['flat'] }).map((item) => item.code),
    ).toEqual(['510300']);
  });

  it('规模档位 ≥1 亿：规模缺失的行被排除（null 不能算「够大」）', () => {
    const result = filterEtfs(SAMPLE, { ...DEFAULT_FILTERS, minScale: '1' });
    expect(result.map((item) => item.code)).toEqual([
      '510300',
      '159915',
      '512880',
      '513100',
      '159985',
    ]);
  });

  it('成交额档位 ≥1 亿：成交额缺失或不足的行被排除', () => {
    const result = filterEtfs(SAMPLE, { ...DEFAULT_FILTERS, minAmount: '1' });
    expect(result.map((item) => item.code)).toEqual(['510300', '159915', '512880', '512480']);
  });

  it('关键字匹配代码、名称或跟踪指数', () => {
    expect(
      filterEtfs(SAMPLE, { ...DEFAULT_FILTERS, keyword: '证券' }).map((item) => item.code),
    ).toEqual(['512880']);
    expect(
      filterEtfs(SAMPLE, { ...DEFAULT_FILTERS, keyword: '510300' }).map((item) => item.code),
    ).toEqual(['510300']);
    expect(
      filterEtfs(SAMPLE, { ...DEFAULT_FILTERS, keyword: '创业板指' }).map((item) => item.code),
    ).toEqual(['159915']);
  });
});

describe('facetCounts', () => {
  it('分类计数随其它条件变化，且不受自身维度已选项影响', () => {
    const counts = facetCounts(SAMPLE, DEFAULT_FILTERS, 'category');
    expect(counts.get('宽基')).toBe(2);
    expect(counts.get('交叉')).toBeUndefined();

    // 只看深圳：宽基只剩 1 只
    const deepOnly = facetCounts(SAMPLE, { ...DEFAULT_FILTERS, markets: ['深市'] }, 'category');
    expect(deepOnly.get('宽基')).toBe(1);
    expect(deepOnly.get('商品')).toBe(1);
    expect(deepOnly.get('跨境')).toBeUndefined();
  });

  it('交易所计数排除交易所自身的选择', () => {
    const counts = facetCounts(SAMPLE, { ...DEFAULT_FILTERS, markets: ['沪市'] }, 'market');
    expect(counts.get('沪市')).toBe(4);
    expect(counts.get('深市')).toBe(2);
  });
});

describe('URL 双向同步', () => {
  it('解出多选维度与档位', () => {
    const params = new URLSearchParams(
      'category=宽基&category=跨境&market=沪市&premium=premium&minScale=10&minAmount=1&q=ETF&sort=amount',
    );
    const filters = fromSearchParams(params);
    expect(filters.categories).toEqual(['宽基', '跨境']);
    expect(filters.markets).toEqual(['沪市']);
    expect(filters.premiums).toEqual(['premium']);
    expect(filters.minScale).toBe('10');
    expect(filters.minAmount).toBe('1');
    expect(filters.keyword).toBe('ETF');
    expect(filters.sort).toBe('amount');
  });

  it('未知取值回落默认值（分享链接里的笔误不该让页面空掉）', () => {
    const params = new URLSearchParams('category=不存在的分类&sort=乱写&minScale=999');
    const filters = fromSearchParams(params);
    expect(filters.categories).toEqual([]);
    expect(filters.sort).toBe(DEFAULT_FILTERS.sort);
    expect(filters.minScale).toBe('any');
  });

  it('只写入与默认不同的项', () => {
    expect(toSearchParams(DEFAULT_FILTERS).toString()).toBe('');
    const params = toSearchParams({ ...DEFAULT_FILTERS, categories: ['宽基'], sort: 'premium' });
    expect(params.getAll('category')).toEqual(['宽基']);
    expect(params.get('sort')).toBe('premium');
  });

  it('往返一致', () => {
    const filters = {
      ...DEFAULT_FILTERS,
      categories: ['宽基'],
      markets: ['深市'],
      premiums: ['discount'],
      minScale: '10',
      minAmount: '0.1',
      keyword: '纳指',
      sort: 'premium' as const,
    };
    expect(fromSearchParams(toSearchParams(filters))).toEqual(filters);
  });
});

describe('toggleValue', () => {
  it('未选中则加入，已选中则移除', () => {
    expect(toggleValue([], '宽基')).toEqual(['宽基']);
    expect(toggleValue(['宽基', '跨境'], '宽基')).toEqual(['跨境']);
  });
});

describe('场外联接基金筛选', () => {
  it("'has' 只看有联接基金的 ETF（空数组 = 没查到，不进结果）", () => {
    const codes = filterEtfs(SAMPLE, { ...DEFAULT_FILTERS, feeder: 'has' }).map(
      (item) => item.code,
    );
    expect(codes).toEqual(['159915', '513100']);
  });

  it("'any' 不过滤（默认值）", () => {
    expect(filterEtfs(SAMPLE, DEFAULT_FILTERS)).toHaveLength(SAMPLE.length);
  });

  it('与其它维度是 AND：有联接 + 深市 = 只剩创业板 ETF', () => {
    const codes = filterEtfs(SAMPLE, {
      ...DEFAULT_FILTERS,
      feeder: 'has',
      markets: ['深市'],
    }).map((item) => item.code);
    expect(codes).toEqual(['159915']);
  });

  it('URL 双向同步：has 会写进链接，未知取值回落到默认', () => {
    const params = toSearchParams({ ...DEFAULT_FILTERS, feeder: 'has' });
    expect(params.get('feeder')).toBe('has');
    expect(fromSearchParams(params).feeder).toBe('has');

    // 默认值不写进链接（分享链接尽量短）
    expect(toSearchParams(DEFAULT_FILTERS).get('feeder')).toBeNull();
    // 手改链接里的脏值不能让页面空掉
    expect(fromSearchParams(new URLSearchParams({ feeder: 'nope' })).feeder).toBe('any');
  });
});
