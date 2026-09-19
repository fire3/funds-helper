import type { FundLimit } from './model.ts';
import { PurchaseStatus } from './model.ts';
import { STATUS_WEIGHT } from './sort.ts';

/**
 * 额度变更检测（本次相对 qdii-helper 的核心增量）。
 *
 * 上游没有额度历史接口，时间序列只能靠自己累积 —— 有了相邻两次快照，
 * 就能回答「这只基金什么时候被收紧的、收紧了多少」。
 */

export type ChangeField = 'daily_limit' | 'status' | 'redeem_status' | 'min_purchase';
export type ChangeDirection = 'tightened' | 'loosened';

export interface LimitChange {
  code: string;
  field: ChangeField;
  oldValue: string | null;
  newValue: string | null;
  direction: ChangeDirection;
  /** 额度变化的相对幅度（仅 daily_limit 有意义），如 -0.8 表示限额降到原来的 20% */
  ratio: number | null;
}

/** 赎回状态恶化程度：数值越大越差 */
const REDEEM_WEIGHT: Record<string, number> = {
  开放赎回: 0,
  场内交易: 1,
  认购期: 2,
  封闭期: 3,
  暂停赎回: 4,
  '': 5,
};

function redeemWeight(status: string): number {
  return REDEEM_WEIGHT[status] ?? 5;
}

/** null 表示无限额 —— 参与比较时视为无穷大 */
function comparableLimit(value: number | null): number {
  return value === null ? Number.POSITIVE_INFINITY : value;
}

function directionFromNumbers(oldValue: number, newValue: number): ChangeDirection | null {
  if (newValue === oldValue) return null;
  return newValue < oldValue ? 'tightened' : 'loosened';
}

function formatLimit(value: number | null): string | null {
  return value === null ? null : String(value);
}

/**
 * 对比相邻两次快照，产出变更事件。
 *
 * - `previous` 为空（首次落库）→ 返回空数组，只建立基线，不产生噪声事件
 * - 只报告**发生变化**的字段
 */
export function diffFundLimits(
  previous: readonly FundLimit[],
  current: readonly FundLimit[],
): LimitChange[] {
  if (previous.length === 0) return [];

  const previousByCode = new Map(previous.map((fund) => [fund.code, fund]));
  const changes: LimitChange[] = [];

  for (const next of current) {
    const before = previousByCode.get(next.code);
    // 新增基金不产生「变更」（它是新出现的，不是被调整的）
    if (!before) continue;

    // 1) 日累计限额：null（无限额）视为无穷大
    const oldLimit = comparableLimit(before.dailyLimit);
    const newLimit = comparableLimit(next.dailyLimit);
    const limitDirection = directionFromNumbers(oldLimit, newLimit);
    if (limitDirection) {
      const ratio =
        Number.isFinite(oldLimit) && Number.isFinite(newLimit) && oldLimit > 0
          ? Number((newLimit / oldLimit - 1).toFixed(4))
          : null;
      changes.push({
        code: next.code,
        field: 'daily_limit',
        oldValue: formatLimit(before.dailyLimit),
        newValue: formatLimit(next.dailyLimit),
        direction: limitDirection,
        ratio,
      });
    }

    // 2) 申购状态：权重越大越「买不到」
    const oldStatusWeight = STATUS_WEIGHT[before.status];
    const newStatusWeight = STATUS_WEIGHT[next.status];
    if (oldStatusWeight !== newStatusWeight) {
      changes.push({
        code: next.code,
        field: 'status',
        oldValue: before.status,
        newValue: next.status,
        direction: newStatusWeight > oldStatusWeight ? 'tightened' : 'loosened',
        ratio: null,
      });
    }

    // 3) 赎回状态
    const oldRedeem = redeemWeight(before.redeemStatus);
    const newRedeem = redeemWeight(next.redeemStatus);
    if (oldRedeem !== newRedeem) {
      changes.push({
        code: next.code,
        field: 'redeem_status',
        oldValue: before.redeemStatus,
        newValue: next.redeemStatus,
        direction: newRedeem > oldRedeem ? 'tightened' : 'loosened',
        ratio: null,
      });
    }

    // 4) 申购起点
    const oldMin = before.minPurchase;
    const newMin = next.minPurchase;
    if (oldMin !== newMin && oldMin !== null && newMin !== null) {
      changes.push({
        code: next.code,
        field: 'min_purchase',
        oldValue: String(oldMin),
        newValue: String(newMin),
        direction: newMin > oldMin ? 'tightened' : 'loosened',
        ratio: oldMin > 0 ? Number((newMin / oldMin - 1).toFixed(4)) : null,
      });
    }
  }

  return changes;
}

/** 快照是否处于「暂停申购」——用于变更摘要里的重点提示 */
export function isSuspended(fund: Pick<FundLimit, 'status'>): boolean {
  return fund.status === PurchaseStatus.Suspended;
}
