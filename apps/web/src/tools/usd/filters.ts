import { SORT_KEYS, type SortKey, sortFunds } from '@funds-helper/core';
import type { UsdFundRecord } from '@funds-helper/shared';

/** 申购状态筛选（单选）。「可买」= 开放申购 + 限大额（以状态为准） */
export const STATUS_FILTERS = [
  { value: '可买', label: '可买' },
  { value: '开放申购', label: '开放申购' },
  { value: '限大额', label: '限大额' },
  { value: '暂停申购', label: '暂停申购' },
  { value: '场内交易', label: '场内交易' },
  { value: '全部', label: '全部' },
] as const;

/** 份额形式（多选，维内 OR）。空选 = 全部 */
export const USD_KIND_FILTERS = [
  { value: '现汇', label: '现汇' },
  { value: '现钞', label: '现钞' },
  { value: '未标注', label: '未标注' },
] as const;

export const SORT_OPTIONS = SORT_KEYS.map((value) => ({ value }));

export interface UsdFilters {
  /** 地区/市场（多选，维内 OR） */
  regions: string[];
  /** 主题（多选，维内 OR） */
  themes: string[];
  status: string;
  /** 份额形式（多选，维内 OR），空数组表示不限 */
  usdKinds: string[];
  keyword: string;
  sort: SortKey;
}

export const DEFAULT_FILTERS: UsdFilters = {
  regions: [],
  themes: [],
  // 主命题是「现在还能不能用美元买」，因此默认只看可买
  status: '可买',
  usdKinds: [],
  keyword: '',
  sort: 'status',
};

const SORT_SET = new Set<string>(SORT_KEYS);

function pickSort(value: string | null): SortKey {
  return value !== null && SORT_SET.has(value) ? (value as SortKey) : DEFAULT_FILTERS.sort;
}

export function fromSearchParams(params: URLSearchParams): UsdFilters {
  return {
    regions: params.getAll('region'),
    themes: params.getAll('theme'),
    status: params.get('status') ?? DEFAULT_FILTERS.status,
    usdKinds: params.getAll('kind'),
    keyword: params.get('q') ?? '',
    sort: pickSort(params.get('sort')),
  };
}

/** 只写入与默认值不同的项，让分享链接尽量短且可读 */
export function toSearchParams(filters: UsdFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const region of filters.regions) params.append('region', region);
  for (const theme of filters.themes) params.append('theme', theme);
  for (const kind of filters.usdKinds) params.append('kind', kind);
  if (filters.status !== DEFAULT_FILTERS.status) params.set('status', filters.status);
  if (filters.keyword.trim() !== '') params.set('q', filters.keyword.trim());
  if (filters.sort !== DEFAULT_FILTERS.sort) params.set('sort', filters.sort);
  return params;
}

/** 维内取并集（OR）、维度间取交集（AND） */
export function filterFunds(funds: readonly UsdFundRecord[], filters: UsdFilters): UsdFundRecord[] {
  const keyword = filters.keyword.trim().toLowerCase();

  return funds.filter((fund) => {
    if (filters.regions.length > 0 && !filters.regions.includes(fund.region)) return false;
    if (filters.themes.length > 0 && !filters.themes.includes(fund.theme)) return false;
    if (filters.usdKinds.length > 0 && !filters.usdKinds.includes(fund.usdKind)) return false;

    if (filters.status !== '全部') {
      if (filters.status === '可买') {
        if (!fund.buyable) return false;
      } else if (fund.status !== filters.status) {
        return false;
      }
    }

    if (keyword !== '') {
      const haystack = `${fund.code} ${fund.name}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }

    return true;
  });
}

/** 筛选 + 排序。排序口径与后端共用 core 的实现，避免出现两套规则 */
export function refine(funds: readonly UsdFundRecord[], filters: UsdFilters): UsdFundRecord[] {
  return sortFunds(filterFunds(funds, filters), filters.sort);
}

export type FacetDimension = 'region' | 'theme';

/**
 * 分面计数：各选项数量随其它筛选条件实时变化。
 * 统计时排除该维度自身的选择，避免已选项把同维其它选项清零。
 */
export function facetCounts(
  funds: readonly UsdFundRecord[],
  filters: UsdFilters,
  dimension: FacetDimension,
): Map<string, number> {
  const base = filterFunds(funds, {
    ...filters,
    regions: dimension === 'region' ? [] : filters.regions,
    themes: dimension === 'theme' ? [] : filters.themes,
  });
  const counts = new Map<string, number>();
  for (const fund of base) {
    const key = fund[dimension];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function toggleValue(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}
