import { SORT_KEYS, type SortKey, sortFunds } from '@funds-helper/core';
import type { FundRecord } from '@funds-helper/shared';

/** 申购状态筛选（单选）。「可买」= 开放申购 + 限大额 */
export const STATUS_FILTERS = [
  { value: '可买', label: '可买' },
  { value: '开放申购', label: '开放申购' },
  { value: '限大额', label: '限大额' },
  { value: '暂停申购', label: '暂停申购' },
  { value: '场内交易', label: '场内交易' },
  { value: '全部', label: '全部' },
] as const;

export const CURRENCY_FILTERS = [
  { value: 'CNY', label: '人民币' },
  { value: 'USD', label: '美元' },
  { value: 'HKD', label: '港币' },
  { value: 'ALL', label: '全部币种' },
] as const;

/** 日限额档位。`INF` 表示不加额度约束 */
export const LIMIT_BANDS = [
  { value: '10', label: '≤10 元', max: 10 },
  { value: '100', label: '≤100 元', max: 100 },
  { value: '1000', label: '≤1000 元', max: 1000 },
  { value: '10000', label: '≤1 万', max: 10000 },
  { value: '1000000', label: '≤100 万', max: 1_000_000 },
  { value: 'INF', label: '不限', max: null },
] as const;

export const SORT_OPTIONS = SORT_KEYS.map((value) => ({ value }));

export interface QdiiFilters {
  /** 地区/市场（多选，维内 OR） */
  regions: string[];
  /** 主题（多选，维内 OR） */
  themes: string[];
  status: string;
  currency: string;
  band: string;
  keyword: string;
  sort: SortKey;
}

export const DEFAULT_FILTERS: QdiiFilters = {
  regions: [],
  themes: [],
  // 主命题是「现在还能买什么」，因此默认只看可买
  status: '可买',
  // 默认人民币，屏蔽美元份额渠道不售导致的 0 值噪声
  currency: 'CNY',
  band: 'INF',
  keyword: '',
  sort: 'status',
};

const SORT_SET = new Set<string>(SORT_KEYS);

function pickSort(value: string | null): SortKey {
  return value !== null && SORT_SET.has(value) ? (value as SortKey) : DEFAULT_FILTERS.sort;
}

export function fromSearchParams(params: URLSearchParams): QdiiFilters {
  return {
    regions: params.getAll('region'),
    themes: params.getAll('theme'),
    status: params.get('status') ?? DEFAULT_FILTERS.status,
    currency: params.get('currency') ?? DEFAULT_FILTERS.currency,
    band: params.get('band') ?? DEFAULT_FILTERS.band,
    keyword: params.get('q') ?? '',
    sort: pickSort(params.get('sort')),
  };
}

/** 只写入与默认值不同的项，让分享链接尽量短且可读 */
export function toSearchParams(filters: QdiiFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const region of filters.regions) params.append('region', region);
  for (const theme of filters.themes) params.append('theme', theme);
  if (filters.status !== DEFAULT_FILTERS.status) params.set('status', filters.status);
  if (filters.currency !== DEFAULT_FILTERS.currency) params.set('currency', filters.currency);
  if (filters.band !== DEFAULT_FILTERS.band) params.set('band', filters.band);
  if (filters.keyword.trim() !== '') params.set('q', filters.keyword.trim());
  if (filters.sort !== DEFAULT_FILTERS.sort) params.set('sort', filters.sort);
  return params;
}

/**
 * 筛选：**维内取并集（OR）、维度间取交集（AND）**。
 * 这与用户的真实问法一致：「美国的、医药生物的 QDII 还有多少能买？」
 */
export function filterFunds(funds: readonly FundRecord[], filters: QdiiFilters): FundRecord[] {
  const keyword = filters.keyword.trim().toLowerCase();
  const band = LIMIT_BANDS.find((item) => item.value === filters.band);
  const maxLimit = band && band.max !== null ? band.max : null;

  return funds.filter((fund) => {
    if (filters.regions.length > 0 && !filters.regions.includes(fund.region)) return false;
    if (filters.themes.length > 0 && !filters.themes.includes(fund.theme)) return false;

    if (filters.currency !== 'ALL' && fund.currency !== filters.currency) return false;

    if (filters.status !== '全部') {
      if (filters.status === '可买') {
        if (!fund.buyable) return false;
      } else if (fund.status !== filters.status) {
        return false;
      }
    }

    // 「无限额」不满足任何有上限的档位
    if (maxLimit !== null && (fund.dailyLimit === null || fund.dailyLimit > maxLimit)) return false;

    if (keyword !== '') {
      const haystack = `${fund.code} ${fund.name}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }

    return true;
  });
}

/** 筛选 + 排序。排序口径与后端共用 core 的实现，避免出现两套规则 */
export function refine(funds: readonly FundRecord[], filters: QdiiFilters): FundRecord[] {
  return sortFunds(filterFunds(funds, filters), filters.sort);
}

export type FacetDimension = 'region' | 'theme';

/**
 * 分面计数：各选项数量随其它筛选条件（币种、状态、额度、搜索…）实时变化。
 * 统计时排除该维度自身的选择，避免已选项把同维其它选项清零。
 */
export function facetCounts(
  funds: readonly FundRecord[],
  filters: QdiiFilters,
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
