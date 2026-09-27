import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError, UpstreamError } from '../errors.ts';
import {
  fetchGlobalClist,
  GLOBAL_CLIST_HOSTS,
  globalClistUrl,
  parseGlobalClist,
} from './eastmoney-clist.ts';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/eastmoney/global-index/${name}`, import.meta.url),
    'utf8',
  );
}

describe('parseGlobalClist —— 东财全球指数批量实时（概览缺失兜底）', () => {
  it('fltt=2 直读不除 100；secid = f13.f12，与注册表 em 字段同形', () => {
    const result = parseGlobalClist(fixture('clist-sample.json'), 8);
    expect(result.quotes).toHaveLength(8);
    expect(result.skippedRows).toBe(0);
    expect(result.missing).toBe(0);

    const spx = result.quotes.find((quote) => quote.secid === '100.SPX');
    expect(spx?.name).toBe('标普500');
    // 2026-09-25 收盘快照 —— 语义锚点（若误用 akshare 的 fltt=1 口径会得到 774341）
    expect(spx?.price).toBeCloseTo(7743.41, 2);
    expect(spx?.prevClose).toBeCloseTo(7704.13, 2);
    expect(spx?.open).toBeCloseTo(7709.86, 2);
    expect(spx?.high).toBeCloseTo(7752.07, 2);
    expect(spx?.low).toBeCloseTo(7693.08, 2);
    expect(spx?.changePct).toBeCloseTo(0.51, 2);
    // 涨跌 = 最新 − 昨收 与上游 f4 一致
    expect((spx?.price ?? 0) - (spx?.prevClose ?? 0)).toBeCloseTo(spx?.change ?? 0, 2);
  });

  it('注册表勘误的三个代码都在（akshare 线索：HSCEI/TSX/NZ50 东财是有的）', () => {
    const result = parseGlobalClist(fixture('clist-sample.json'), 8);
    const secids = result.quotes.map((quote) => quote.secid);
    expect(secids).toContain('100.HSCEI');
    expect(secids).toContain('100.TSX');
    expect(secids).toContain('100.NZ50');
    expect(secids).toContain('100.SSMI');
  });

  it('未知代码整批被拒（rc=102, data=null）→ UpstreamError（best-effort 由调用方吞掉）', () => {
    try {
      parseGlobalClist(fixture('clist-empty.json'), 2);
      throw new Error('本该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error).not.toBeInstanceOf(ParseError);
    }
  });

  it('非法 JSON → ParseError；非对象 → ParseError', () => {
    expect(() => parseGlobalClist('<html></html>', 1)).toThrow(ParseError);
    expect(() => parseGlobalClist('[1,2,3]', 1)).toThrow(ParseError);
  });

  it('total>0 却没有数据行 → ParseError（改版信号）；total=0 空回 → UpstreamError', () => {
    expect(() => parseGlobalClist('{"rc":0,"data":{"total":5,"diff":[]}}', 5)).toThrow(ParseError);
    expect(() => parseGlobalClist('{"rc":0,"data":{"total":0,"diff":[]}}', 5)).toThrow(
      UpstreamError,
    );
  });

  it('行级宽松：缺最新价（如减号占位）的行跳过并计数，missing 按请求数核算', () => {
    const text = JSON.stringify({
      rc: 0,
      data: {
        total: 3,
        diff: { '0': { f12: 'SPX', f13: 100, f14: '标普500', f2: 7743.41 } },
      },
    });
    const result = parseGlobalClist(text, 8);
    expect(result.quotes).toHaveLength(1);
    expect(result.missing).toBe(7);
  });
});

describe('globalClistUrl / fetchGlobalClist', () => {
  it('URL：fs 用 i: 显式清单（通配组合实测为空，这是 akshare 的可用写法）', () => {
    const url = globalClistUrl(['100.SPX', '100.HSI']);
    expect(url).toContain('fs=i%3A100.SPX%2Ci%3A100.HSI');
    expect(url).toContain('fltt=2');
    expect(url).toContain('/api/qt/clist/get?');
  });

  it('端点 HTTP 在前、HTTPS 兜底（与 push2his 同类的 https 抖动）', () => {
    expect(GLOBAL_CLIST_HOSTS[0]).toMatch(/^http:\/\//);
    expect(GLOBAL_CLIST_HOSTS.length).toBe(2);
  });

  it('空请求不打网络，直接回空结果', async () => {
    const client = {
      getText: async () => {
        throw new Error('不该被调用');
      },
    } as never;
    const result = await fetchGlobalClist(client, []);
    expect(result.quotes).toEqual([]);
  });

  it('主端点失败自动切备端点', async () => {
    let calls = 0;
    const client = {
      getText: async (url: string) => {
        calls += 1;
        if (url.startsWith('http://')) throw new Error('模拟 http 不通');
        return fixture('clist-sample.json');
      },
    } as never;
    const result = await fetchGlobalClist(client, ['100.SPX']);
    expect(calls).toBe(2);
    expect(result.quotes.length).toBe(8);
  });
});
