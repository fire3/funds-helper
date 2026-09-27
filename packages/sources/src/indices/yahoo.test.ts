import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError, UpstreamError } from '../errors.ts';
import {
  fetchYahooDailyBars,
  parseYahooChart,
  resetYahooRateLimitState,
  yahooChartUrl,
} from './yahoo.ts';

function fixture(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/yahoo/chart/${name}`, import.meta.url), 'utf8');
}

describe('parseYahooChart —— Yahoo 指数日线', () => {
  it('解析 meta（币种/时区）与日线，按日期升序', () => {
    const series = parseYahooChart(fixture('gspc-daily.json'));
    expect(series.symbol).toBe('^GSPC');
    expect(series.currency).toBe('USD');
    expect(series.timeZone).toBe('America/New_York');
    expect(series.bars.length).toBe(10);
    expect(series.skippedRows).toBe(0);

    const dates = series.bars.map((bar) => bar.date);
    expect(dates).toEqual([...dates].sort());
    expect(dates[0]).toBe('1970-01-02');
  });

  it('日期按交易所时区换算：纽约 13:30/14:30 UTC 的开盘时间戳 → 当地日期', () => {
    const series = parseYahooChart(fixture('gspc-daily.json'));
    const last = series.bars.at(-1);
    // 末行时间戳 1790365380 = 2026-09-25 13:30 UTC = 纽约 09:30 —— 用 UTC 裁剪在冬令时会得到同日，
    // 但夏令时切换附近可能偏一天，因此按 meta.exchangeTimezoneName 换算（实测口径）
    expect(last?.date).toBe('2026-09-25');
    expect(last?.close).toBeCloseTo(7743.41, 2);
  });

  it('非美时区（Asia/Tokyo）同样得到交易所当地日期', () => {
    const series = parseYahooChart(fixture('n225-daily.json'));
    expect(series.timeZone).toBe('Asia/Tokyo');
    expect(series.currency).toBe('JPY');
    expect(series.bars.at(-1)?.date).toBe('2026-09-25');
    // 日经的时间戳在 UTC 午夜附近：若误用 UTC+9 直接加减会偏一天，fixture 断言锁住实测结果
    const dates = series.bars.map((bar) => bar.date);
    expect(dates).toEqual([...dates].sort());
  });

  it('OHLC 全空的行被跳过并计数（行级宽松），其余行照常解析', () => {
    const series = parseYahooChart(fixture('null-rows.json'));
    expect(series.skippedRows).toBe(1);
    expect(series.bars.length).toBe(9);
    expect(series.bars.some((bar) => bar.close === null)).toBe(false);
  });

  it('chart.error 非 null（符号不存在）→ UpstreamError，交给备源', () => {
    expect(() => parseYahooChart(fixture('not-found.json'))).toThrow(UpstreamError);
    try {
      parseYahooChart(fixture('not-found.json'));
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toContain('No data found');
      // 不能是 ParseError：这不是「改版」，换一个上游（东财）还能继续
      expect(error).not.toBeInstanceOf(ParseError);
    }
  });

  it('timestamps 与 close 长度不齐 → ParseError（结构级严格）', () => {
    const payload = JSON.parse(fixture('gspc-daily.json')) as Record<string, unknown>;
    const chart = payload.chart as { result: { timestamp: number[] }[] };
    chart.result[0]?.timestamp.push(1_790_000_000);
    expect(() => parseYahooChart(JSON.stringify(payload))).toThrow(ParseError);
    expect(() => parseYahooChart(JSON.stringify(payload))).toThrow(/长度不一致/);
  });

  it('非 JSON 响应 → ParseError 并带排障片段', () => {
    expect(() => parseYahooChart('<html>403 Forbidden</html>')).toThrow(ParseError);
    expect(() => parseYahooChart('<html>403 Forbidden</html>')).toThrow(/403/);
  });

  it('解析后没有任何有效行 → ParseError（不静默返回空）', () => {
    // 结构：chart.result[0].indicators.quote[0].close
    interface QuoteBlock {
      close: (number | null)[];
    }
    interface ResultBlock {
      indicators: { quote: QuoteBlock[] };
    }
    const payload = JSON.parse(fixture('gspc-daily.json')) as {
      chart: { result: ResultBlock[] };
    };
    payload.chart.result[0]?.indicators.quote[0]?.close.fill(null);
    expect(() => parseYahooChart(JSON.stringify(payload))).toThrow(/没有任何有效日线/);
  });
});

describe('yahooChartUrl —— 全量与增量', () => {
  const now = Date.parse('2026-09-26T00:00:00.000Z');

  it('不带 since = 全量（period1=0）—— range=max 会被降级成月线，所以永远走 period1/period2', () => {
    const url = new URL(yahooChartUrl('^GSPC', { now }));
    expect(url.searchParams.get('period1')).toBe('0');
    expect(url.searchParams.get('interval')).toBe('1d');
    expect(Number(url.searchParams.get('period2'))).toBeGreaterThan(Math.floor(now / 1000));
  });

  it('带 since = 增量，且往前多留 10 天修订余量', () => {
    const url = new URL(yahooChartUrl('^GSPC', { since: '2026-09-20', now }));
    const period1 = Number(url.searchParams.get('period1'));
    expect(period1).toBe(Math.floor(Date.parse('2026-09-10T00:00:00Z') / 1000));
  });

  it('符号会被 URL 编码（^GSPC → %5EGSPC）', () => {
    expect(yahooChartUrl('^GSPC', { now })).toContain('%5EGSPC');
  });
});

describe('fetchYahooDailyBars —— 编排与 429 退避', () => {
  const body = fixture('gspc-daily.json');

  /** 传输层替身：按调用次序返回文本或抛 429（真实上游的限流不可控，只能靠桩测） */
  function stubClient(outcomes: ('ok' | 'rate-limited')[]) {
    let call = 0;
    return {
      getText: async () => {
        const outcome = outcomes[Math.min(call, outcomes.length - 1)] ?? 'ok';
        call += 1;
        if (outcome === 'rate-limited') {
          throw new UpstreamError('上游返回 HTTP 429', { status: 429 });
        }
        return body;
      },
    } as unknown as Parameters<typeof fetchYahooDailyBars>[0];
  }

  it('把响应交给解析器，并原样携带 symbol', async () => {
    const series = await fetchYahooDailyBars(stubClient(['ok']), '^GSPC');
    expect(series.symbol).toBe('^GSPC');
    expect(series.bars.length).toBe(10);
  });

  it('首次 429 → 退避一次后重试成功（Yahoo 限流窗口以分钟计，不是改版）', async () => {
    resetYahooRateLimitState();
    const series = await fetchYahooDailyBars(stubClient(['rate-limited', 'ok']), '^GSPC', {
      rateLimitBackoffMs: 1,
    });
    expect(series.bars.length).toBe(10);
  });

  it('退避后仍 429 → 抛给备源，且进入冷却：窗口内的后续请求**快速失败**、不再打上游', async () => {
    resetYahooRateLimitState();
    let calls = 0;
    const client = {
      getText: async () => {
        calls += 1;
        throw new UpstreamError('上游返回 HTTP 429', { status: 429 });
      },
    } as unknown as Parameters<typeof fetchYahooDailyBars>[0];

    await expect(
      fetchYahooDailyBars(client, '^GSPC', { rateLimitBackoffMs: 2_000 }),
    ).rejects.toThrow(UpstreamError);
    expect(calls).toBe(2); // 首次 + 退避后重试

    // 冷却窗口（2s，抛错时刻重设）未过：必须立刻拒绝，**不能**产生第 3 次上游调用
    await expect(
      fetchYahooDailyBars(client, '^GSPC', { rateLimitBackoffMs: 2_000 }),
    ).rejects.toThrow(/冷却窗口/);
    expect(calls).toBe(2);
  });

  it('重试成功后清除冷却窗口，后续请求照常打上游', async () => {
    resetYahooRateLimitState();
    const client = stubClient(['rate-limited', 'ok', 'ok']);
    await fetchYahooDailyBars(client, '^GSPC', { rateLimitBackoffMs: 1 });
    // 窗口已清：再次调用应真正命中上游（stub 返回第 3 个 'ok'）
    const series = await fetchYahooDailyBars(client, '^GSPC', { rateLimitBackoffMs: 1 });
    expect(series.bars.length).toBe(10);
  });

  it('非 429 错误不进入退避逻辑（改版/404 等直接抛）', async () => {
    resetYahooRateLimitState();
    const client = {
      getText: async () => {
        throw new UpstreamError('上游返回 HTTP 404', { status: 404 });
      },
    } as unknown as Parameters<typeof fetchYahooDailyBars>[0];
    await expect(fetchYahooDailyBars(client, '^GSPC', { rateLimitBackoffMs: 1 })).rejects.toThrow(
      '404',
    );
  });
});
