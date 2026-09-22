import type { ChangeItem } from '@funds-helper/shared';

/**
 * 额度变更页的筛选与分组。
 *
 * 与 `filters.ts` 同构：**纯函数 + 同目录单测**，组件只负责渲染。
 * 变更条数在上游是稀疏事件（一天最多几个字段变动），所以分组与筛选全部在前端做，
 * 服务端只负责「时间窗 + LIMIT」的粗筛，避免为每种筛选组合加一个查询参数。
 */

/** 字段筛选项。`all` 表示不约束 */
export const CHANGE_FIELD_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'daily_limit', label: '日累计限额' },
  { value: 'status', label: '申购状态' },
  { value: 'redeem_status', label: '赎回状态' },
  { value: 'min_purchase', label: '申购起点' },
] as const;

/** 行内展示用的字段标签，由筛选项派生，保证两处永远一致 */
export const CHANGE_FIELD_LABELS: Record<string, string> = Object.fromEntries(
  CHANGE_FIELD_FILTERS.map((item) => [item.value, item.label]),
);

export const CHANGE_DIRECTION_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'tightened', label: '收紧' },
  { value: 'loosened', label: '放宽' },
] as const;

/** 时间范围。days 会作为查询参数发给服务端（窗口在 SQL 侧收敛，避免全量拉取） */
export const CHANGE_RANGES = [
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
  { value: 90, label: '近 90 天' },
] as const;

/** 默认时间范围。天数属于「取数」而非「过滤」，故不进 ChangeFilters */
export const DEFAULT_CHANGE_DAYS = 30;

export type ChangeDirectionFilter = (typeof CHANGE_DIRECTION_FILTERS)[number]['value'];

export interface ChangeFilters {
  direction: ChangeDirectionFilter;
  field: string;
  /** 匹配基金代码或名称 */
  keyword: string;
  /** 只看窗口内变更次数 ≥ 2 的基金 —— 这类才是「被反复调整」的重点对象 */
  multiOnly: boolean;
}

export const DEFAULT_CHANGE_FILTERS: ChangeFilters = {
  direction: 'all',
  field: 'all',
  keyword: '',
  multiOnly: false,
};

export function directionLabel(direction: ChangeItem['direction']): string {
  return direction === 'tightened' ? '收紧' : '放宽';
}

/**
 * 值展示。`daily_limit` / `min_purchase` 是金额，补「元」；
 * `null` 的含义随字段而变 —— 无限额 vs 不设起点，不能一律叫「无限额」。
 */
export function changeValueText(field: string, value: string | null): string {
  if (value === null) {
    if (field === 'daily_limit') return '无限额';
    if (field === 'min_purchase') return '不限';
    return '--';
  }
  return field === 'daily_limit' || field === 'min_purchase' ? `${value} 元` : value;
}

/** 方向 / 字段 / 关键词过滤（不含分组与 multiOnly） */
export function filterChanges(items: readonly ChangeItem[], filters: ChangeFilters): ChangeItem[] {
  const keyword = filters.keyword.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.direction !== 'all' && item.direction !== filters.direction) return false;
    if (filters.field !== 'all' && item.field !== filters.field) return false;
    if (keyword !== '') {
      const haystack = `${item.code} ${item.name}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}

export interface ChangeGroup {
  code: string;
  name: string;
  /** 组内按时间倒序（最近一次在最上） */
  items: ChangeItem[];
  tightened: number;
  loosened: number;
}

/** 时间倒序：先比数据日期，同日再比检测时刻（同一天的重复检测取更晚的在前） */
function byRecencyDesc(a: ChangeItem, b: ChangeItem): number {
  if (a.dataDate !== b.dataDate) return a.dataDate < b.dataDate ? 1 : -1;
  if (a.detectedAt !== b.detectedAt) return a.detectedAt < b.detectedAt ? 1 : -1;
  return 0;
}

/**
 * 按基金聚合，让「同一只基金被连续调整了几次」一眼可见。
 * 组间按最近一次变更倒序，刚出事儿的排在最前面。
 */
export function groupChanges(items: readonly ChangeItem[]): ChangeGroup[] {
  const buckets = new Map<string, ChangeItem[]>();
  for (const item of items) {
    const bucket = buckets.get(item.code);
    if (bucket) bucket.push(item);
    else buckets.set(item.code, [item]);
  }

  const groups: ChangeGroup[] = [];
  for (const bucket of buckets.values()) {
    const sorted = [...bucket].sort(byRecencyDesc);
    const latest = sorted[0];
    if (latest === undefined) continue;

    let tightened = 0;
    for (const item of sorted) {
      if (item.direction === 'tightened') tightened += 1;
    }

    groups.push({
      code: latest.code,
      name: latest.name,
      items: sorted,
      tightened,
      loosened: sorted.length - tightened,
    });
  }

  return groups.sort((a, b) => {
    const left = a.items[0];
    const right = b.items[0];
    if (left === undefined || right === undefined) return 0;
    return byRecencyDesc(left, right);
  });
}

/** 过滤 → 分组 →（multiOnly 时）只留多次变更的基金 */
export function refineChanges(items: readonly ChangeItem[], filters: ChangeFilters): ChangeGroup[] {
  const groups = groupChanges(filterChanges(items, filters));
  return filters.multiOnly ? groups.filter((group) => group.items.length >= 2) : groups;
}

export interface ChangesSummary {
  tightened: number;
  loosened: number;
  /** 涉及的基金数（不是条目数） */
  funds: number;
  multi: number;
}

export function changesSummary(groups: readonly ChangeGroup[]): ChangesSummary {
  let tightened = 0;
  let loosened = 0;
  let multi = 0;
  for (const group of groups) {
    tightened += group.tightened;
    loosened += group.loosened;
    if (group.items.length >= 2) multi += 1;
  }
  return { tightened, loosened, funds: groups.length, multi };
}
