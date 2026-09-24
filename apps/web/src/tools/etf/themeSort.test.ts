import {
  aggregateThemes,
  ETF_WINDOWS,
  type EtfHotspotRecord,
  type EtfThemeRow,
} from '@funds-helper/core';
import { describe, expect, it } from 'vitest';
import { sortThemeRows, THEME_SORT_DEFAULT_DIR, THEME_SORT_KEYS } from './themeSort.ts';

/** 只填排序要用的字段，其余一律 null —— 主题归类只看 name/indexName/category */
function hot(
  overrides: Partial<EtfHotspotRecord> & { code: string; name: string },
): EtfHotspotRecord {
  return {
    indexName: null,
    category: '行业主题',
    scale: null,
    amount: null,
    premiumRate: null,
    maxDrawdown1y: null,
    mainInflow: null,
    sharesChangePct: null,
    change1w: null,
    change1m: null,
    change3m: null,
    ytdChange: null,
    ret6m: null,
    ret1y: null,
    ret3y: null,
    ...overrides,
  };
}

// 三个主题，只数 3 / 2 / 1、规模与成交额同序，方便断言
const ROWS: EtfThemeRow[] = aggregateThemes([
  hot({
    code: '1',
    name: '证券ETF国泰',
    scale: 100,
    amount: 100,
    change1m: 8,
    sharesChangePct: -2,
  }),
  hot({
    code: '2',
    name: '券商ETF南方',
    scale: 200,
    amount: 100,
    change1m: 12,
    sharesChangePct: -6,
  }),
  hot({
    code: '3',
    name: '券商ETF华宝',
    scale: 300,
    amount: 100,
    change1m: 4,
    sharesChangePct: -4,
  }),
  hot({ code: '4', name: '半导体ETF', scale: 100, amount: 10, change1m: 5, sharesChangePct: 1 }),
  hot({ code: '5', name: '芯片ETF', scale: 300, amount: 30, change1m: 15, sharesChangePct: 3 }),
  hot({ code: '6', name: '银行ETF', scale: 50, amount: 5, change1m: -3 }),
]);

const NAMES = (rows: EtfThemeRow[]) => rows.map((row) => row.theme);

describe('sortThemeRows', () => {
  it('默认（key=null）按焦点窗口均值降序，升序完全反转', () => {
    expect(NAMES(sortThemeRows(ROWS, { key: null, focus: '1m', dir: 'desc' }))).toEqual([
      '半导体/芯片',
      '证券',
      '银行',
    ]);
    expect(NAMES(sortThemeRows(ROWS, { key: null, focus: '1m', dir: 'asc' }))).toEqual([
      '银行',
      '证券',
      '半导体/芯片',
    ]);
  });

  it('只数/规模/成交额按数值排序', () => {
    expect(NAMES(sortThemeRows(ROWS, { key: 'count', focus: '1m', dir: 'desc' }))).toEqual([
      '证券',
      '半导体/芯片',
      '银行',
    ]);
    expect(NAMES(sortThemeRows(ROWS, { key: 'scale', focus: '1m', dir: 'desc' }))).toEqual([
      '证券',
      '半导体/芯片',
      '银行',
    ]);
    expect(NAMES(sortThemeRows(ROWS, { key: 'amount', focus: '1m', dir: 'desc' }))).toEqual([
      '证券',
      '半导体/芯片',
      '银行',
    ]);
    expect(NAMES(sortThemeRows(ROWS, { key: 'count', focus: '1m', dir: 'asc' }))).toEqual([
      '银行',
      '半导体/芯片',
      '证券',
    ]);
  });

  it('份额变化：无数据的主题恒排最后（不冒充 0）', () => {
    const rows = sortThemeRows(ROWS, { key: 'shares', focus: '1m', dir: 'desc' });
    expect(NAMES(rows)).toEqual(['半导体/芯片', '证券', '银行']);
    expect(NAMES(sortThemeRows(ROWS, { key: 'shares', focus: '1m', dir: 'asc' }))).toEqual([
      '证券',
      '半导体/芯片',
      '银行',
    ]);
  });

  it('焦点窗口全为空时按主题名兜底，不抛错', () => {
    expect(NAMES(sortThemeRows(ROWS, { key: null, focus: '3y', dir: 'desc' }))).toHaveLength(
      ROWS.length,
    );
  });

  it('不修改入参（排序在副本上做）', () => {
    const before = NAMES(ROWS);
    sortThemeRows(ROWS, { key: 'theme', focus: '1m', dir: 'desc' });
    expect(NAMES(ROWS)).toEqual(before);
  });

  it('每个排序键都有自然方向', () => {
    for (const key of THEME_SORT_KEYS) {
      expect(['asc', 'desc']).toContain(THEME_SORT_DEFAULT_DIR[key]);
    }
    expect(THEME_SORT_DEFAULT_DIR.theme).toBe('asc');
  });

  it('主题名排序：升序与降序互为反转', () => {
    const asc = NAMES(sortThemeRows(ROWS, { key: 'theme', focus: '1m', dir: 'asc' }));
    const desc = NAMES(sortThemeRows(ROWS, { key: 'theme', focus: '1m', dir: 'desc' }));
    expect(desc).toEqual([...asc].reverse());
  });

  it('所有窗口都能作为焦点窗口参与排序', () => {
    for (const window of ETF_WINDOWS) {
      expect(NAMES(sortThemeRows(ROWS, { key: null, focus: window, dir: 'desc' }))).toHaveLength(
        ROWS.length,
      );
    }
  });
});
