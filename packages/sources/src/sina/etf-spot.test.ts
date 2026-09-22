import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError, UpstreamError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import {
  fetchSinaEtfSpot,
  parseSinaEtfCount,
  parseSinaEtfListPage,
  SINA_ETF_PAGE_SIZE,
} from './etf-spot.ts';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/sina/etf-spot/${name}`, import.meta.url),
    'utf8',
  );
}

/** 传输层替身：分页与护栏是**编排逻辑**，只能靠桩来测（真实上游不可控） */
function stubClient(handler: (url: string) => string | Error): HttpClient {
  return {
    getText: async (url: string) => {
      const result = handler(url);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as HttpClient;
}

function rowObj(symbol: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol,
    code: symbol.slice(2),
    name: `样例${symbol}`,
    trade: '1.000',
    pricechange: 0.01,
    changepercent: 0.5,
    settlement: '0.990',
    open: '0.995',
    high: '1.010',
    low: '0.990',
    volume: 123_400,
    amount: 123_400,
    ticktime: '15:00:00',
    turnoverratio: 1.23,
    nmc: 10_000,
    ...overrides,
  };
}
function row(symbol: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(rowObj(symbol, overrides));
}

describe('parseSinaEtfListPage —— 备用源（新浪 ETF 列表）', () => {
  it('解析整页：100 行（真实响应）', () => {
    const items = parseSinaEtfListPage(fixture('list-page.json'));
    expect(items).toHaveLength(SINA_ETF_PAGE_SIZE);
  });

  it('字段映射：字符串转数值、股换算成手、市值万元换算成元', () => {
    const items = parseSinaEtfListPage(fixture('list-page.json'));
    const target = items.find((item) => item.code === '510300');

    expect(target).toMatchObject({
      code: '510300',
      name: '沪深300ETF华泰柏瑞',
      market: 1,
      price: 4.613,
      changePct: 0.109,
      changeAmt: 0.005,
      open: 4.636,
      high: 4.658,
      low: 4.612,
      prevClose: 4.608,
      amount: 2_987_237_086,
      turnover: 2.71821,
      // 没有的字段必须是 null，而不是 0 / 假值
      volumeRatio: null,
      floatScale: null,
      discountRate: null,
      listingDate: null,
      mainInflow: null,
      quoteTs: null,
    });
    // 成交量：新浪是股，接口口径是手
    expect(target?.volume).toBeCloseTo(6_445_873.51, 2);
    // 规模：nmc（万元）→ 元，与东财 f20（1093.91 亿）一致
    expect(target?.scale).toBeCloseTo(109_391_241_360.1, 1);
    // 振幅由 (高−低)/昨收 推导，与东财 f7 同口径
    expect(target?.amplitude).toBeCloseTo(0.998, 3);
  });

  it('深市代码按前缀判定交易所', () => {
    const items = parseSinaEtfListPage(`[${row('sz159915')}]`);
    expect(items[0]?.market).toBe(0);
    expect(items[0]?.code).toBe('159915');
  });

  it('缺名称 / 非 sh、sz 前缀的行被跳过（不污染唯一键与统计）', () => {
    const items = parseSinaEtfListPage(
      `[${row('sh510300')},{"symbol":"bj430047","name":"样例"},{"symbol":"sh510301"}]`,
    );
    expect(items.map((item) => item.code)).toEqual(['510300']);
  });

  it('越界页码返回 null → 空数组（不是错误）', () => {
    expect(parseSinaEtfListPage('null')).toEqual([]);
  });

  it('非 JSON / 非数组 → ParseError', () => {
    expect(() => parseSinaEtfListPage('<html>')).toThrow(ParseError);
    expect(() => parseSinaEtfListPage('{"symbol":"sh510300"}')).toThrow(ParseError);
  });
});

describe('parseSinaEtfCount —— 总数', () => {
  it('真实响应是 JSON 字符串 "1676"', () => {
    expect(parseSinaEtfCount(fixture('count.json'))).toBe(1676);
  });

  it('数量爆掉 → ParseError（防止翻上千页）', () => {
    expect(() => parseSinaEtfCount('999999')).toThrow(ParseError);
  });

  it('非数字 → ParseError', () => {
    expect(() => parseSinaEtfCount('null')).toThrow(ParseError);
  });
});

describe('fetchSinaEtfSpot —— 翻页与护栏', () => {
  const countOf = (n: number): string => JSON.stringify(String(n));

  it('按总数翻到最后一页（满页继续、不足一页结束）', () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => rowObj(`sh51${String(i).padStart(4, '0')}`)),
      Array.from({ length: 100 }, (_, i) => rowObj(`sz15${String(i).padStart(4, '0')}`)),
      Array.from({ length: 50 }, (_, i) => rowObj(`sh58${String(i).padStart(4, '0')}`)),
    ];
    const client = stubClient((url) => {
      if (url.includes('getHQNodeStockCount')) return countOf(250);
      const page = Number(new URL(url).searchParams.get('page'));
      return JSON.stringify(pages[page - 1] ?? []);
    });

    return expect(fetchSinaEtfSpot(client)).resolves.toHaveLength(250);
  });

  it('按代码去重（翻页期间列表抖动导致同一只重复出现）', async () => {
    const client = stubClient((url) => {
      if (url.includes('getHQNodeStockCount')) return countOf(1);
      return `[${row('sh510300')},${row('sh510300')}]`;
    });
    const items = await fetchSinaEtfSpot(client);
    expect(items.map((item) => item.code)).toEqual(['510300']);
  });

  it('只取到不足 90% → ParseError（宁可报错也不要残缺快照）', async () => {
    const client = stubClient((url) => {
      if (url.includes('getHQNodeStockCount')) return countOf(1000);
      const page = Number(new URL(url).searchParams.get('page'));
      return page === 1
        ? JSON.stringify(
            Array.from({ length: 100 }, (_, i) => rowObj(`sh51${String(i).padStart(4, '0')}`)),
          )
        : '[]';
    });
    await expect(fetchSinaEtfSpot(client)).rejects.toThrow(ParseError);
  });

  it('一行都没有 → ParseError', async () => {
    const client = stubClient((url) => (url.includes('getHQNodeStockCount') ? countOf(0) : '[]'));
    await expect(fetchSinaEtfSpot(client)).rejects.toThrow(ParseError);
  });

  it('数量接口挂掉 → 原样抛出（上层据此决定是否降级）', async () => {
    const client = stubClient(() => new UpstreamError('模拟：新浪不可用'));
    await expect(fetchSinaEtfSpot(client)).rejects.toThrow(UpstreamError);
  });
});
