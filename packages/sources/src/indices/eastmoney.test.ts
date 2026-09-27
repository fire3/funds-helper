import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError, UpstreamError } from '../errors.ts';
import {
  fetchGlobalIndexKline,
  GLOBAL_INDEX_KLINE_HOSTS,
  globalIndexKlineUrl,
  parseGlobalIndexKline,
} from './eastmoney.ts';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/eastmoney/global-index/${name}`, import.meta.url),
    'utf8',
  );
}

describe('parseGlobalIndexKline —— 东财全球指数日线', () => {
  it('字段序 date,open,close,high,low（用高≥收≥低交叉验证）', () => {
    const series = parseGlobalIndexKline(fixture('spx-kline.json'), '100.SPX');
    expect(series.secid).toBe('100.SPX');
    expect(series.name).toBe('标普500');
    expect(series.skippedRows).toBe(0);
    expect(series.bars.length).toBeGreaterThan(10);

    const first = series.bars[0];
    expect(first?.date).toBe('2026-09-01');
    expect(first?.close).toBe(7631.47);
    expect(first?.open).toBe(7635.47);
    expect(first?.high).toBe(7663.63);
    expect(first?.low).toBe(7611.2);
    // 若把 close/high/low 顺序解析错，这条不变量会破
    expect(first?.high ?? 0).toBeGreaterThanOrEqual(first?.close ?? 0);
    expect(first?.close ?? 0).toBeGreaterThanOrEqual(first?.low ?? 0);
  });

  it('输出按日期升序、同日去重', () => {
    const series = parseGlobalIndexKline(fixture('spx-kline.json'), '100.SPX');
    const dates = series.bars.map((bar) => bar.date);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('secid 不存在（data: null, rc=100）→ UpstreamError，不是静默空数据', () => {
    try {
      parseGlobalIndexKline(fixture('data-null.json'), '100.HSTECH');
      throw new Error('本该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error).not.toBeInstanceOf(ParseError);
      expect((error as UpstreamError).message).toContain('100.HSTECH');
    }
  });

  it('脏行（日期非法）跳过并计数，其余行照常解析（行级宽松）', () => {
    const series = parseGlobalIndexKline(fixture('dirty-rows.json'), '100.SPX');
    expect(series.skippedRows).toBe(1);
    expect(series.bars.length).toBe(4);
  });

  it('列数变化 → ParseError（结构级严格，上游改版信号）', () => {
    expect(() => parseGlobalIndexKline(fixture('column-changed.json'), '100.SPX')).toThrow(
      ParseError,
    );
    expect(() => parseGlobalIndexKline(fixture('column-changed.json'), '100.SPX')).toThrow(
      /列数异常/,
    );
  });

  it('非 JSON → ParseError', () => {
    expect(() =>
      parseGlobalIndexKline('<html>503 Service Temporarily Unavailable</html>', '100.SPX'),
    ).toThrow(ParseError);
  });
});

describe('globalIndexKlineUrl —— 全量与增量', () => {
  /** fetch 拼接主备 host，这里给个基准 host 就能用 URL API 断言参数 */
  const parse = (path: string): URL => new URL(path, 'http://push2his.eastmoney.com');

  it('不带 since = 全量（beg=19000101，实测道指 1990-04-25 起）', () => {
    const url = parse(globalIndexKlineUrl('100.DJIA'));
    expect(url.searchParams.get('secid')).toBe('100.DJIA');
    expect(url.searchParams.get('klt')).toBe('101');
    expect(url.searchParams.get('beg')).toBe('19000101');
    expect(url.searchParams.get('end')).toBe('20500101');
    expect(url.searchParams.get('fields2')).toBe('f51,f52,f53,f54,f55');
  });

  it('带 since = 增量，往前多留 10 天（YYYYMMDD 格式）', () => {
    const url = parse(globalIndexKlineUrl('100.DJIA', { since: '2026-09-20' }));
    expect(url.searchParams.get('beg')).toBe('20260910');
  });
});

describe('fetchGlobalIndexKline —— 主备端点', () => {
  /** 传输层替身：按 URL 返回文本或抛错（编排逻辑只能靠桩测，真实上游会限流） */
  function stubClient(handler: (url: string) => string | Error) {
    return {
      getText: async (url: string) => {
        const result = handler(url);
        if (result instanceof Error) throw result;
        return result;
      },
    } as unknown as Parameters<typeof fetchGlobalIndexKline>[0];
  }

  it('端点顺序是 http 在前（HTTPS 抖动是实测事实）', () => {
    expect(GLOBAL_INDEX_KLINE_HOSTS[0]).toMatch(/^http:\/\//);
  });

  it('首端点成功即返回；失败自动切下一端点', async () => {
    const body = fixture('spx-kline.json');
    let calls = 0;
    const okClient = stubClient(() => {
      calls += 1;
      return body;
    });
    const series = await fetchGlobalIndexKline(okClient, '100.SPX');
    expect(series.name).toBe('标普500');
    expect(calls).toBe(1);

    let failCalls = 0;
    const failoverClient = stubClient((url) => {
      if (url.startsWith('http://')) {
        failCalls += 1;
        return new Error('模拟：连接被重置');
      }
      failCalls += 1;
      return body;
    });
    await fetchGlobalIndexKline(failoverClient, '100.SPX');
    expect(failCalls).toBe(2);
  });

  it('主备都失败时抛出最后一个错误', async () => {
    const client = stubClient(() => new Error('模拟：两个端点都不可达'));
    await expect(fetchGlobalIndexKline(client, '100.SPX')).rejects.toThrow('两个端点都不可达');
  });
});
