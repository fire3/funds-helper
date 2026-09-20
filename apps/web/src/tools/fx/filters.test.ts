import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, fromSearchParams, toSearchParams } from './filters.ts';

describe('fromSearchParams', () => {
  it('缺参数时用默认视图（近5年 · 美元兑人民币）', () => {
    expect(fromSearchParams(new URLSearchParams())).toEqual(DEFAULT_VIEW);
  });

  it('解出区间与方向', () => {
    expect(fromSearchParams(new URLSearchParams('range=10y&direction=CNY%2FUSD'))).toEqual({
      range: '10y',
      direction: 'CNY/USD',
    });
  });

  it('非法值回落默认，而不是让页面失效', () => {
    expect(fromSearchParams(new URLSearchParams('range=99y&direction=usdcny'))).toEqual(
      DEFAULT_VIEW,
    );
  });
});

describe('toSearchParams', () => {
  it('默认视图写成空 query（链接最短）', () => {
    expect(toSearchParams(DEFAULT_VIEW).toString()).toBe('');
  });

  it('只写入非默认项', () => {
    expect(toSearchParams({ range: 'all', direction: 'CNY/USD' }).toString()).toBe(
      'range=all&direction=CNY%2FUSD',
    );
  });

  it('与 fromSearchParams 双向一致', () => {
    const view = { range: '3y', direction: 'CNY/USD' } as const;
    expect(fromSearchParams(toSearchParams(view))).toEqual(view);
  });
});
