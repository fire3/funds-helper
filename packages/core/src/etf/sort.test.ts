import { describe, expect, it } from 'vitest';
import {
  ETF_SORT_KEYS,
  ETF_SORT_LABELS,
  ETF_SORT_NATURAL_DIR,
  type EtfSortable,
  type EtfSortDir,
  sortEtfs,
} from './sort.ts';

function item(overrides: Partial<EtfSortable> = {}): EtfSortable {
  return {
    code: '510300',
    name: '沪深300ETF华泰柏瑞',
    category: '宽基',
    market: '沪市',
    indexName: '沪深300',
    price: 4.613,
    feederFunds: [],
    scale: 1000,
    amount: 100,
    premiumRate: 0.1,
    changePct: 1,
    ret6m: null,
    ret1y: null,
    ret3y: null,
    turnover: 2,
    listingDate: '2012-05-28',
    ...overrides,
  };
}

const SAMPLE: EtfSortable[] = [
  item({
    code: '159915',
    category: '宽基',
    scale: 500,
    premiumRate: -0.5,
    listingDate: '2011-12-09',
  }),
  item({ code: '513100', category: '跨境', scale: 300, premiumRate: null, listingDate: null }),
  item({
    code: '511990',
    category: '货币',
    scale: 900,
    premiumRate: 0.02,
    listingDate: '2013-03-07',
  }),
];

describe('sortEtfs', () => {
  it('规模 / 成交额降序', () => {
    expect(sortEtfs(SAMPLE, 'scale').map((x) => x.code)).toEqual(['511990', '159915', '513100']);
  });

  it('溢价最高降序、折价最深升序', () => {
    expect(sortEtfs(SAMPLE, 'premium').map((x) => x.code)).toEqual(['511990', '159915', '513100']);
    expect(sortEtfs(SAMPLE, 'discount').map((x) => x.code)).toEqual(['159915', '511990', '513100']);
  });

  it('null 恒排最后（不与真实的 0 混淆）', () => {
    const sorted = sortEtfs(SAMPLE, 'premium');
    expect(sorted.at(-1)?.premiumRate).toBeNull();
  });

  it('分类按 ETF_CATEGORIES 的顺序（宽基 → 行业主题 → 风格 → 跨境 → 债券 → 商品 → 货币）', () => {
    expect(sortEtfs(SAMPLE, 'category').map((x) => x.category)).toEqual(['宽基', '跨境', '货币']);
  });

  it('上市日期降序，null 排最后', () => {
    expect(sortEtfs(SAMPLE, 'listingDate').map((x) => x.code)).toEqual([
      '511990',
      '159915',
      '513100',
    ]);
  });

  it('不修改入参', () => {
    const before = SAMPLE.map((x) => x.code);
    sortEtfs(SAMPLE, 'scale');
    expect(SAMPLE.map((x) => x.code)).toEqual(before);
  });

  it('区间涨幅排序（近1年/近3年），null 恒排最后', () => {
    const rows = [
      item({ code: 'A', ret1y: 5, ret3y: 10, ret6m: 3 }),
      item({ code: 'B', ret1y: 20, ret3y: null, ret6m: 1 }),
      item({ code: 'C', ret1y: null, ret3y: 50, ret6m: null }),
    ];
    expect(sortEtfs(rows, 'ret1y').map((x) => x.code)).toEqual(['B', 'A', 'C']);
    expect(sortEtfs(rows, 'ret3y').map((x) => x.code)).toEqual(['C', 'A', 'B']);
    expect(sortEtfs(rows, 'ret6m').map((x) => x.code)).toEqual(['A', 'B', 'C']);
    expect(sortEtfs(rows, 'ret1y').at(-1)?.ret1y).toBeNull();
  });

  it('每个排序键都有中文标签与自然方向', () => {
    for (const key of ETF_SORT_KEYS) {
      expect(ETF_SORT_LABELS[key]).toBeTruthy();
      expect(['asc', 'desc']).toContain(ETF_SORT_NATURAL_DIR[key]);
    }
  });
});

describe('sortEtfs 的方向参数（表头升降序）', () => {
  it('不传方向 = 自然方向（与既有两参数调用一致）', () => {
    for (const key of ETF_SORT_KEYS) {
      expect(sortEtfs(SAMPLE, key).map((x) => x.code)).toEqual(
        sortEtfs(SAMPLE, key, ETF_SORT_NATURAL_DIR[key]).map((x) => x.code),
      );
    }
  });

  it('同一键的 asc 与 desc 互为反序（空值除外，恒排最后）', () => {
    const asc = sortEtfs(SAMPLE, 'scale', 'asc');
    const desc = sortEtfs(SAMPLE, 'scale', 'desc');
    expect(asc.map((x) => x.code)).toEqual([...desc].reverse().map((x) => x.code));
    expect(asc.map((x) => x.scale)).toEqual([300, 500, 900]);
  });

  it('升序时空值仍然排最后（没数据不冒充 0）', () => {
    const rows = [
      item({ code: 'A', premiumRate: 1 }),
      item({ code: 'B', premiumRate: null }),
      item({ code: 'C', premiumRate: -2 }),
    ];
    expect(sortEtfs(rows, 'premium', 'asc').map((x) => x.code)).toEqual(['C', 'A', 'B']);
    expect(sortEtfs(rows, 'premium', 'desc').map((x) => x.code)).toEqual(['A', 'C', 'B']);
  });

  it('分类倒序 = 分类顺序反过来', () => {
    expect(sortEtfs(SAMPLE, 'category', 'desc').map((x) => x.category)).toEqual([
      '货币',
      '跨境',
      '宽基',
    ]);
  });

  it('并列时按代码兜底（同一批数据结果可复现）', () => {
    const rows = [item({ code: 'B', scale: 100 }), item({ code: 'A', scale: 100 })];
    const dir: EtfSortDir = 'asc';
    expect(sortEtfs(rows, 'scale', dir).map((x) => x.code)).toEqual(['A', 'B']);
  });
});

describe('表格列的新排序键（简称 / 跟踪指数 / 最新价 / 场外联接）', () => {
  it('简称按中文正序，倒序反着来', () => {
    const rows = [item({ code: 'A', name: '中证500ETF' }), item({ code: 'B', name: '沪深300ETF' })];
    const asc = sortEtfs(rows, 'name').map((x) => x.code);
    expect(sortEtfs(rows, 'name', 'desc').map((x) => x.code)).toEqual([...asc].reverse());
    expect(asc).toEqual(['B', 'A']);
  });

  it('跟踪指数自然方向为正序（沪 → 科），空值两个方向都排最后', () => {
    const rows = [
      item({ code: 'A', indexName: '科创50' }),
      item({ code: 'B', indexName: null }),
      item({ code: 'C', indexName: '沪深300' }),
    ];
    expect(sortEtfs(rows, 'index').map((x) => x.code)).toEqual(['C', 'A', 'B']);
    expect(sortEtfs(rows, 'index', 'asc').map((x) => x.code)).toEqual(['C', 'A', 'B']);
    expect(sortEtfs(rows, 'index', 'desc').map((x) => x.code)).toEqual(['A', 'C', 'B']);
  });

  it('最新价降序（自然方向），可切成升序', () => {
    const rows = [
      item({ code: 'A', price: 3.5 }),
      item({ code: 'B', price: null }),
      item({ code: 'C', price: 7.2 }),
    ];
    expect(sortEtfs(rows, 'price').map((x) => x.code)).toEqual(['C', 'A', 'B']);
    expect(sortEtfs(rows, 'price', 'asc').map((x) => x.code)).toEqual(['A', 'C', 'B']);
  });

  it('场外联接按联接基金只数降序（0 只是真值不是空值，升序时排最前）', () => {
    const rows = [
      item({ code: 'A', feederFunds: [{}, {}] }),
      item({ code: 'B', feederFunds: [] }),
      item({ code: 'C', feederFunds: [{}] }),
    ];
    expect(sortEtfs(rows, 'feeder').map((x) => x.code)).toEqual(['A', 'C', 'B']);
    expect(sortEtfs(rows, 'feeder', 'asc').map((x) => x.code)).toEqual(['B', 'C', 'A']);
  });

  it('每个键都能两个方向排（表头点击不落到空比较器上）', () => {
    for (const key of ETF_SORT_KEYS) {
      expect(sortEtfs(SAMPLE, key, 'asc')).toHaveLength(SAMPLE.length);
      expect(sortEtfs(SAMPLE, key, 'desc')).toHaveLength(SAMPLE.length);
    }
  });
});
