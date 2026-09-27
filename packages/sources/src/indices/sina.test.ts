import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError, UpstreamError } from '../errors.ts';
import {
  fetchSinaGlobalDaily,
  parseSinaGlobalDaily,
  SINA_GLOBAL_MAX_BARS,
  sinaGlobalDailyUrl,
} from './sina.ts';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/sina/global-index/${name}`, import.meta.url),
    'utf8',
  );
}

describe('parseSinaGlobalDaily —— 新浪环球市场全球指数日线（第四源）', () => {
  it('字段 d,o,h,l,c：收盘与开高低一致（用 2026-09-25 DAX 快照锚定）', () => {
    const series = parseSinaGlobalDaily(fixture('dax-daily.json'), 'DAX');
    expect(series.symbol).toBe('DAX');
    expect(series.skippedRows).toBe(0);
    // 上游硬上限 1000 行（num=10000 也只回 1000）
    expect(series.bars.length).toBe(SINA_GLOBAL_MAX_BARS);

    const last = series.bars.at(-1);
    expect(last?.date).toBe('2026-09-25');
    // 与 Yahoo/东财/TradingView 快照一致的 DAX 9/25 收盘 —— 语义锚点
    expect(last?.close).toBeCloseTo(25408.64, 2);
    expect(last?.open).toBeCloseTo(25441.79, 2);
    expect(last?.high).toBeCloseTo(25529.33, 2);
    expect(last?.low).toBeCloseTo(25347.3, 2);
    expect(last?.high ?? 0).toBeGreaterThanOrEqual(last?.close ?? 0);
    expect(last?.close ?? 0).toBeGreaterThanOrEqual(last?.low ?? 0);
  });

  it('数值是字符串、按日期升序、同日去重', () => {
    const series = parseSinaGlobalDaily(fixture('dax-daily.json'), 'DAX');
    const dates = series.bars.map((bar) => bar.date);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(dates).size).toBe(dates.length);
    expect(typeof series.bars[0]?.close).toBe('number');
  });

  it('未知符号（code=20001, data={}）→ UpstreamError，交降级链下一环', () => {
    try {
      parseSinaGlobalDaily(fixture('no-data.json'), 'INX');
      throw new Error('本该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error).not.toBeInstanceOf(ParseError);
      expect((error as UpstreamError).message).toContain('INX');
    }
  });

  it('非法 JSON → ParseError（上游改版/被拦截信号，不能伪装成「没有数据」）', () => {
    expect(() => parseSinaGlobalDaily('<html>blocked</html>', 'DAX')).toThrow(ParseError);
  });

  it('缺 result 节点 → ParseError；result.data 非数组 → ParseError；空数组 → UpstreamError', () => {
    expect(() => parseSinaGlobalDaily('{"code":0}', 'DAX')).toThrow(ParseError);
    expect(() => parseSinaGlobalDaily('{"code":0,"result":{"data":{}}}', 'DAX')).toThrow(
      ParseError,
    );
    expect(() => parseSinaGlobalDaily('{"code":0,"result":{"data":[]}}', 'DAX')).toThrow(
      UpstreamError,
    );
  });

  it('行级宽松：日期非法/收盘缺失的行跳过并计数，不整批失败', () => {
    const text = JSON.stringify({
      code: 0,
      result: {
        data: [
          { d: '2026-09-24', c: '100.5', o: '99', h: '101', l: '98' },
          { d: 'not-a-date', c: '102' },
          { d: '2026-09-25', c: '--' },
          { d: '2026-09-25', c: '101.5', o: '100', h: '102', l: '99' },
        ],
      },
    });
    const series = parseSinaGlobalDaily(text, 'X');
    expect(series.skippedRows).toBe(2);
    expect(series.bars).toHaveLength(2);
    expect(series.bars[1]?.close).toBe(101.5);
  });

  it('全批无有效行 → ParseError（不是静默空数据）', () => {
    const text = JSON.stringify({ code: 0, result: { data: [{ d: 'bad', c: 'x' }] } });
    expect(() => parseSinaGlobalDaily(text, 'DAX')).toThrow(ParseError);
  });
});

describe('sinaGlobalDailyUrl / fetchSinaGlobalDaily', () => {
  it('URL：symbol 进查询参数，默认行数为上游硬上限', () => {
    const url = sinaGlobalDailyUrl('DAX');
    expect(url).toContain('symbol=DAX');
    expect(url).toContain(`num=${SINA_GLOBAL_MAX_BARS}`);
  });

  it('since 过滤回看 10 天（与东财 beg 同口径），不传保留全部', async () => {
    const client = {
      getText: async () => fixture('dax-daily.json'),
    } as never;
    const all = await fetchSinaGlobalDaily(client, 'DAX');
    expect(all.bars.length).toBe(SINA_GLOBAL_MAX_BARS);

    // fixture 最后一天是 2026-09-25：since=2026-09-20 → 保留 09-10（回看 10 天）之后
    const incremental = await fetchSinaGlobalDaily(client, 'DAX', { since: '2026-09-20' });
    expect(incremental.bars.length).toBeGreaterThan(0);
    expect(incremental.bars.length).toBeLessThan(SINA_GLOBAL_MAX_BARS);
    expect((incremental.bars[0]?.date ?? '') >= '2026-09-10').toBe(true);
    expect(incremental.bars.at(-1)?.date).toBe('2026-09-25');
  });
});
