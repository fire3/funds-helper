import {
  ETF_CATEGORIES,
  ETF_DEFAULT_SORT,
  ETF_MARKETS,
  ETF_SORT_KEYS,
  ETF_SORT_LABELS,
  type EtfSortKey,
  sortEtfs,
} from '@funds-helper/core';
import type { EtfRecord } from '@funds-helper/shared';

/** 分类（多选，维内 OR）。顺序与 core 的 ETF_CATEGORIES 一致 */
export const CATEGORY_FILTERS = ETF_CATEGORIES.map((value) => ({ value, label: value }));

/** 上市交易所（多选，维内 OR） */
export const MARKET_FILTERS = [ETF_MARKETS.Sh, ETF_MARKETS.Sz].map((value) => ({
  value,
  label: value,
}));

/**
 * 折溢价方向（多选，维内 OR）。
 * 判定用服务端下发的 `premiumLevel`（与列表徽标、统计面板同源），不在这里重新算阈值。
 */
export const PREMIUM_FILTERS = [
  { value: 'premium', label: '溢价' },
  { value: 'discount', label: '折价' },
  { value: 'flat', label: '平价' },
] as const;

/** 规模档位（值 = 亿元下限） */
export const SCALE_FILTERS = [
  { value: 'any', label: '不限' },
  { value: '1', label: '≥1 亿' },
  { value: '10', label: '≥10 亿' },
  { value: '100', label: '≥100 亿' },
] as const;

/**
 * 场外联接基金：有没有可以申赎的场外份额。
 *
 * 只有「有 / 不限」两档，没有「没有联接基金」这一档 ——
 * 反查覆盖 61% 的 ETF，`0 只` 里既有「本来就没有联接基金」（债券/商品）
 * 也有「还没反查到」，把它做成一档筛选等于在筛选里混进一个不确定的口径。
 */
export const FEEDER_FILTERS = [
  { value: 'any', label: '不限' },
  { value: 'has', label: '有联接基金' },
] as const;

/** 成交额档位（值 = 亿元下限） */
export const AMOUNT_FILTERS = [
  { value: 'any', label: '不限' },
  { value: '0.1', label: '≥1000 万' },
  { value: '1', label: '≥1 亿' },
] as const;

export const SORT_OPTIONS = ETF_SORT_KEYS.map((value) => ({
  value,
  label: ETF_SORT_LABELS[value],
}));

export interface EtfFilters {
  categories: string[];
  markets: string[];
  premiums: string[];
  /** 规模下限（亿元），'any' = 不限 */
  minScale: string;
  /** 成交额下限（亿元），'any' = 不限 */
  minAmount: string;
  /** 场外联接基金：'any' = 不限，'has' = 只看有联接基金的 */
  feeder: string;
  keyword: string;
  sort: EtfSortKey;
}

export const DEFAULT_FILTERS: EtfFilters = {
  categories: [],
  markets: [],
  premiums: [],
  minScale: 'any',
  minAmount: 'any',
  feeder: 'any',
  keyword: '',
  // 默认按规模降序：先看主流品种，避免一屏全是迷你 ETF
  sort: ETF_DEFAULT_SORT,
};

const SORT_SET = new Set<string>(ETF_SORT_KEYS);
const CATEGORY_SET = new Set<string>(ETF_CATEGORIES);
const MARKET_SET = new Set<string>([ETF_MARKETS.Sh, ETF_MARKETS.Sz]);
const PREMIUM_SET = new Set<string>(PREMIUM_FILTERS.map((item) => item.value));
const SCALE_SET = new Set<string>(SCALE_FILTERS.map((item) => item.value));
const AMOUNT_SET = new Set<string>(AMOUNT_FILTERS.map((item) => item.value));
const FEEDER_SET = new Set<string>(FEEDER_FILTERS.map((item) => item.value));

function pick(value: string | null, allowed: Set<string>, fallback: string): string {
  return value !== null && allowed.has(value) ? value : fallback;
}

/** 只保留已知取值：分享链接里的笔误不该让页面空掉 */
function pickAll(values: readonly string[], allowed: Set<string>): string[] {
  return values.filter((value) => allowed.has(value));
}

export function fromSearchParams(params: URLSearchParams): EtfFilters {
  return {
    categories: pickAll(params.getAll('category'), CATEGORY_SET),
    markets: pickAll(params.getAll('market'), MARKET_SET),
    premiums: pickAll(params.getAll('premium'), PREMIUM_SET),
    minScale: pick(params.get('minScale'), SCALE_SET, DEFAULT_FILTERS.minScale),
    minAmount: pick(params.get('minAmount'), AMOUNT_SET, DEFAULT_FILTERS.minAmount),
    feeder: pick(params.get('feeder'), FEEDER_SET, DEFAULT_FILTERS.feeder),
    keyword: params.get('q') ?? '',
    sort: pick(params.get('sort'), SORT_SET, DEFAULT_FILTERS.sort) as EtfSortKey,
  };
}

/** 只写入与默认值不同的项，让分享链接尽量短且可读 */
export function toSearchParams(filters: EtfFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const category of filters.categories) params.append('category', category);
  for (const market of filters.markets) params.append('market', market);
  for (const premium of filters.premiums) params.append('premium', premium);
  if (filters.minScale !== DEFAULT_FILTERS.minScale) params.set('minScale', filters.minScale);
  if (filters.minAmount !== DEFAULT_FILTERS.minAmount) params.set('minAmount', filters.minAmount);
  if (filters.feeder !== DEFAULT_FILTERS.feeder) params.set('feeder', filters.feeder);
  if (filters.keyword.trim() !== '') params.set('q', filters.keyword.trim());
  if (filters.sort !== DEFAULT_FILTERS.sort) params.set('sort', filters.sort);
  return params;
}

function matchesPremium(record: EtfRecord, premiums: readonly string[]): boolean {
  if (premiums.length === 0) return true;
  const level = record.premiumLevel;
  if (premiums.includes('premium') && (level === '溢价' || level === '高溢价')) return true;
  if (premiums.includes('discount') && (level === '折价' || level === '高折价')) return true;
  if (premiums.includes('flat') && level === '平价') return true;
  return false;
}

/** 档位下限（亿元）→ 元；'any' → null（不限） */
function threshold(band: string, fallback: string): number | null {
  const value = band === 'any' ? fallback : band;
  if (value === 'any') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * 1e8 : null;
}

/** 维内取并集（OR）、维度间取交集（AND） */
export function filterEtfs(records: readonly EtfRecord[], filters: EtfFilters): EtfRecord[] {
  const keyword = filters.keyword.trim().toLowerCase();
  const minScale = threshold(filters.minScale, DEFAULT_FILTERS.minScale);
  const minAmount = threshold(filters.minAmount, DEFAULT_FILTERS.minAmount);

  return records.filter((record) => {
    if (filters.categories.length > 0 && !filters.categories.includes(record.category))
      return false;
    if (filters.markets.length > 0 && !filters.markets.includes(record.market)) return false;
    if (!matchesPremium(record, filters.premiums)) return false;

    // 设了档位就必须有数据：缺失值无法证明「够大」，不能因为 null 就放行
    if (minScale !== null && (record.scale === null || record.scale < minScale)) return false;
    if (minAmount !== null && (record.amount === null || record.amount < minAmount)) return false;

    // 「有联接基金」是**存在性**判定：空数组只能说明没查到，所以只做正向筛选
    if (filters.feeder === 'has' && record.feederFunds.length === 0) return false;

    if (keyword !== '') {
      const haystack = `${record.code} ${record.name} ${record.indexName ?? ''}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }

    return true;
  });
}

/** 筛选 + 排序。排序口径与后端共用 core 的实现，避免出现两套规则 */
export function refine(records: readonly EtfRecord[], filters: EtfFilters): EtfRecord[] {
  return sortEtfs(filterEtfs(records, filters), filters.sort);
}

export type FacetDimension = 'category' | 'market';

/** 分面计数：各选项数量随其它筛选条件实时变化（排除该维度自身的已选项） */
export function facetCounts(
  records: readonly EtfRecord[],
  filters: EtfFilters,
  dimension: FacetDimension,
): Map<string, number> {
  const base = filterEtfs(records, {
    ...filters,
    categories: dimension === 'category' ? [] : filters.categories,
    markets: dimension === 'market' ? [] : filters.markets,
  });
  const counts = new Map<string, number>();
  for (const record of base) {
    const key = record[dimension];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function toggleValue(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}
