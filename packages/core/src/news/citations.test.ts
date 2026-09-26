import { describe, expect, it } from 'vitest';
import { collectRefs, validateCitations } from './citations.ts';
import type { SummaryPayloadLike } from './model.ts';

function payload(overrides: Partial<SummaryPayloadLike> = {}): SummaryPayloadLike {
  return {
    headline: '今日要闻',
    sections: {
      macro: [{ text: '维持利率不变', refs: [1, 2] }],
      markets: [{ text: '股市上涨', refs: [3] }],
      companies: [],
      asia: [],
    },
    risk: [{ text: '两家信源说法不一', refs: [] }],
    watch: ['下周公布 CPI'],
    ...overrides,
  };
}

describe('validateCitations —— 引用越界丢弃，正文保留', () => {
  it('引用都在范围内时原样通过', () => {
    const result = validateCitations(payload(), 10);
    expect(result.invalidRefs).toBe(0);
    expect(result.citations).toBe('ok');
    expect(result.payload.sections.macro[0]?.refs).toEqual([1, 2]);
  });

  it('部分越界：丢弃越界引用，**要点保留**（正文仍然可读，不整单作废）', () => {
    const result = validateCitations(
      payload({ sections: { ...payload().sections, macro: [{ text: '要点', refs: [1, 999] }] } }),
      10,
    );
    expect(result.invalidRefs).toBe(1);
    expect(result.payload.sections.macro).toHaveLength(1);
    expect(result.payload.sections.macro[0]?.refs).toEqual([1]);
    expect(result.payload.sections.macro[0]?.text).toBe('要点');
  });

  it('某个分区的引用全部越界：分区仍保留（标题与正文可能仍有价值）', () => {
    const result = validateCitations(
      payload({
        sections: { ...payload().sections, markets: [{ text: '编造的引用', refs: [777] }] },
      }),
      10,
    );
    expect(result.payload.sections.markets).toHaveLength(1);
    expect(result.payload.sections.markets[0]?.refs).toEqual([]);
    expect(result.invalidRefs).toBe(1);
    // 其它分区仍有有效引用 → 整体不是 none
    expect(result.citations).toBe('ok');
  });

  it('refs 为空数组是合法的（对应背景性表述，UI 不渲染角标）', () => {
    const result = validateCitations(
      payload({
        sections: {
          macro: [{ text: '背景', refs: [] }],
          markets: [],
          companies: [],
          asia: [],
        },
        risk: [],
        watch: [],
      }),
      10,
    );
    expect(result.invalidRefs).toBe(0);
    expect(result.citations).toBe('none'); // 没有任何一条能关联到原文
    expect(result.validRefs).toBe(0);
  });

  it('全部越界 → citations:none（UI 顶部提示「未能关联到原文条目」）', () => {
    const result = validateCitations(payload(), 0);
    expect(result.citations).toBe('none');
    expect(result.invalidRefs).toBe(3);
    expect(collectRefs(result.payload)).toEqual([]);
  });

  it('非整数引用同样被丢弃（模型偶尔会输出 1.5 这种）', () => {
    const result = validateCitations(
      payload({ sections: { ...payload().sections, macro: [{ text: 'x', refs: [1.5] }] } }),
      10,
    );
    expect(result.invalidRefs).toBe(1);
    expect(result.payload.sections.macro[0]?.refs).toEqual([]);
  });
});

describe('collectRefs —— 回填引用条目用', () => {
  it('收集全部有效引用并去重、升序', () => {
    const data = payload({
      sections: {
        macro: [{ text: 'a', refs: [3, 1] }],
        markets: [{ text: 'b', refs: [1, 2] }],
        companies: [],
        asia: [],
      },
      risk: [{ text: 'c', refs: [5] }],
      watch: [],
    });
    expect(collectRefs(data)).toEqual([1, 2, 3, 5]);
  });

  it('引用角标编号与清单编号一致（[1] 指第一条）', () => {
    const result = validateCitations(payload(), 187);
    const refs = collectRefs(result.payload);
    expect(refs).toContain(1);
    expect(Math.max(...refs)).toBeLessThanOrEqual(187);
  });
});
