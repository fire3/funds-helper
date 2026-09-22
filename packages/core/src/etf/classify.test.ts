import { describe, expect, it } from 'vitest';
import {
  classifyEtf,
  classifyEtfByName,
  classifyEtfOrFallback,
  hasNoEtfFlags,
} from './classify.ts';
import { EMPTY_ETF_FLAGS, type EtfFlags } from './model.ts';

function flags(overrides: Partial<EtfFlags> = {}): EtfFlags {
  return { ...EMPTY_ETF_FLAGS, ...overrides };
}

describe('classifyEtf —— 上游标志位', () => {
  it('六类互斥标志位各归各类（样本取自实测目录）', () => {
    expect(classifyEtf(flags({ broad: true })).category).toBe('宽基'); // 159337 中证500ETF东财
    expect(classifyEtf(flags({ industry: true })).category).toBe('行业主题'); // 512880 证券ETF国泰
    expect(classifyEtf(flags({ crossBorder: true })).category).toBe('跨境'); // 513100 纳指ETF国泰
    expect(classifyEtf(flags({ bond: true })).category).toBe('债券'); // 159110 科创债ETF万家
    expect(classifyEtf(flags({ commodity: true })).category).toBe('商品'); // 159985 豆粕ETF华夏
    expect(classifyEtf(flags({ money: true })).category).toBe('货币'); // 511990 华宝添益ETF
  });

  it('优先级：资产/地域 > 风格 > 宽基/行业主题', () => {
    // 实测中 IS_HBETF…IS_HYETF 互斥，但风格会与宽基/行业主题叠加
    expect(classifyEtf(flags({ style: true, broad: true })).category).toBe('风格');
    expect(classifyEtf(flags({ style: true, industry: true })).category).toBe('风格');
    expect(classifyEtf(flags({ crossBorder: true, industry: true })).category).toBe('跨境');
    expect(classifyEtf(flags({ bond: true, style: true })).category).toBe('债券');
    expect(classifyEtf(flags({ money: true, broad: true })).category).toBe('货币');
  });

  it('来源标记为 upstream', () => {
    expect(classifyEtf(flags({ broad: true }))).toEqual({ category: '宽基', source: 'upstream' });
  });
});

describe('hasNoEtfFlags', () => {
  it('全 false 才算缺失', () => {
    expect(hasNoEtfFlags(flags())).toBe(true);
    expect(hasNoEtfFlags(flags({ style: true }))).toBe(false);
  });
});

describe('classifyEtfByName —— 接口 B 缺失时的回退', () => {
  it('跨境/债券/商品/货币按关键词判定', () => {
    expect(classifyEtfByName('纳指ETF国泰').category).toBe('跨境');
    expect(classifyEtfByName('港股通金融ETF鹏华').category).toBe('跨境');
    expect(classifyEtfByName('科创债ETF万家').category).toBe('债券');
    expect(classifyEtfByName('黄金ETF华安').category).toBe('商品');
    expect(classifyEtfByName('豆粕ETF华夏').category).toBe('商品');
    expect(classifyEtfByName('货币ETF易方达').category).toBe('货币');
  });

  it('宽基关键词优先于「默认行业主题」', () => {
    expect(classifyEtfByName('沪深300ETF华泰柏瑞').category).toBe('宽基');
    expect(classifyEtfByName('创业板ETF易方达').category).toBe('宽基');
    expect(classifyEtfByName('A500ETF平安').category).toBe('宽基');
  });

  it('宽基与商品的关键词冲突时，商品优先（金ETF / 黄金ETF 不是宽基）', () => {
    expect(classifyEtfByName('上海金ETF建信').category).toBe('商品');
  });

  it('无关键词线索时归入行业主题（实测该类别占全市场一半以上）', () => {
    expect(classifyEtfByName('证券ETF国泰').category).toBe('行业主题');
    expect(classifyEtfByName('医疗ETF嘉实')).toEqual({ category: '行业主题', source: 'name' });
  });

  it('回退不猜「风格」——名称里没有可靠线索', () => {
    expect(classifyEtfByName('红利低波ETF万家').category).not.toBe('风格');
  });
});

describe('classifyEtfOrFallback', () => {
  it('有标志位时用标志位，标志位全空时用名称', () => {
    expect(classifyEtfOrFallback('纳指ETF国泰', flags({ industry: true }))).toEqual({
      category: '行业主题',
      source: 'upstream',
    });
    expect(classifyEtfOrFallback('纳指ETF国泰', flags())).toEqual({
      category: '跨境',
      source: 'name',
    });
  });
});
