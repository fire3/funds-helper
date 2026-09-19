import { describe, expect, it } from 'vitest';
import { trendClass } from './format.ts';

describe('trendClass —— 涨跌配色（正红负绿）', () => {
  it('正数 → 红', () => {
    expect(trendClass(1.23)).toContain('text-rose-600');
    expect(trendClass(0.01)).toContain('text-rose-600');
  });

  it('负数 → 绿', () => {
    expect(trendClass(-1.23)).toContain('text-emerald-600');
    expect(trendClass(-0.01)).toContain('text-emerald-600');
  });

  it('0 与空值不着色', () => {
    expect(trendClass(0)).toBe('');
    expect(trendClass(null)).toBe('');
    expect(trendClass(undefined)).toBe('');
    expect(trendClass(Number.NaN)).toBe('');
  });
});
