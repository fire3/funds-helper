import type { EtfThemeRow, EtfWindow } from '@funds-helper/core';

/**
 * 主题表格的列排序（纯函数，前端直接复用；见 HotspotPanel 的表头点击）。
 *
 * - `key = null` 表示按**焦点窗口的等权均值**排序 —— 窗口列（近1周…近3年）共用
 *   `focus`，方向仍走 URL 的 `d`，所以窗口列不占用这里的排序键；
 * - 空值恒排最后：没抓到数据的主题不能冒充 0 参与比较；
 * - 并列时按主题名兜底，保证排序稳定（同一批数据每次结果一致）。
 */

export const THEME_SORT_KEYS = ['theme', 'count', 'amount', 'scale', 'shares'] as const;
export type ThemeSortKey = (typeof THEME_SORT_KEYS)[number];

export type ThemeSortDir = 'asc' | 'desc';

/** 首次点到该列的自然方向：名称正序，数值从大到小 */
export const THEME_SORT_DEFAULT_DIR: Record<ThemeSortKey, ThemeSortDir> = {
  theme: 'asc',
  count: 'desc',
  amount: 'desc',
  scale: 'desc',
  shares: 'desc',
};

function byName<T extends EtfThemeRow>(a: T, b: T): number {
  return a.theme.localeCompare(b.theme, 'zh-CN');
}

function compareNumber<T extends EtfThemeRow>(
  left: number | null,
  right: number | null,
  dir: ThemeSortDir,
  a: T,
  b: T,
): number {
  if (left === null && right === null) return byName(a, b);
  if (left === null) return 1;
  if (right === null) return -1;
  const diff = dir === 'asc' ? left - right : right - left;
  return diff === 0 ? byName(a, b) : diff;
}

export function sortThemeRows<T extends EtfThemeRow>(
  rows: readonly T[],
  options: { key: ThemeSortKey | null; focus: EtfWindow; dir: ThemeSortDir },
): T[] {
  const { key, focus, dir } = options;
  const compare = (a: T, b: T): number => {
    switch (key) {
      case 'theme':
        return dir === 'asc' ? byName(a, b) : byName(b, a);
      case 'count':
        return compareNumber(a.count, b.count, dir, a, b);
      case 'amount':
        return compareNumber(a.amount, b.amount, dir, a, b);
      case 'scale':
        return compareNumber(a.scale, b.scale, dir, a, b);
      case 'shares':
        return compareNumber(a.meanSharesChangePct, b.meanSharesChangePct, dir, a, b);
      case null:
        return compareNumber(a.meanRet[focus], b.meanRet[focus], dir, a, b);
    }
  };
  return [...rows].sort(compare);
}
