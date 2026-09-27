import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError, UpstreamError } from '../errors.ts';
import {
  fetchTencentDailyBars,
  parseTencentKline,
  TENCENT_MAX_BARS,
  tencentKlineUrl,
} from './tencent.ts';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/tencent/kline/${name}`, import.meta.url),
    'utf8',
  );
}

describe('parseTencentKline —— 腾讯全球指数日线（应急源）', () => {
  it('字段序 date,open,close,high,low,amount：收盘在第 3 列', () => {
    const series = parseTencentKline(fixture('hkhsi-kline.json'), 'hkHSI');
    expect(series.code).toBe('hkHSI');
    expect(series.skippedRows).toBe(0);
    expect(series.bars.length).toBe(3);

    const last = series.bars.at(-1);
    expect(last?.date).toBe('2026-09-25');
    // 与 Yahoo/东财/TradingView 快照一致的恒生 9/25 收盘 —— 语义锚点
    expect(last?.close).toBeCloseTo(24510.09, 2);
    expect(last?.open).toBeCloseTo(24523.5, 2);
    // 若误按 date,open,high,low,close 解析，close 会变成 24275.56（当日最低）
    expect(last?.high ?? 0).toBeGreaterThanOrEqual(last?.close ?? 0);
    expect(last?.close ?? 0).toBeGreaterThanOrEqual(last?.low ?? 0);
  });

  it('响应 key 归一化：参数 usDJI → data["us.DJI"]，取第一个 entry 而不是用参数拼', () => {
    const series = parseTencentKline(fixture('usdji-kline.json'), 'usDJI');
    const last = series.bars.at(-1);
    expect(last?.date).toBe('2026-09-25');
    // 道指 9/25 收盘，与快照一致
    expect(last?.close).toBeCloseTo(51828.62, 2);
  });

  it('输出按日期升序、同日去重', () => {
    const series = parseTencentKline(fixture('hkhsi-kline.json'), 'hkHSI');
    const dates = series.bars.map((bar) => bar.date);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('错误符号（day: []）→ UpstreamError，交上层降级，不是静默空数据', () => {
    try {
      parseTencentKline(fixture('no-data.json'), 'usSPX');
      throw new Error('本该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error).not.toBeInstanceOf(ParseError);
      expect((error as UpstreamError).message).toContain('usSPX');
    }
  });

  it('data 为 []（实测 param error 形态）→ ParseError（形态异常，不是「没有该标的」）', () => {
    expect(() => parseTencentKline(fixture('malformed.json'), 'usDJI')).toThrow(ParseError);
    expect(() => parseTencentKline(fixture('malformed.json'), 'usDJI')).toThrow(/data 对象/);
  });

  it('首行元素数变化 → ParseError（结构级严格，上游改版信号）', () => {
    const payload = JSON.parse(fixture('hkhsi-kline.json')) as {
      data: Record<string, { day: unknown[][] }>;
    };
    const entry = Object.values(payload.data)[0];
    if (entry) entry.day[0] = ['2026-09-23', 1, 2, 3]; // 6 → 4 列
    expect(() => parseTencentKline(JSON.stringify(payload), 'hkHSI')).toThrow(/列数异常/);
  });

  it('非 JSON 响应 → ParseError', () => {
    expect(() => parseTencentKline('<html>502 Bad Gateway</html>', 'hkHSI')).toThrow(ParseError);
  });
});

describe('tencentKlineUrl —— count 参数', () => {
  it('默认请求全量上限 1600 行', () => {
    const url = new URL(tencentKlineUrl('hkHSI'));
    expect(url.searchParams.get('param')).toBe(`hkHSI,day,,,${TENCENT_MAX_BARS}`);
  });

  it('增量模式只要最近若干行', () => {
    const url = new URL(tencentKlineUrl('usDJI', { count: 40 }));
    expect(url.searchParams.get('param')).toBe('usDJI,day,,,40');
  });
});

describe('fetchTencentDailyBars —— 编排', () => {
  it('把响应交给解析器', async () => {
    const client = {
      getText: async () => fixture('usdji-kline.json'),
    } as unknown as Parameters<typeof fetchTencentDailyBars>[0];
    const series = await fetchTencentDailyBars(client, 'usDJI');
    expect(series.code).toBe('usDJI');
    expect(series.bars.at(-1)?.close).toBeCloseTo(51828.62, 2);
  });
});
