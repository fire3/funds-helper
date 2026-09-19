import type { FundLimit } from '../fund/model.ts';
import { PurchaseStatus } from '../fund/model.ts';
import { formatAmount, isOnExchange, toNumber } from '../fund/normalize.ts';
import { USD_CHANNEL_NOTE } from './model.ts';

/**
 * 美元份额的额度文案。
 *
 * 为什么不能直接用通用的 `limitDisplay`：美元份额在天天基金渠道**通常不销售**，
 * 上游把日限额写成 `0`。而 `normalizeLimit` 对「非人民币 + 0」统一归一化为 `null`（无限额），
 * 若直接展示会误导成「无限额」。这里区分三种 `null`：
 *   - 原始值就是 `0`  → 「渠道不适用」（渠道不售，不是没有限额）
 *   - 哨兵值 / 空值    → 「无限额」（真的是没有限额）
 *   - 有正数限额        → 原样展示美元金额
 *
 * 因为落库时只存归一化后的 `daily_limit`（`0` 与哨兵值都变成 `null`），
 * 所以「是否渠道不售」必须在**抓取阶段**用原始值判定并单独落库，
 * 读取时把结论传给 `describeUsdLimit`，避免二次判断时丢失信息。
 */

/**
 * 判定上游的 `0` 是否来自「渠道不售」。
 * 场内交易与暂停申购本就不走申赎通道，`0` 对它们没有额外含义。
 */
export function isChannelNotSold(fund: FundLimit, rawDailyLimit: string | number | null): boolean {
  return (
    fund.dailyLimit === null &&
    fund.status !== PurchaseStatus.Suspended &&
    !isOnExchange(fund) &&
    toNumber(rawDailyLimit) === 0
  );
}

export interface UsdLimitInfo {
  text: string;
  /** true = 上游的 0 值来自渠道不售，而非真实限额 */
  channelNotSold: boolean;
  note: string | null;
}

export function describeUsdLimit(fund: FundLimit, channelNotSold: boolean): UsdLimitInfo {
  if (fund.status === PurchaseStatus.Suspended) {
    return { text: '暂停申购', channelNotSold: false, note: null };
  }
  if (isOnExchange(fund)) {
    return { text: '场内交易', channelNotSold: false, note: null };
  }
  if (fund.dailyLimit !== null) {
    return {
      text: formatAmount(fund.dailyLimit, fund.currency),
      channelNotSold: false,
      note: null,
    };
  }
  if (channelNotSold) {
    return { text: '渠道不适用', channelNotSold: true, note: USD_CHANNEL_NOTE };
  }
  return { text: '无限额', channelNotSold: false, note: null };
}
