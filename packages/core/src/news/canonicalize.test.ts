import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, dedupKeyOf, normalizeTitle } from './canonicalize.ts';

describe('canonicalizeUrl', () => {
  it('去 utm_* / fbclid 等跟踪参数，保留内容参数', () => {
    expect(
      canonicalizeUrl('https://www.ft.com/content/abc?utm_source=rss&utm_medium=feed&id=42'),
    ).toBe('https://www.ft.com/content/abc?id=42');
    expect(canonicalizeUrl('https://a.example.com/x?fbclid=123&y=2')).toBe(
      'https://a.example.com/x?y=2',
    );
  });

  it('host 小写、去 hash、去尾部斜杠（根路径保留）', () => {
    expect(canonicalizeUrl('https://WWW.Example.COM/Story/#section-2')).toBe(
      'https://www.example.com/Story',
    );
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('参数顺序不同视为同一条目（排序后再比较）', () => {
    expect(canonicalizeUrl('https://a.example.com/x?b=2&a=1')).toBe(
      canonicalizeUrl('https://a.example.com/x?a=1&b=2'),
    );
  });

  it('非 http(s) 与无法解析的地址返回 null（绝不伪造值进唯一索引）', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('ftp://example.com/x')).toBeNull();
    expect(canonicalizeUrl('不是链接')).toBeNull();
    expect(canonicalizeUrl('')).toBeNull();
  });

  it('聚合器跳转链接可原样保留（keepQuery）', () => {
    const url = 'https://news.google.com/rss/articles/abc?oc=5&utm_source=x';
    expect(canonicalizeUrl(url, { keepQuery: true })).toBe(
      'https://news.google.com/rss/articles/abc?oc=5&utm_source=x',
    );
  });
});

describe('normalizeTitle', () => {
  it('NFKC + 小写 + 去标点 + 折叠空白', () => {
    expect(normalizeTitle('Fed holds  rates, steady!')).toBe('fed holds rates steady');
    expect(normalizeTitle('Ｆｅｄ　Rates')).toBe('fed rates');
    expect(normalizeTitle('  a   b  ')).toBe('a b');
  });

  it('标题不同就是不同（宁可重复，不可错合并）', () => {
    expect(normalizeTitle('Fed cuts rates')).not.toBe(normalizeTitle('Fed raises rates'));
  });
});

describe('dedupKeyOf', () => {
  it('source|hash(标题)|日期', () => {
    expect(dedupKeyOf('ft.home', 'Fed Holds Rates', '2026-09-25T10:00:00.000Z')).toBe(
      dedupKeyOf('ft.home', 'Fed holds  RATES!', '2026-09-25T08:00:00.000Z'),
    );
    expect(dedupKeyOf('ft.home', 'Fed Holds Rates', '2026-09-25T10:00:00.000Z')).not.toBe(
      dedupKeyOf('cnbc.markets', 'Fed Holds Rates', '2026-09-25T10:00:00.000Z'),
    );
    expect(dedupKeyOf('ft.home', 'Fed Holds Rates', null)).toMatch(/^ft\.home\|[0-9a-f]{8}\|$/);
  });

  it('不同标题的 hash 不同（退化去重键得真的能区分）', () => {
    expect(dedupKeyOf('a', '标题一', null)).not.toBe(dedupKeyOf('a', '标题二', null));
  });
});
