import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError } from '../errors.ts';
import { decodeEntities, detectFormat, parseFeed, SUMMARY_MAX_CHARS, stripHtml } from './rss.ts';

function fixture(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/feeds/${name}`, import.meta.url), 'utf8');
}

/** 首版启用的 15 个信源，一个不落 —— 少一个就说明注册表与 fixture 漂移了 */
const REAL_FEEDS = [
  'ft-home.xml',
  'ft-markets.xml',
  'cnbc-markets.xml',
  'yahoo-finance.xml',
  'nikkei-asia.xml',
  'scmp.xml',
  'economist-finance.xml',
  'project-syndicate.xml',
  'foreign-affairs.xml',
  'ecb-press.xml',
  'boe-news.xml',
  'fed-press.xml',
  'sec-press.xml',
  'gnews-reuters.xml',
  'gnews-finance.xml',
] as const;

describe('parseFeed —— 15 个真实信源的 fixture', () => {
  it.each(REAL_FEEDS)('%s 能解析出条目，且每条都有标题与 http(s) 链接', (name) => {
    const result = parseFeed(fixture(name));
    expect(result.entries.length).toBeGreaterThan(0);
    // 行级宽松的另一面：结构必须是好的 —— 解析出来的条目一律可展示
    for (const entry of result.entries) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.link).toMatch(/^https?:\/\//);
    }
    // 单条残缺只该被跳过，不该整批失败（15 个信源实测 skipped 均为 0）
    expect(result.skipped).toBe(0);
  });

  it('根元素探测覆盖三种格式（含 CNBC 的 <feed_asset> 干扰）', () => {
    expect(parseFeed(fixture('ft-home.xml')).format).toBe('rss2');
    expect(parseFeed(fixture('nikkei-asia.xml')).format).toBe('rdf');
    expect(parseFeed(fixture('atom-entry.xml')).format).toBe('atom');
    // CNBC 的 RSS 里有 <feed_asset>，不能被误判成 Atom
    expect(detectFormat(fixture('cnbc-markets.xml'))).toBe('rss2');
    expect(detectFormat(fixture('fed-press.xml'))).toBe('rss2');
  });

  it('FT：CDATA 标题解码、HTML 摘要剥离、pubDate 转 ISO8601', () => {
    const { entries } = parseFeed(fixture('ft-home.xml'));
    const first = entries[0];
    expect(first?.title).toContain('Soaring bond yields');
    expect(first?.title).not.toContain('<![CDATA[');
    // 弯引号必须保下来（实体与 UTF-8 原文都不能坏）
    expect(first?.title).toContain('‘');
    expect(first?.summary).toContain('Rising borrowing costs');
    expect(first?.summary).not.toContain('<');
    expect(first?.publishedAt).toBe('2026-09-25T20:00:09.000Z');
    expect(first?.hasSummary).toBe(true);
  });

  it('Economist：300 条全量解析（长 feed 不会被截断）', () => {
    const { entries } = parseFeed(fixture('economist-finance.xml'));
    expect(entries).toHaveLength(300);
    expect(entries[0]?.title).toBe('How the Fed should measure inflation');
    expect(entries[0]?.publishedAt).toBe('2026-09-24T09:44:07.000Z');
  });

  it('Nikkei Asia：RDF 格式、没有 pubDate 就是 null（**绝不伪造时间**）', () => {
    const result = parseFeed(fixture('nikkei-asia.xml'), 'rdf');
    expect(result.format).toBe('rdf');
    expect(result.entries).toHaveLength(50);
    for (const entry of result.entries) {
      expect(entry.publishedAt).toBeNull();
      expect(entry.link).toMatch(/^https:\/\/asia\.nikkei\.com\//);
    }
    // rdf:about 与 <link> 一致时取 <link>，两者都得是可用链接
    expect(result.entries[0]?.title.length).toBeGreaterThan(0);
  });

  it('Fed：带 BOM + CDATA 的 link/guid 都能取到', () => {
    const { entries } = parseFeed(fixture('fed-press.xml'));
    expect(entries[0]?.link).toBe(
      'https://www.federalreserve.gov/newsevents/pressreleases/orders20260925a.htm',
    );
    expect(entries[0]?.guid).toBe(entries[0]?.link);
    expect(entries[0]?.publishedAt).toBe('2026-09-25T20:30:00.000Z');
    // BOM 不该漏进标题
    expect(entries[0]?.title.startsWith('\uFEFF')).toBe(false);
  });

  it('ECB：没有 description 的条目降级为「只有标题」', () => {
    const { entries } = parseFeed(fixture('ecb-press.xml'));
    const first = entries[0];
    expect(first?.title).toContain('Isabel Schnabel');
    expect(first?.summary).toBeNull();
    expect(first?.hasSummary).toBe(false);
    expect(first?.publishedAt).toBe('2026-09-24T12:00:00.000Z');
  });

  it('Google News：转义过的 HTML 摘要被剥成纯文本，跳转链接原样保留', () => {
    const { entries } = parseFeed(fixture('gnews-reuters.xml'));
    expect(entries).toHaveLength(100);
    const first = entries[0];
    expect(first?.summary).not.toContain('<');
    expect(first?.summary).not.toContain('&lt;');
    expect(first?.link).toMatch(/^https:\/\/news\.google\.com\//);
    expect(first?.publishedAt).not.toBeNull();
  });

  it('SCMP / CNBC / BoE / SEC / Yahoo / FT Markets / 三个观点源都可用', () => {
    const counts = [
      'scmp.xml',
      'cnbc-markets.xml',
      'boe-news.xml',
      'sec-press.xml',
      'yahoo-finance.xml',
      'ft-markets.xml',
      'project-syndicate.xml',
      'foreign-affairs.xml',
      'economist-finance.xml',
    ].map((name) => parseFeed(fixture(name)).entries.length);
    for (const count of counts) expect(count).toBeGreaterThan(0);
    expect(parseFeed(fixture('cnbc-markets.xml')).entries).toHaveLength(30);
    expect(parseFeed(fixture('sec-press.xml')).entries).toHaveLength(25);
    expect(parseFeed(fixture('project-syndicate.xml')).entries).toHaveLength(20);
  });

  it('Project Syndicate：条目里的 utm 跟踪参数先留着，canonical 化交给 core', () => {
    const { entries } = parseFeed(fixture('project-syndicate.xml'));
    expect(entries[0]?.link).toContain('utm_source=rss');
  });
});

describe('parseFeed —— Atom（合成样例）', () => {
  it('自闭合 <link href> 取 alternate；<published> 优先于 <updated>', () => {
    const { entries } = parseFeed(fixture('atom-entry.xml'));
    expect(entries).toHaveLength(2);
    expect(entries[0]?.link).toBe('https://example.org/markets/central-bank-holds-rate');
    expect(entries[0]?.publishedAt).toBe('2026-09-25T08:03:00.000Z');
    expect(entries[0]?.summary).toContain('benchmark rate');
    expect(entries[0]?.summary).not.toContain('<');
  });

  it('只有 <updated> 的条目用它兜底；rel 不是 alternate 时也能拿到链接', () => {
    const { entries } = parseFeed(fixture('atom-entry.xml'));
    expect(entries[1]?.publishedAt).toBe('2026-09-25T07:12:00.000Z');
    expect(entries[1]?.link).toBe('https://example.org/markets/yen-slides');
    expect(entries[1]?.guid).toBe('https://example.org/markets/yen-slides');
  });
});

describe('parseFeed —— 护栏（失败要显式）', () => {
  it('HTML 挑战页 / 错误页 → ParseError（HTTP 200 不等于可用）', () => {
    expect(() => parseFeed(fixture('html-challenge.html'))).toThrow(ParseError);
    try {
      parseFeed(fixture('html-challenge.html'));
      expect.unreachable('应当抛 ParseError');
    } catch (error) {
      expect((error as ParseError).message).toContain('HTML');
    }
  });

  it('429 的纯文本响应体 → ParseError（不能被当成空 feed 静默吞掉）', () => {
    expect(() => parseFeed(fixture('rate-limited.txt'))).toThrow(ParseError);
  });

  it('结构级严格：根本没有条目 = 上游改版 → ParseError', () => {
    expect(() =>
      parseFeed('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>'),
    ).toThrow(ParseError);
  });

  it('行级宽松：缺 title 或缺 link 的条目只跳过并计数', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>有标题没链接</title></item>
      <item><link>https://example.org/no-title</link></item>
      <item><title>正常条目</title><link>https://example.org/ok</link></item>
      <item><title>链接非法协议</title><link>javascript:alert(1)</link></item>
    </channel></rss>`;
    const result = parseFeed(xml);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe('正常条目');
    expect(result.skipped).toBe(3);
  });

  it('相对链接按 baseUrl 解析；不传 baseUrl 时只认绝对链接', () => {
    const xml =
      '<rss version="2.0"><channel><item><title>t</title><link>/story/1</link></item></channel></rss>';
    expect(parseFeed(xml).skipped).toBe(1);
    expect(
      parseFeed(xml, 'auto', { baseUrl: 'https://example.org/feed.xml' }).entries[0]?.link,
    ).toBe('https://example.org/story/1');
  });
});

describe('HTML 剥离与实体解码', () => {
  it('剥标签 + 折叠空白 + 按 400 字符在词边界截断', () => {
    const html = `<p>${'word '.repeat(200)}</p>`;
    const result = stripHtml(html);
    expect(result.ok).toBe(true);
    expect(result.text.endsWith('…')).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS + 1);
    expect(result.text).not.toContain('<');
  });

  it('转义过的 HTML（&lt;p&gt;）两遍剥离后不留标签', () => {
    const result = stripHtml('&lt;p&gt;Policymakers kept the benchmark rate.&lt;/p&gt;');
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Policymakers kept the benchmark rate.');
  });

  it('剥不干净时返回 ok=false（条目降级为只有标题，而不是把标签串喂给模型）', () => {
    expect(stripHtml('残缺标签 <p 没有结束').ok).toBe(false);
    expect(stripHtml('<p>正常段落</p>').ok).toBe(true);
  });

  it('实体单次解码：&amp;lt; 得到 &lt; 而不是 <', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('a &amp; b &#8217; &#x2019; &nbsp;c')).toBe('a & b ’ ’  c');
    expect(decodeEntities('&unknownentity;')).toBe('&unknownentity;');
  });

  it('摘要统一截断到 400 字符', () => {
    const long = 'x'.repeat(1000);
    expect(stripHtml(long).text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS + 1);
  });
});
