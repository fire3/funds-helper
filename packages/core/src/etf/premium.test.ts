import { describe, expect, it } from 'vitest';
import { describePremium, premiumRateFromDiscount } from './premium.ts';

describe('premiumRateFromDiscount —— 与 quote.ts 的 f402 口径对齐', () => {
  it('取反：上游负值 = 溢价，对外「正 = 溢价」', () => {
    // 实测 510300：f402 = 0.06 → 折价 0.06%；513100 盘中 f402 为负 → 溢价
    expect(premiumRateFromDiscount(0.06)).toBeCloseTo(-0.06, 6);
    expect(premiumRateFromDiscount(-1.2)).toBeCloseTo(1.2, 6);
  });

  it('null 透传', () => {
    expect(premiumRateFromDiscount(null)).toBeNull();
  });
});

describe('describePremium', () => {
  it('无数据 → 未知 + 占位符（不是 0%）', () => {
    expect(describePremium(null)).toEqual({ level: '未知', text: '—', note: null });
    expect(describePremium(Number.NaN).level).toBe('未知');
  });

  it('|rate| < 0.1% 视为平价', () => {
    expect(describePremium(0.06)).toEqual({ level: '平价', text: '平价 0.06%', note: null });
    expect(describePremium(-0.09).level).toBe('平价');
    expect(describePremium(0.1).level).toBe('溢价'); // 边界归入溢价
  });

  it('溢价 0.1% ~ 1% 提示为溢价，无 note', () => {
    expect(describePremium(0.43)).toEqual({ level: '溢价', text: '溢价 0.43%', note: null });
  });

  it('溢价 ≥ 1% 为高溢价，并给出可执行提示', () => {
    const info = describePremium(1.23);
    expect(info.level).toBe('高溢价');
    expect(info.text).toBe('溢价 1.23%');
    expect(info.note).toContain('多付');
  });

  it('折价分两档（折价 / 高折价），不给 note', () => {
    expect(describePremium(-0.5)).toEqual({ level: '折价', text: '折价 0.50%', note: null });
    expect(describePremium(-2)).toEqual({ level: '高折价', text: '折价 2.00%', note: null });
  });
});
