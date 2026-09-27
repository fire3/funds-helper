import { INDEX_RANGE_KEYS, type IndexRangeKey } from '@funds-helper/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, fromSearchParams, toSearchParams } from './filters.ts';

describe('国际行情页的视图状态 ↔ URL', () => {
  it('默认视图不写 URL（分享链接尽量短）', () => {
    expect([...toSearchParams(DEFAULT_VIEW)]).toEqual([]);
  });

  it('非默认的指数、区间与排序会被写入，再读回来一致', () => {
    const view = { code: 'hstech', range: '3y' as IndexRangeKey, sort: 'chg' as const };
    const params = toSearchParams(view);
    expect(params.get('code')).toBe('hstech');
    expect(params.get('range')).toBe('3y');
    expect(params.get('sort')).toBe('chg');

    const restored = fromSearchParams(params);
    expect(restored).toEqual({ code: 'HSTECH', range: '3y', sort: 'chg' }); // code 统一大写
  });

  it('非法区间/排序回落默认；code 透传（服务端做注册表校验，未知 code 回落 SPX）', () => {
    const restored = fromSearchParams(new URLSearchParams('code=%5ENDX&range=99y&sort=bogus'));
    expect(restored.range).toBe(DEFAULT_VIEW.range);
    expect(restored.code).toBe('^NDX');
    expect(restored.sort).toBe('default');
  });

  it('空参数 → 默认视图（标普500 + 近5年）', () => {
    expect(fromSearchParams(new URLSearchParams())).toEqual(DEFAULT_VIEW);
    expect(fromSearchParams(new URLSearchParams('code=&range='))).toEqual(DEFAULT_VIEW);
  });

  it('所有区间键都被识别', () => {
    for (const range of INDEX_RANGE_KEYS) {
      expect(fromSearchParams(new URLSearchParams({ range })).range).toBe(range);
    }
  });
});
