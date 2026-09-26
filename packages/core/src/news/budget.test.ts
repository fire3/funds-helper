import { describe, expect, it } from 'vitest';
import { buildPromptBudget, type PromptBudgetInput } from './budget.ts';
import type { NewsCategory, NewsItemLike } from './model.ts';
import { estimateItemTokens } from './prompt.ts';

let seq = 0;

function make(
  category: NewsCategory,
  options: { sourceId?: string; minutesAgo?: number; title?: string; summary?: string | null } = {},
): NewsItemLike {
  seq += 1;
  const sourceId = options.sourceId ?? `${category}.source`;
  return {
    id: seq,
    sourceId,
    sourceName: sourceId,
    category,
    title: options.title ?? `Headline ${category} ${seq}`,
    summary:
      options.summary === undefined ? 'A short summary of the story goes here.' : options.summary,
    url: `https://example.com/story/${seq}`,
    publishedAt: new Date(
      Date.UTC(2026, 8, 25, 12, 0, 0) - (options.minutesAgo ?? seq) * 60_000,
    ).toISOString(),
    fetchedAt: '2026-09-25T13:00:00.000Z',
    discovery: category === 'discovery',
  };
}

function sumTokens(items: readonly NewsItemLike[]): number {
  return items.reduce((total, item) => total + estimateItemTokens(item), 0);
}

function budget(input: Partial<PromptBudgetInput> & { items: NewsItemLike[] }) {
  return buildPromptBudget({
    targetInputTokens: 10_000,
    ...input,
  });
}

describe('buildPromptBudget —— 确定性与记账', () => {
  it('同输入必得同输出（预算决策不允许有随机性）', () => {
    const items = [
      ...Array.from({ length: 20 }, () => make('media')),
      ...Array.from({ length: 10 }, () => make('policy')),
      ...Array.from({ length: 5 }, () => make('discovery')),
    ];
    const first = budget({ items });
    const second = budget({ items: [...items] });
    expect(first.selected.map((item) => item.id)).toEqual(second.selected.map((item) => item.id));
    expect(first.usedTokens).toBe(second.usedTokens);
    expect(first.dropped).toBe(second.dropped);
  });

  it('selected + dropped === 输入条数，且分组明细能加回去（UI 要显示「已从 N 条抽取 M 条」）', () => {
    const items = [
      ...Array.from({ length: 60 }, () => make('media')),
      ...Array.from({ length: 30 }, () => make('policy')),
      ...Array.from({ length: 10 }, () => make('opinion')),
      ...Array.from({ length: 10 }, () => make('discovery')),
    ];
    const target = sumTokens(items) * 0.4;
    const result = budget({ items, targetInputTokens: target });

    expect(result.selected.length + result.dropped).toBe(items.length);
    const sum = Object.values(result.droppedByCategory).reduce((a, b) => a + b, 0);
    expect(sum).toBe(result.dropped);
    expect(result.usedTokens).toBeLessThanOrEqual(target);
    expect(result.selected.length).toBeGreaterThan(0);
  });

  it('同标题的重复条目先合并再进预算（deduped 只记日志，不进 dropped 口径）', () => {
    const items = [
      make('media', { title: 'Same headline' }),
      make('policy', { title: 'Same headline' }),
      make('media', { title: 'Another' }),
    ];
    const result = budget({ items });
    expect(result.deduped).toBe(1);
    expect(result.selected).toHaveLength(2);
    expect(result.dropped).toBe(1); // 3 - 2
  });
});

describe('buildPromptBudget —— 配额（保底 + 封顶，不是硬切）', () => {
  it('政策组保底 20%：即使媒体条目又多又新，一手公告也必须进清单', () => {
    const items = [
      ...Array.from({ length: 400 }, () => make('media', { minutesAgo: 1 })),
      ...Array.from({ length: 12 }, () => make('policy', { sourceId: 'fed', minutesAgo: 600 })),
    ];
    const target = 1500;
    const result = budget({ items, targetInputTokens: target, weights: { fed: 5 } });

    const policyTokens = sumTokens(result.selected.filter((item) => item.category === 'policy'));
    expect(policyTokens).toBeGreaterThanOrEqual(target * 0.2);
    expect(result.selected.some((item) => item.category === 'media')).toBe(true);
    expect(result.usedTokens).toBeLessThanOrEqual(target);
  });

  it('保底用不完时余额让给别的组（某类不足配额不会浪费预算）', () => {
    const items = [
      ...Array.from({ length: 2 }, () => make('policy')), // 远不够 20%
      ...Array.from({ length: 200 }, () => make('media')),
    ];
    const target = 3000;
    const result = budget({ items, targetInputTokens: target });
    // 两条政策全进，媒体吃掉剩余预算而不是停在 45%
    expect(result.selected.filter((item) => item.category === 'policy')).toHaveLength(2);
    const mediaTokens = sumTokens(result.selected.filter((item) => item.category === 'media'));
    expect(mediaTokens).toBeGreaterThan(target * 0.45);
  });

  it('发现组封顶 10%：聚合器不能淹没事实源', () => {
    const items = [
      ...Array.from({ length: 10 }, () => make('media')),
      ...Array.from({ length: 60 }, () => make('discovery', { minutesAgo: 0 })),
    ];
    const target = 2000;
    const result = budget({ items, targetInputTokens: target });

    const discovery = result.selected.filter((item) => item.category === 'discovery');
    expect(sumTokens(discovery)).toBeLessThanOrEqual(target * 0.1 + 1);
    expect(discovery.length).toBeGreaterThan(0); // 封顶不等于禁止
    expect(result.selected.some((item) => item.category === 'media')).toBe(true);
  });

  it('预算截断：超预算即停，且绝不静默（dropped 明细完整）', () => {
    const items = Array.from({ length: 100 }, () => make('media'));
    const full = sumTokens(items);
    const result = budget({ items, targetInputTokens: full * 0.5 });

    expect(result.usedTokens).toBeLessThanOrEqual(full * 0.5);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.droppedByCategory.media).toBe(result.dropped);
    // 结果是前缀（按组内排序），确定性由排序保证
    expect(result.selected.length).toBeGreaterThan(10);
  });

  it('预算为 0 时不选任何条目（不抛错）', () => {
    const result = budget({ items: [make('media')], targetInputTokens: 0 });
    expect(result.selected).toHaveLength(0);
    expect(result.dropped).toBe(1);
  });

  it('组内排序：权重降序优先于时间（政策一手公告权重更高）', () => {
    const heavy = make('media', { sourceId: 'ft.home', minutesAgo: 600 });
    const light = make('media', { sourceId: 'gnews.finance', minutesAgo: 1 });
    const result = budget({
      items: [light, heavy],
      targetInputTokens: 10_000,
      weights: { 'ft.home': 3, 'gnews.finance': 1 },
    });
    expect(result.selected[0]?.sourceId).toBe('ft.home');
  });

  it('同权重按发布时间倒序（缺发布时间的按抓取时间兜底）', () => {
    const older: NewsItemLike = {
      ...make('media'),
      id: 101,
      publishedAt: '2026-09-20T00:00:00.000Z',
    };
    const newer: NewsItemLike = {
      ...make('media'),
      id: 102,
      publishedAt: '2026-09-25T00:00:00.000Z',
    };
    const unknown: NewsItemLike = {
      ...make('media'),
      id: 103,
      publishedAt: null,
      fetchedAt: '2026-09-26T00:00:00.000Z',
    };
    const result = budget({ items: [unknown, older, newer] });
    expect(result.selected.map((item) => item.id)).toEqual([103, 102, 101]);
  });
});
