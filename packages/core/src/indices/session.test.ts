import { describe, expect, it } from 'vitest';
import { latestWeekdayDateInZone } from './session.ts';

/**
 * 日期锚点：2026-09-25 周五、09-26 周六、09-27 周日。
 * 各市场实测收盘：美股/欧洲/日本停在 09-25，台湾 09-24（中秋）、韩国 09-23（秋夕）。
 */
describe('latestWeekdayDateInZone —— 概览缺失补齐报价的交易日推导', () => {
  it('周五（各时区）→ 当天', () => {
    // 2026-09-25T20:00Z：纽约周五 16:00、东京周六 05:00、奥克兰周六 09:00
    const now = Date.parse('2026-09-25T20:00:00Z');
    expect(latestWeekdayDateInZone(now, 'America/New_York')).toBe('2026-09-25');
    expect(latestWeekdayDateInZone(now, 'Europe/London')).toBe('2026-09-25');
    expect(latestWeekdayDateInZone(now, 'Asia/Tokyo')).toBe('2026-09-25'); // 周六 → 回退周五
    expect(latestWeekdayDateInZone(now, 'Pacific/Auckland')).toBe('2026-09-25');
  });

  it('周六 → 回退周五（按目标时区判周几，不是按 UTC）', () => {
    const now = Date.parse('2026-09-26T03:00:00Z'); // 纽约周六 00:00、伦敦周六 04:00
    expect(latestWeekdayDateInZone(now, 'America/New_York')).toBe('2026-09-25');
    expect(latestWeekdayDateInZone(now, 'Europe/Paris')).toBe('2026-09-25');
    // 同一时刻东京已是周六白天、北京周六 —— 都回退
    expect(latestWeekdayDateInZone(now, 'Asia/Shanghai')).toBe('2026-09-25');
  });

  it('周日 → 回退周五', () => {
    const now = Date.parse('2026-09-27T10:00:00Z');
    expect(latestWeekdayDateInZone(now, 'America/New_York')).toBe('2026-09-25');
    expect(latestWeekdayDateInZone(now, 'Asia/Hong_Kong')).toBe('2026-09-25');
    expect(latestWeekdayDateInZone(now, 'Australia/Sydney')).toBe('2026-09-25');
  });

  it('时区决定「今天」是周几：周五深夜 UTC 在东京已是周六', () => {
    // 2026-09-25T16:00Z：东京 2026-09-26 01:00（周六）→ 回退 09-25；纽约仍是周五
    const now = Date.parse('2026-09-25T16:00:00Z');
    expect(latestWeekdayDateInZone(now, 'Asia/Tokyo')).toBe('2026-09-25');
    expect(latestWeekdayDateInZone(now, 'America/New_York')).toBe('2026-09-25');
    // 2026-09-24T16:00Z：东京已是周五 09-25，纽约还是周四 09-24
    const thursday = Date.parse('2026-09-24T16:00:00Z');
    expect(latestWeekdayDateInZone(thursday, 'Asia/Tokyo')).toBe('2026-09-25');
    expect(latestWeekdayDateInZone(thursday, 'America/New_York')).toBe('2026-09-24');
  });

  it('非法时区名回退 UTC，不抛错（上游改了注册表值也不能让概览整体失败）', () => {
    const now = Date.parse('2026-09-27T10:00:00Z'); // UTC 周日
    expect(latestWeekdayDateInZone(now, 'Not/AZone')).toBe('2026-09-25');
  });
});
