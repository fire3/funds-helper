import {
  NEWS_CATEGORIES,
  NEWS_RANGES,
  NEWS_SOURCE_IDS,
  NEWS_WINDOWS,
  type NewsCategory,
  type NewsRange,
  type NewsWindow,
} from '@funds-helper/shared';

/**
 * `news` 工具的筛选状态：**全部写进 URL**（可分享、可收藏、刷新可复现）。
 *
 * 与其它工具一致的口径：
 * - 维内取并集（多选 chips）、维度间取交集；
 * - 只写入与默认值不同的项，让分享链接尽量短；
 * - 关键词**回车才提交**（实时写 URL 会打断中文输入法，见 taste）。
 *
 * 这里有两个「窗口」是有意的：
 * - `window` 是**简报窗口**（today / yesterday / last7d，与生成记录一一对应）；
 * - `range` 是**信息流窗口**（多两档：近 3 日 / 全部）。
 * 两者语义不同，硬合成一个枚举会让「近 3 日的简报」变成一个不存在的东西。
 */

export const NEWS_TABS = ['summary', 'feed', 'sources', 'settings'] as const;
export type NewsTab = (typeof NEWS_TABS)[number];

export const NEWS_TAB_LABELS: Record<NewsTab, string> = {
  summary: '中文简报',
  feed: '信息流',
  sources: '信源',
  settings: '设置',
};

export interface NewsFilters {
  tab: NewsTab;
  /** 简报窗口 */
  window: NewsWindow;
  /** 信息流窗口 */
  range: NewsRange;
  categories: NewsCategory[];
  sources: string[];
  keyword: string;
}

export const DEFAULT_NEWS_FILTERS: NewsFilters = {
  tab: 'summary',
  window: 'today',
  range: 'today',
  categories: [],
  sources: [],
  keyword: '',
};

const TAB_SET = new Set<string>(NEWS_TABS);
const WINDOW_SET = new Set<string>(NEWS_WINDOWS);
const RANGE_SET = new Set<string>(NEWS_RANGES);
const CATEGORY_SET = new Set<string>(NEWS_CATEGORIES);
const SOURCE_SET = new Set<string>(NEWS_SOURCE_IDS);

/** 只保留已知取值：分享链接里的笔误不该让页面空掉 */
function pick<T extends string>(value: string | null, allowed: Set<string>, fallback: T): T {
  return value !== null && allowed.has(value) ? (value as T) : fallback;
}

/** 多选值用逗号分隔（`?cat=media,policy`），与服务端的 `csv()` 解析对齐 */
function pickAll(value: string | null, allowed: Set<string>): string[] {
  if (value === null) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '' && allowed.has(part));
}

export function fromSearchParams(params: URLSearchParams): NewsFilters {
  return {
    tab: pick(params.get('tab'), TAB_SET, DEFAULT_NEWS_FILTERS.tab),
    window: pick(params.get('window'), WINDOW_SET, DEFAULT_NEWS_FILTERS.window),
    range: pick(params.get('range'), RANGE_SET, DEFAULT_NEWS_FILTERS.range),
    categories: pickAll(params.get('cat'), CATEGORY_SET) as NewsCategory[],
    sources: pickAll(params.get('src'), SOURCE_SET),
    keyword: params.get('q') ?? '',
  };
}

/** 只写入与默认值不同的项 */
export function toSearchParams(filters: NewsFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.tab !== DEFAULT_NEWS_FILTERS.tab) params.set('tab', filters.tab);
  if (filters.window !== DEFAULT_NEWS_FILTERS.window) params.set('window', filters.window);
  if (filters.range !== DEFAULT_NEWS_FILTERS.range) params.set('range', filters.range);
  if (filters.categories.length > 0) params.set('cat', filters.categories.join(','));
  if (filters.sources.length > 0) params.set('src', filters.sources.join(','));
  if (filters.keyword.trim() !== '') params.set('q', filters.keyword.trim());
  return params;
}

/** 信息流接口的 query（服务端筛选 + 游标分页） */
export function buildFeedQuery(
  filters: NewsFilters,
  cursor: string | null = null,
  limit = 100,
): string {
  const params = new URLSearchParams();
  params.set('range', filters.range);
  if (filters.categories.length > 0) params.set('cat', filters.categories.join(','));
  if (filters.sources.length > 0) params.set('src', filters.sources.join(','));
  if (filters.keyword.trim() !== '') params.set('q', filters.keyword.trim());
  if (cursor !== null) params.set('cursor', cursor);
  params.set('limit', String(limit));
  return params.toString();
}

export function toggleValue<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}
