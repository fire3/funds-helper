import { type FundLimit, PurchaseStatus } from './model.ts';

/** 申购状态权重：数值越小在「可买优先」视图里越靠前 */
export const STATUS_WEIGHT: Record<PurchaseStatus, number> = {
  [PurchaseStatus.Open]: 0,
  [PurchaseStatus.Limited]: 1,
  [PurchaseStatus.Suspended]: 2,
  [PurchaseStatus.OnExchange]: 3,
  [PurchaseStatus.Closed]: 4,
  [PurchaseStatus.Subscribing]: 5,
  [PurchaseStatus.Unknown]: 6,
};

export const SORT_KEYS = ['status', 'limit-asc', 'limit-desc', 'name'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABELS: Record<SortKey, string> = {
  status: '可买优先',
  'limit-asc': '额度从紧',
  'limit-desc': '额度从松',
  name: '按名称',
};

function byCode(a: FundLimit, b: FundLimit): number {
  return a.code.localeCompare(b.code);
}

/** 额度升序：无限额（null）恒排最后 */
function compareLimitAsc(a: FundLimit, b: FundLimit): number {
  if (a.dailyLimit === null && b.dailyLimit === null) return byCode(a, b);
  if (a.dailyLimit === null) return 1;
  if (b.dailyLimit === null) return -1;
  return a.dailyLimit - b.dailyLimit || byCode(a, b);
}

/** 额度降序：无限额（null）恒排最后 */
function compareLimitDesc(a: FundLimit, b: FundLimit): number {
  if (a.dailyLimit === null && b.dailyLimit === null) return byCode(a, b);
  if (a.dailyLimit === null) return 1;
  if (b.dailyLimit === null) return -1;
  return b.dailyLimit - a.dailyLimit || byCode(a, b);
}

/** 默认视图：可买优先 + 额度从松到紧 */
function compareDefault(a: FundLimit, b: FundLimit): number {
  return STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status] || compareLimitDesc(a, b);
}

const COMPARATORS: Record<SortKey, (a: FundLimit, b: FundLimit) => number> = {
  status: compareDefault,
  'limit-asc': compareLimitAsc,
  'limit-desc': compareLimitDesc,
  name: (a, b) => a.name.localeCompare(b.name, 'zh-CN') || byCode(a, b),
};

/** 泛型保留入参类型，便于前端直接对 DTO 记录复用同一套排序口径 */
export function sortFunds<T extends FundLimit>(funds: readonly T[], key: SortKey): T[] {
  return [...funds].sort(COMPARATORS[key]);
}

export interface LimitBand {
  name: string;
  low: number;
  high: number | null;
}

export const LIMIT_BANDS: readonly LimitBand[] = [
  { name: '限 10 元以内', low: 0, high: 10 },
  { name: '限 100 元以内', low: 10.01, high: 100 },
  { name: '限 1000 元以内', low: 100.01, high: 1000 },
  { name: '限 1 万元以内', low: 1000.01, high: 10000 },
  { name: '限 100 万元以内', low: 10000.01, high: 1000000 },
  { name: '限 100 万元以上', low: 1000000.01, high: null },
];

/**
 * 限购档位分布 —— **只统计人民币份额**。
 * 美元份额在天天基金渠道不售、常为 0，纳入统计会把分布拉偏。
 */
export function computeLimitBands(funds: readonly FundLimit[]): (LimitBand & { count: number })[] {
  const limited = funds
    .filter(
      (fund) =>
        fund.currency === 'CNY' &&
        fund.status === PurchaseStatus.Limited &&
        fund.dailyLimit !== null,
    )
    .map((fund) => fund.dailyLimit as number);

  return LIMIT_BANDS.map((band) => ({
    ...band,
    count: limited.filter(
      (value) => value >= band.low && (band.high === null || value <= band.high),
    ).length,
  })).filter((band) => band.count > 0);
}

export interface QdiiStats {
  status: Record<string, number>;
  buyable: number;
  limitBands: (LimitBand & { count: number })[];
  tightest: number | null;
}

export function buildStats(funds: readonly FundLimit[]): QdiiStats {
  const status: Record<string, number> = {};
  let buyable = 0;
  // 「最紧」取最小的**正数**限额：限大额里存在真实的 0 元档，但 0 元不传达有效信息
  let tightest: number | null = null;

  for (const fund of funds) {
    status[fund.status] = (status[fund.status] ?? 0) + 1;
    if (fund.status === PurchaseStatus.Open || fund.status === PurchaseStatus.Limited) buyable += 1;
    if (
      fund.currency === 'CNY' &&
      fund.status === PurchaseStatus.Limited &&
      fund.dailyLimit !== null &&
      fund.dailyLimit > 0
    ) {
      if (tightest === null || fund.dailyLimit < tightest) tightest = fund.dailyLimit;
    }
  }

  return { status, buyable, limitBands: computeLimitBands(funds), tightest };
}
