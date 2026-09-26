import { describe, expect, it } from 'vitest';
import type { NewsItemLike } from './model.ts';
import {
  estimateItemTokens,
  estimateTokens,
  formatItemLine,
  formatItemLines,
  renderTemplate,
} from './prompt.ts';

function item(overrides: Partial<NewsItemLike> = {}): NewsItemLike {
  return {
    id: 12,
    sourceId: 'cnbc.markets',
    sourceName: 'CNBC Markets',
    category: 'policy',
    title: 'Fed holds rates steady',
    summary: 'The Federal Reserve held its benchmark rate.',
    url: 'https://www.cnbc.com/2026/09/25/fed-holds-rates.html',
    publishedAt: '2026-09-25T01:03:00.000Z',
    fetchedAt: '2026-09-25T02:00:00.000Z',
    discovery: false,
    ...overrides,
  };
}

describe('renderTemplate', () => {
  it('替换 {{var}}，支持大括号内空白', () => {
    expect(
      renderTemplate('日期 {{ date }}，共 {{count}} 条', { date: '2026-09-25', count: 187 }),
    ).toBe('日期 2026-09-25，共 187 条');
  });

  it('变量缺失时替换成空串，**绝不吐出 {{x}}**（占位符会让模型困惑）', () => {
    expect(renderTemplate('a{{missing}}b', {})).toBe('ab');
    expect(renderTemplate('{{a}}{{b}}', { a: undefined, b: null })).toBe('');
    expect(renderTemplate('{{ x }}', {})).not.toContain('{{');
  });

  it('多余的花括号内容（不是占位符）原样保留', () => {
    expect(renderTemplate('{json} 与 {{real}}', { real: 'ok' })).toBe('{json} 与 ok');
  });
});

describe('formatItemLine', () => {
  it('编号即引用号：[n] 时间 · 信源 · 分组 + 标题 + 摘要 + 链接', () => {
    const lines = formatItemLine(12, item()).split('\n');
    expect(lines).toHaveLength(4);
    // Asia/Shanghai = UTC+8：01:03Z → 09:03
    expect(lines[0]).toBe('[12] 2026-09-25 09:03 · CNBC Markets · 政策与监管');
    expect(lines[1]).toBe('      Fed holds rates steady');
    expect(lines[2]).toBe('      The Federal Reserve held its benchmark rate.');
    expect(lines[3]).toBe('      https://www.cnbc.com/2026/09/25/fed-holds-rates.html');
  });

  it('没有摘要就三行；没有发布时间写「时间未知」（**不伪造时间**）', () => {
    const lines = formatItemLine(1, item({ summary: null, publishedAt: null })).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('时间未知');
    expect(lines[0]).not.toContain('NaN');
  });

  it('多条之间空行分隔，编号从 1 开始且连续', () => {
    const text = formatItemLines([item({ id: 1 }), item({ id: 2 })]);
    expect(text).toContain('[1] ');
    expect(text).toContain('[2] ');
    expect(text.split('\n\n')).toHaveLength(2);
  });
});

describe('estimateTokens', () => {
  it('英文按 chars/4、中文按 chars/1.6 分段估算', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello')).toBe(2);
    expect(estimateTokens('中文两个字')).toBe(4);
    expect(estimateTokens('中文abcd')).toBe(3);
  });

  it('单条条目的估算与整行渲染一致（预算口径不会漏算标题/链接）', () => {
    const one = item();
    expect(estimateItemTokens(one)).toBe(estimateTokens(formatItemLine(1, one)));
    expect(estimateItemTokens(one)).toBeGreaterThan(estimateTokens(one.title));
  });
});
