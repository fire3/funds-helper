import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError } from '../errors.ts';
import { parseFxDailyKline, USD_CNY_SYMBOL } from './fx-daily.ts';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/sina/fx-daily/${name}`, import.meta.url),
    'utf8',
  );
}

describe('parseFxDailyKline —— 新浪外汇日线', () => {
  it('剥离 JSONP 外壳，按 | 分行、, 分列', () => {
    const series = parseFxDailyKline(fixture('normal.js.txt'));
    expect(series.symbol).toBe(USD_CNY_SYMBOL);
    expect(series.bars).toHaveLength(18);
    expect(series.skippedRows).toBe(0);
  });

  it('字段序是 date,open,low,high,close（用 811 汇改验证 low 在 high 之前）', () => {
    const series = parseFxDailyKline(fixture('normal.js.txt'));
    const crash = series.bars.find((bar) => bar.date === '2015-08-11');
    expect(crash).toEqual({
      date: '2015-08-11',
      open: 6.3101,
      low: 6.2856,
      high: 6.3286,
      close: 6.3248,
    });
    // 若误按 open,high,low,close 解析，这里会出现「最高 < 最低」
    expect(crash?.low).toBeLessThan(crash?.high ?? 0);
  });

  it('2005 汇改与 1994 起始段都在（数十年历史的证据）', () => {
    const series = parseFxDailyKline(fixture('normal.js.txt'));
    expect(series.bars.find((bar) => bar.date === '2005-07-21')?.close).toBe(8.2765);
    expect(series.bars.find((bar) => bar.date === '2005-07-22')?.close).toBe(8.11);
    expect(series.bars[0]?.date).toBe('1994-08-30');
    expect(series.bars.at(-1)?.date).toBe('2026-09-18');
    expect(series.bars.at(-1)?.close).toBe(6.6984);
  });

  it('早期行四列相同（固定汇率时期）也能解析', () => {
    const series = parseFxDailyKline(fixture('normal.js.txt'));
    expect(series.bars[0]).toEqual({
      date: '1994-08-30',
      open: 8.5616,
      low: 8.5616,
      high: 8.5616,
      close: 8.5616,
    });
  });

  it('输出按日期升序', () => {
    const dates = parseFxDailyKline(fixture('normal.js.txt')).bars.map((bar) => bar.date);
    expect(dates).toEqual([...dates].sort());
  });
});

describe('parseFxDailyKline —— 行级宽松', () => {
  it('日期非法或缺收盘价的行被跳过并计数，其余行照常解析', () => {
    const series = parseFxDailyKline(fixture('sparse-rows.js.txt'));
    expect(series.bars.map((bar) => bar.date)).toEqual(['1994-08-30', '1994-09-02']);
    expect(series.skippedRows).toBe(2);
  });
});

describe('parseFxDailyKline —— 结构校验（上游改版必须显式暴露）', () => {
  it('缺少 JSONP 外壳 → ParseError', () => {
    expect(() => parseFxDailyKline(fixture('missing-wrapper.js.txt'))).toThrow(ParseError);
  });

  it('列数变更 → ParseError，并在信息里指出实际列数', () => {
    expect(() => parseFxDailyKline(fixture('column-changed.js.txt'))).toThrow(/列数异常/);
  });

  it('空载荷 → ParseError（绝不静默返回空数据）', () => {
    expect(() => parseFxDailyKline(fixture('empty.js.txt'))).toThrow(ParseError);
  });
});

describe('parseFxDailyKline —— 幂等与去重', () => {
  it('同一天出现两次时保留后者，且不重复计数', () => {
    const series = parseFxDailyKline(
      'x("2026-09-18,6.70,6.68,6.71,6.69,|2026-09-18,6.70,6.68,6.71,6.70")',
    );
    expect(series.bars).toHaveLength(1);
    expect(series.bars[0]?.close).toBe(6.7);
  });

  it('行尾多余逗号不影响列数判定', () => {
    const series = parseFxDailyKline('x("2026-09-18,6.70,6.68,6.71,6.69,")');
    expect(series.bars).toHaveLength(1);
  });
});
