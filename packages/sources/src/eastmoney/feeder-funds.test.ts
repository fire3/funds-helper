import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HttpClient } from '../http.ts';
import {
  FEEDER_SCAN_CONCURRENCY,
  fetchFeederTarget,
  fetchFeederTargets,
  toFeederTarget,
} from './feeder-funds.ts';
import { parseHoldings } from './holdings.ts';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/eastmoney/holdings/${name}`, import.meta.url),
    'utf8',
  );
}

/** 传输层替身：只关心「编排逻辑」（并发/分流），真实上游不可控 */
function stubClient(handler: (url: string) => string | Error): HttpClient {
  return {
    getText: async (url: string) => {
      const result = handler(url);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as HttpClient;
}

function holdingsResponse(etfCode: string | null, expansion = '2026-06-30'): string {
  return JSON.stringify({
    Datas: { fundStocks: [], fundboods: [], fundfofs: [], ETFCODE: etfCode, ETFSHORTNAME: '某ETF' },
    Expansion: expansion,
    ErrCode: 0,
    Success: true,
  });
}

describe('toFeederTarget —— 接口 I 的联接基金字段', () => {
  it('联接基金：fundStocks 为空，目标 ETF 取 ETFCODE，报告期取自响应顶层', () => {
    const data = parseHoldings(fixture('linked-fund.json'));
    expect(data.stocks).toEqual([]);
    expect(toFeederTarget(data)).toEqual({
      etfCode: '159941',
      etfName: '纳指ETF广发',
      reportDate: '2026-06-30',
    });
  });

  it('普通股票基金没有 ETFCODE → null（不能把股票基金当成联接基金）', () => {
    expect(toFeederTarget(parseHoldings(fixture('direct-stock.json')))).toBeNull();
  });

  it('ETFCODE 是脏值（非 6 位数字）时按「没查到」处理，不写进库', () => {
    for (const dirty of ['', '15994', '1599411', 'ABCDEF', '--']) {
      const data = parseHoldings(holdingsResponse(dirty));
      expect(toFeederTarget(data)).toBeNull();
    }
  });

  it('上游不给报告期时 reportDate 为 null（新成立的联接基金可能如此）', () => {
    const data = parseHoldings(holdingsResponse('510300', ''));
    expect(toFeederTarget(data)?.reportDate).toBeNull();
  });
});

describe('fetchFeederTarget —— 单只反查', () => {
  it('请求带上 FCODE，并复用接口 I 的解析', async () => {
    let seen = '';
    const client = stubClient((url) => {
      seen = url;
      return fixture('linked-fund.json');
    });
    const target = await fetchFeederTarget(client, '270042');
    expect(new URL(seen).searchParams.get('FCODE')).toBe('270042');
    expect(target?.etfCode).toBe('159941');
  });
});

describe('fetchFeederTargets —— 批量反查的编排', () => {
  it('把结果分成「拿到目标 ETF / 上游为空 / 请求失败」三类，单只失败不影响整轮', async () => {
    const result = await fetchFeederTargets(
      stubClient(() => ''),
      ['a1', 'a2', 'a3', 'a4'],
      {
        fetchOne: async (code) => {
          if (code === 'a1')
            return { etfCode: '510300', etfName: '沪深300ETF华泰柏瑞', reportDate: null };
          if (code === 'a2') return null; // 上游没给 ETFCODE
          throw new Error(`模拟失败：${code}`); // a3 / a4
        },
      },
    );

    expect([...result.targets.keys()]).toEqual(['a1']);
    expect(result.empty).toEqual(['a2']);
    expect(result.failed.sort()).toEqual(['a3', 'a4']);
  });

  it('并发不超过上限（全量 2319 只不能把上游打穿）', async () => {
    let inFlight = 0;
    let peak = 0;
    const codes = Array.from({ length: 40 }, (_, i) => `c${i}`);
    await fetchFeederTargets(
      stubClient(() => ''),
      codes,
      {
        concurrency: 4,
        fetchOne: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return null;
        },
      },
    );
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('默认并发就是导出的常量（改小它要连文档一起改）', async () => {
    let inFlight = 0;
    let peak = 0;
    const codes = Array.from({ length: FEEDER_SCAN_CONCURRENCY * 3 }, (_, i) => `d${i}`);
    await fetchFeederTargets(
      stubClient(() => ''),
      codes,
      {
        fetchOne: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return null;
        },
      },
    );
    expect(peak).toBe(FEEDER_SCAN_CONCURRENCY);
  });

  it('进度回调按「已完成 / 总数」推进，且最终等于总数', async () => {
    const seen: [number, number][] = [];
    await fetchFeederTargets(
      stubClient(() => ''),
      ['e1', 'e2', 'e3'],
      {
        concurrency: 2,
        fetchOne: async () => null,
        onProgress: (done, total) => seen.push([done, total]),
      },
    );
    expect(seen).toHaveLength(3);
    expect(seen.at(-1)).toEqual([3, 3]);
  });

  it('空候选列表直接返回空结果（不发起任何请求）', async () => {
    let called = 0;
    const result = await fetchFeederTargets(
      stubClient(() => ''),
      [],
      {
        fetchOne: async () => {
          called += 1;
          return null;
        },
      },
    );
    expect(called).toBe(0);
    expect(result.targets.size).toBe(0);
    expect(result.empty).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});
