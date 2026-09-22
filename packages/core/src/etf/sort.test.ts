import { describe, expect, it } from 'vitest';
import { ETF_SORT_KEYS, ETF_SORT_LABELS, type EtfSortable, sortEtfs } from './sort.ts';

function item(overrides: Partial<EtfSortable> = {}): EtfSortable {
  return {
    code: '510300',
    name: '沪深300ETF华泰柏瑞',
    category: '宽基',
    market: '沪市',
    scale: 1000,
    amount: 100,
    premiumRate: 0.1,
    changePct: 1,
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

  it('每个排序键都有中文标签', () => {
    for (const key of ETF_SORT_KEYS) expect(ETF_SORT_LABELS[key]).toBeTruthy();
  });
});
