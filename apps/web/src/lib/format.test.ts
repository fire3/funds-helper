import { describe, expect, it } from 'vitest';
import { formatYuan, trendClass } from './format.ts';

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

describe('formatYuan —— 金额按量级换单位', () => {
  it('万亿 / 亿 / 万 / 元', () => {
    expect(formatYuan(1.0939e12)).toBe('1.09 万亿');
    expect(formatYuan(109_391_241_858)).toBe('1093.91 亿');
    expect(formatYuan(3_525_126_576)).toBe('35.25 亿');
    expect(formatYuan(16_845_295)).toBe('1685 万');
    expect(formatYuan(3600)).toBe('3600');
  });

  it('空值 → --（不渲染成 0）', () => {
    expect(formatYuan(null)).toBe('--');
    expect(formatYuan(undefined)).toBe('--');
    expect(formatYuan(Number.NaN)).toBe('--');
  });
});
