import { describe, expect, it } from 'vitest';
import { classifyDedup, dedupeForPrompt } from './dedupe.ts';
import type { NewsItemLike } from './model.ts';

function item(overrides: Partial<NewsItemLike> & { id: number }): NewsItemLike {
  return {
    sourceId: 'ft.home',
    sourceName: 'FT',
    category: 'media',
    title: `Title ${overrides.id}`,
    summary: 'summary',
    url: `https://www.ft.com/content/${overrides.id}`,
    publishedAt: '2026-09-25T10:00:00.000Z',
    fetchedAt: '2026-09-25T11:00:00.000Z',
    discovery: false,
    ...overrides,
  };
}

describe('dedupeForPrompt —— 标题近似合并', () => {
  it('标准化后相同的标题合并成一条，位置取第一次出现处', () => {
    const items = [
      item({ id: 1, title: 'Fed holds rates steady' }),
      item({ id: 2, title: 'Unrelated story' }),
      item({ id: 3, title: 'Fed holds  RATES, steady!' }),
    ];
    const result = dedupeForPrompt(items);
    expect(result.map((entry) => entry.id)).toEqual([1, 2]);
  });

  it('保留信息量更大的那条（有摘要 > 只有标题，事实源 > 聚合器）', () => {
    const items = [
      item({ id: 1, title: 'Same headline', summary: null, discovery: true, sourceId: 'gnews.x' }),
      item({ id: 2, title: 'SAME HEADLINE', summary: 'details', discovery: false }),
    ];
    const result = dedupeForPrompt(items);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(2);
  });

  it('标题不同就不合并（跨信源报道同一件事仍是两条 —— 去重是为了控 token，不是做事实归并）', () => {
    const items = [
      item({ id: 1, title: 'Fed holds rates' }),
      item({ id: 2, title: 'Fed keeps rates unchanged', sourceId: 'cnbc.markets' }),
    ];
    expect(dedupeForPrompt(items)).toHaveLength(2);
  });

  it('规范化后为空的标题不参与合并（不能把它吞掉）', () => {
    const items = [item({ id: 1, title: '!!!' }), item({ id: 2, title: '???' })];
    expect(dedupeForPrompt(items)).toHaveLength(2);
  });
});

describe('classifyDedup —— 三段式去重口径', () => {
  it('canonical 相同 → 同一条目', () => {
    expect(
      classifyDedup(
        { url: 'https://a.example.com/x', dedupKey: null },
        { url: 'https://a.example.com/x', dedupKey: null },
      ),
    ).toBe('same-url');
  });

  it('canonical 拿不到时才退化到 (source, 标准化标题, 日期)', () => {
    expect(
      classifyDedup(
        { url: null, dedupKey: 'src|abc|2026-09-25' },
        { url: null, dedupKey: 'src|abc|2026-09-25' },
      ),
    ).toBe('same-key');
    expect(
      classifyDedup(
        { url: null, dedupKey: 'src|abc|2026-09-25' },
        { url: 'https://a.example.com/x', dedupKey: null },
      ),
    ).toBe('insert');
  });

  it('canonical 不同 → 不合并（聚合器与原文永远是两条）', () => {
    expect(
      classifyDedup(
        { url: 'https://news.google.com/rss/articles/abc', dedupKey: null },
        { url: 'https://www.reuters.com/markets/x', dedupKey: null },
      ),
    ).toBe('insert');
  });

  it('两边都拿不到任何依据时不合并（宁可重复）', () => {
    expect(classifyDedup({ url: null, dedupKey: null }, { url: null, dedupKey: null })).toBe(
      'insert',
    );
  });
});
