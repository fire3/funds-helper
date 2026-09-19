import {
  CURRENCY_VALUES,
  type Currency,
  type FundLimit,
  PurchaseStatus,
  type RawFundRow,
  REDEEM_STATUS_VALUES,
  type RedeemStatus,
} from './model.ts';

/**
 * 通用基金字段归一化（纯函数，与具体工具无关）。
 *
 * 「无限额哨兵值」「0 的三义」「份额币种优先级」这些规则对所有按份额查询的工具都一样，
 * 因此放在 `fund/`，由 QDII 与美元份额两个工具共用（QDII 见 `qdii/normalize.ts` 的转发）。
 */

/**
 * 「无限额」哨兵值判定阈值。
 *
 * 上游用大整数表示无限额（实测有 1e10 / 1e11 / 9999999999 等多种写法），
 * 而真实限额最高仅 50,000,000（5 千万），故 1e8 是安全阈值。
 */
export const UNLIMITED_THRESHOLD = 1e8;

const PURCHASE_STATUS_VALUES: readonly string[] = Object.values(PurchaseStatus);
const REDEEM_STATUS_VALUES_ALL: readonly string[] = Object.values(REDEEM_STATUS_VALUES);
const CURRENCY_ALL: readonly string[] = Object.values(CURRENCY_VALUES);

/** 港币标记 */
const HKD_MARKERS = ['港币', '港元'] as const;

/**
 * 美元标记。`美汇` / `美钞` 是简写变体，很容易漏掉
 * （漏掉后「摩根富时发达市场 REITs」那两只会被误判为人民币份额）。
 */
const USD_MARKERS = ['美元', '美汇', '美钞', '现汇', '现钞'] as const;

export function toNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '--') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** 未知状态降级为 Unknown，而不是抛错 */
export function parsePurchaseStatus(raw: string | null | undefined): PurchaseStatus {
  const value = raw ?? '';
  return PURCHASE_STATUS_VALUES.includes(value)
    ? (value as PurchaseStatus)
    : PurchaseStatus.Unknown;
}

/**
 * 赎回状态独立解析 —— 上游赎回枚举取值与申购不同（`开放赎回` ≠ `开放申购`），
 * 若复用同一个解析函数，赎回状态会全部变成 Unknown。
 */
export function parseRedeemStatus(raw: string | null | undefined): RedeemStatus {
  const value = raw ?? '';
  return REDEEM_STATUS_VALUES_ALL.includes(value)
    ? (value as RedeemStatus)
    : REDEEM_STATUS_VALUES.Unknown;
}

export function parseCurrency(raw: string | null | undefined): Currency {
  return CURRENCY_ALL.includes(raw ?? '') ? (raw as Currency) : CURRENCY_VALUES.CNY;
}

/**
 * 份额币种判定（**「人民币」优先级是踩过的坑**）。
 *
 * 朴素做法「名称含美元即为美元份额」是错的：
 * `中银美元债债券(QDII)人民币A` 是**人民币份额**，名称中的「美元」描述的是
 * 投资方向而非份额币种。实测同时含「美元」与「人民币」的有 12 只。
 */
export function parseCurrencyFromName(name: string): Currency {
  if (name.includes('人民币')) return CURRENCY_VALUES.CNY;
  if (HKD_MARKERS.some((marker) => name.includes(marker))) return CURRENCY_VALUES.HKD;
  return USD_MARKERS.some((marker) => name.includes(marker))
    ? CURRENCY_VALUES.USD
    : CURRENCY_VALUES.CNY;
}

/**
 * 限额归一化。
 *
 * `value === 0` 是**唯一需要多字段联合判断**的规则 —— 三种真实业务含义
 * 挤在同一个数值上：
 *   - 场内交易：本就不走申赎通道 → 无限额
 *   - 非人民币份额：天天基金渠道通常不售，0 不代表「限 0 元」→ 无限额
 *   - 人民币 + 限大额：真实就是 0（暂停但未发公告）→ 0
 */
export function normalizeLimit(
  raw: string | number | null | undefined,
  status: PurchaseStatus,
  currency: Currency,
): number | null {
  const value = toNumber(raw);
  if (value === null) return null;
  if (value >= UNLIMITED_THRESHOLD) return null;

  if (value === 0) {
    if (status === PurchaseStatus.OnExchange) return null;
    if (currency !== CURRENCY_VALUES.CNY) return null;
    return 0;
  }
  return value;
}

function group(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  const [intPart = '0', fracPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fracPart ? `${grouped}.${fracPart}` : grouped;
}

/** 金额格式化：人民币取整，外币保留两位 */
export function formatAmount(value: number, currency: Currency): string {
  if (currency === CURRENCY_VALUES.CNY) return `${group(value, 0)} 元`;
  if (currency === CURRENCY_VALUES.HKD) return `${group(value, 2)} 港币`;
  return `${group(value, 2)} 美元`;
}

export function isOnExchange(fund: Pick<FundLimit, 'status'>): boolean {
  return fund.status === PurchaseStatus.OnExchange;
}

export function isBuyable(fund: Pick<FundLimit, 'status'>): boolean {
  return fund.status === PurchaseStatus.Open || fund.status === PurchaseStatus.Limited;
}

/** 日累计限额的可展示文案 */
export function limitDisplay(fund: FundLimit): string {
  if (fund.status === PurchaseStatus.Suspended) return '暂停申购';
  if (isOnExchange(fund)) return '场内交易';
  if (fund.dailyLimit === null) return '无限额';
  return formatAmount(fund.dailyLimit, fund.currency);
}

export function minPurchaseDisplay(fund: FundLimit): string {
  if (fund.minPurchase === null) return '--';
  return formatAmount(fund.minPurchase, fund.currency);
}

/** 把适配器解析出的具名行归一化为领域模型 */
export function buildFundLimit(row: RawFundRow): FundLimit {
  const currency = parseCurrencyFromName(row.name);
  const status = parsePurchaseStatus(row.purchaseStatus);

  return {
    code: row.code,
    name: row.name,
    fundType: row.fundType,
    currency,
    status,
    dailyLimit: normalizeLimit(row.dailyLimit, status, currency),
    minPurchase: toNumber(row.minPurchase),
    nextOpenDate: row.nextOpenDate && row.nextOpenDate !== '' ? row.nextOpenDate : null,
    redeemStatus: parseRedeemStatus(row.redeemStatus),
    nav: toNumber(row.nav),
    navDate: row.navDate && row.navDate !== '' ? row.navDate : null,
    fee: row.fee ?? '',
  };
}
