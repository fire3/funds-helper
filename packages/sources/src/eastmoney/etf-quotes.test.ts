import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError, UpstreamError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import {
  ETF_QUOTE_BATCH_SIZE,
  fetchEtfSpotBySecids,
  isExchangeTradedCode,
  parseEtfQuoteResponse,
  toEtfSecId,
} from './etf-quotes.ts';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/eastmoney/etf-spot/${name}`, import.meta.url),
    'utf8',
  );
}

/** 传输层替身：分片与覆盖率护栏是**编排逻辑**，只能靠桩来测（真实上游不可控） */
function stubClient(handler: (url: string) => string | Error): HttpClient {
  return {
    getText: async (url: string) => {
      const result = handler(url);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as HttpClient;
}

/** 从请求 URL 里取出 secids，构造「全部命中」的响应 */
function quoteUrlCodes(url: string): string[] {
  const secids = new URL(url).searchParams.get('secids') ?? '';
  return secids
    .split(',')
    .filter((value) => value !== '')
    .map((secid) => secid.slice(2));
}

function respondWith(codes: readonly string[], total = codes.length): string {
  return JSON.stringify({
    rc: 0,
    data: {
      total,
      diff: codes.map((code) => ({
        f12: code,
        f13: code.startsWith('5') ? 1 : 0,
        f14: `样例${code}`,
        f2: 1.234,
        f402: 0.11,
        f26: 20120528,
        f124: 1_790_064_693,
      })),
    },
  });
}

describe('toEtfSecId / isExchangeTradedCode —— 市场前缀', () => {
  it('沪市 5xxxxx → 1.，深市 1xxxxx → 0.（与 quote.ts 同规则）', () => {
    expect(toEtfSecId('510300')).toBe('1.510300');
    expect(toEtfSecId('159915')).toBe('0.159915');
    expect(toEtfSecId('511990')).toBe('1.511990');
  });

  it('只接受场内代码：场外（0/3/4/6 开头）与脏值都要挡掉', () => {
    expect(isExchangeTradedCode('510300')).toBe(true);
    expect(isExchangeTradedCode('159915')).toBe(true);
    expect(isExchangeTradedCode('000001')).toBe(false);
    expect(isExchangeTradedCode('51239')).toBe(false);
    expect(isExchangeTradedCode('abc')).toBe(false);
    expect(isExchangeTradedCode('')).toBe(false);
  });
});

describe('parseEtfQuoteResponse —— 接口 A′（批量报价）', () => {
  it('解析真实响应：请求 7 个代码，只有 6 只回了报价', () => {
    const items = parseEtfQuoteResponse(fixture('ulist.json'));
    expect(items.map((item) => item.code)).toEqual([
      '510300',
      '159915',
      '511990',
      '159985',
      '588000',
      '513100',
    ]);
    // 512390（已退市）没有回行 —— 注意这里用 null 而不是报错
    expect(items.find((item) => item.code === '512390')).toBeUndefined();
  });

  it('字段与 clist 完全同源：折溢价 / 上市日期 / 量比 / 主力净流入 / 时间戳都在', () => {
    const items = parseEtfQuoteResponse(fixture('ulist.json'));
    expect(items.find((item) => item.code === '510300')).toEqual({
      code: '510300',
      name: '沪深300ETF华泰柏瑞',
      market: 1,
      price: 4.613,
      changePct: 0.11,
      changeAmt: 0.005,
      open: 4.636,
      high: 4.658,
      low: 4.612,
      prevClose: 4.608,
      amplitude: 1,
      turnover: 2.72,
      volumeRatio: 0.96,
      volume: 6_445_874,
      amount: 2_987_237_086,
      scale: 109_391_241_858,
      floatScale: 109_391_241_858,
      discountRate: 0.06,
      listingDate: '2012-05-28',
      mainInflow: 283_404_048,
      quoteTs: 1_790_064_693,
    });
  });

  it('f402 负值 = 溢价（与 clist / quote.ts 同口径）', () => {
    const items = parseEtfQuoteResponse(fixture('ulist.json'));
    const nasdaq = items.find((item) => item.code === '513100');
    expect(nasdaq?.discountRate).toBeCloseTo(-12.92, 2);
  });

  it('全部代码都未知时上游返回 data:null —— 是空结果，不是错误', () => {
    expect(parseEtfQuoteResponse(JSON.stringify({ rc: 0, data: null }))).toEqual([]);
  });

  it('响应不是 JSON 或缺 diff → ParseError（不能让残缺数据静默通过）', () => {
    expect(() => parseEtfQuoteResponse('<html>503</html>')).toThrow(ParseError);
    expect(() => parseEtfQuoteResponse(JSON.stringify({ data: { total: 3 } }))).toThrow(ParseError);
  });

  it('total 有值但 diff 为空 → ParseError（接口结构变更的信号）', () => {
    expect(() => parseEtfQuoteResponse(JSON.stringify({ data: { total: 100, diff: [] } }))).toThrow(
      ParseError,
    );
  });
});

describe('fetchEtfSpotBySecids —— 分片与覆盖率护栏', () => {
  it('按 100 只/请求分片：150 个代码 = 2 次请求', async () => {
    const calls: string[][] = [];
    const client = stubClient((url) => {
      const codes = quoteUrlCodes(url);
      calls.push(codes);
      return respondWith(codes);
    });

    const codes = Array.from({ length: 150 }, (_, index) =>
      String(510_001 + index).padStart(6, '0'),
    );
    const items = await fetchEtfSpotBySecids(client, codes);

    expect(calls.map((batch) => batch.length)).toEqual([ETF_QUOTE_BATCH_SIZE, 50]);
    expect(items).toHaveLength(150);
    expect(items[0]?.code).toBe('510001');
  });

  it('重复代码只查一次（代码池可能来自多页目录）', async () => {
    let requested = 0;
    const client = stubClient((url) => {
      const codes = quoteUrlCodes(url);
      requested = codes.length;
      return respondWith(codes);
    });

    const items = await fetchEtfSpotBySecids(client, ['510300', '510300', '159915']);
    expect(requested).toBe(2);
    expect(items.map((item) => item.code)).toEqual(['510300', '159915']);
  });

  it('只回了一部分行（低于 90%）→ ParseError，宁可失败也不交出残缺快照', async () => {
    const client = stubClient((url) => {
      const codes = quoteUrlCodes(url);
      return respondWith(codes.slice(0, Math.floor(codes.length / 2)));
    });

    await expect(
      fetchEtfSpotBySecids(client, ['510300', '159915', '511990', '159985']),
    ).rejects.toThrow(ParseError);
  });

  it('代码池里没有可用的场内代码 → ParseError（调用方给错了池子）', async () => {
    const client = stubClient(() => respondWith([]));
    await expect(fetchEtfSpotBySecids(client, ['000001', 'abc'])).rejects.toThrow(ParseError);
  });

  it('上游不可用 → 原样抛出 UpstreamError（由服务层决定降级）', async () => {
    const client = stubClient(() => new UpstreamError('模拟：批量报价不可用'));
    await expect(fetchEtfSpotBySecids(client, ['510300'])).rejects.toThrow(UpstreamError);
  });
});
