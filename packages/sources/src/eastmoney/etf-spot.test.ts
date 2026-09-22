import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError, UpstreamError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import { fetchEtfSpot, parseCompactDate, parseEtfSpotPage } from './etf-spot.ts';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/eastmoney/etf-spot/${name}`, import.meta.url),
    'utf8',
  );
}

/** 传输层替身：分页与主备切换是**编排逻辑**，只能靠桩来测（真实上游不可控） */
function stubClient(handler: (url: string) => string | Error): HttpClient {
  return {
    getText: async (url: string) => {
      const result = handler(url);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as HttpClient;
}

function row(code: string): string {
  return JSON.stringify({ f12: code, f14: `样例${code}`, f13: 1, f2: 1, f402: 0.1 });
}

describe('parseEtfSpotPage —— 接口 A（场内行情）', () => {
  it('解析整页：total 与行数（真实响应，8 行裁剪版）', () => {
    const page = parseEtfSpotPage(fixture('boards.json'));
    expect(page.total).toBe(1623);
    expect(page.items).toHaveLength(8);
  });

  it('字段映射到具名字段（含上市日期与行情时间戳）', () => {
    const page = parseEtfSpotPage(fixture('boards.json'));
    const target = page.items.find((item) => item.code === '589380');
    expect(target).toEqual({
      code: '589380',
      name: '科创人工智能ETF富国',
      market: 1,
      price: 1.46,
      changePct: 3.55,
      changeAmt: 0.05,
      open: 1.416,
      high: 1.485,
      low: 1.416,
      prevClose: 1.41,
      amplitude: 4.89,
      turnover: 11.3,
      volumeRatio: 1.96,
      volume: 114941,
      amount: 16845295,
      scale: 148473678,
      floatScale: 148473678,
      discountRate: -0.43,
      listingDate: '2025-07-01',
      mainInflow: -2293653,
      quoteTs: 1790064699,
    });
  });

  it('f402 负值 = 溢价：纳指 ETF 盘中溢价 27.74%（与 quote.ts 同口径）', () => {
    const page = parseEtfSpotPage(fixture('boards.json'));
    const nasdaq = page.items.find((item) => item.code === '159509');
    expect(nasdaq?.name).toBe('纳指科技ETF景顺');
    expect(nasdaq?.discountRate).toBeLessThan(0);
    expect(nasdaq?.discountRate).toBeCloseTo(-27.74, 2);
  });

  it('次新 ETF 的上市日期照实解析（589410 = 2026-07-16）', () => {
    const page = parseEtfSpotPage(fixture('boards.json'));
    expect(page.items.find((item) => item.code === '589410')?.listingDate).toBe('2026-07-16');
  });

  it('行情时间戳是秒级 Unix 时间（换算得出当天交易时段）', () => {
    const page = parseEtfSpotPage(fixture('boards.json'));
    const ts = page.items[0]?.quoteTs ?? 0;
    const iso = new Date(ts * 1000 + 8 * 3_600_000).toISOString();
    expect(iso.startsWith('2026-09-22T')).toBe(true);
  });

  it('data 为 null（越界页 / 未知板块）→ 空页，不报错', () => {
    expect(parseEtfSpotPage('{"rc":0,"data":null}')).toEqual({ total: 0, items: [] });
  });

  it('缺少代码的脏行被跳过，其余行照常解析（行级宽松）', () => {
    const text = `{"rc":0,"data":{"total":3,"diff":[{"f14":"没有代码"},${row('510300')},null]}}`;
    const page = parseEtfSpotPage(text);
    expect(page.items.map((item) => item.code)).toEqual(['510300']);
  });

  it('total 超过护栏 → ParseError（防止上游异常导致翻上千页）', () => {
    expect(() => parseEtfSpotPage('{"rc":0,"data":{"total":999999,"diff":[]}}')).toThrow(
      ParseError,
    );
  });

  it('非 JSON / 缺少 diff 数组 → ParseError', () => {
    expect(() => parseEtfSpotPage('<html>502</html>')).toThrow(ParseError);
    expect(() => parseEtfSpotPage('{"rc":0,"data":{"total":1}}')).toThrow(ParseError);
  });
});

describe('parseCompactDate', () => {
  it('紧凑日期 → ISO 日期', () => {
    expect(parseCompactDate(20120528)).toBe('2012-05-28');
    expect(parseCompactDate('20260716')).toBe('2026-07-16');
  });

  it('非法值返回 null（不拼出假日期）', () => {
    expect(parseCompactDate(null)).toBeNull();
    expect(parseCompactDate(0)).toBeNull();
    expect(parseCompactDate(201205)).toBeNull();
    expect(parseCompactDate(20121328)).toBeNull();
    expect(parseCompactDate('--')).toBeNull();
  });
});

describe('fetchEtfSpot —— 翻页与去重', () => {
  it('翻到 total 为止：末页不满即停', async () => {
    const pages: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const size = page === 3 ? 50 : 100;
      const items = Array.from({ length: size }, (_, index) =>
        row(`${String(page)}${String(index).padStart(4, '0')}`),
      );
      pages.push(`{"rc":0,"data":{"total":250,"diff":[${items.join(',')}]}}`);
    }

    let calls = 0;
    const client = stubClient(() => pages[calls++] ?? '{"rc":0,"data":null}');
    const items = await fetchEtfSpot(client);

    expect(calls).toBe(3);
    expect(items).toHaveLength(250);
  });

  it('按代码去重（MK0024 ⊂ MK0827，同一只 ETF 会重复出现）', async () => {
    const client = stubClient(
      () =>
        `{"rc":0,"data":{"total":2,"diff":[${row('518880')},${row('518880')},${row('159985')}]}}`,
    );
    const items = await fetchEtfSpot(client);
    expect(items.map((item) => item.code)).toEqual(['518880', '159985']);
  });

  it('一页就取满时不再请求第二页', async () => {
    let calls = 0;
    const client = stubClient(() => {
      calls += 1;
      return `{"rc":0,"data":{"total":2,"diff":[${row('510300')},${row('159915')}]}}`;
    });
    await fetchEtfSpot(client);
    expect(calls).toBe(1);
  });

  it('完全取不到行 → ParseError（而不是返回空列表让上游故障静默通过）', async () => {
    const client = stubClient(() => '{"rc":0,"data":null}');
    await expect(fetchEtfSpot(client)).rejects.toThrow(ParseError);
  });

  it('只取到不足一半 → ParseError（分页行为变更的信号）', async () => {
    const items = Array.from({ length: 100 }, (_, index) => row(`0000${index}`));
    const client = stubClient(() => `{"rc":0,"data":{"total":1600,"diff":[${items.join(',')}]}}`);
    await expect(fetchEtfSpot(client)).rejects.toThrow(ParseError);
  });

  it('主域名失败会被域名层吞掉后重试备用域名（fetchQuoteText 由调用方复用）', async () => {
    // 这里只验证「最终失败会冒泡成 UpstreamError」，主备切换本身由 quote.ts 的域名循环负责
    const client = stubClient(() => new UpstreamError('模拟：主备域名均失败'));
    await expect(fetchEtfSpot(client)).rejects.toThrow(UpstreamError);
  });
});
