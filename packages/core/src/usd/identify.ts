import type { Currency, PurchaseStatus } from '../fund/model.ts';
import { isBuyable } from '../fund/normalize.ts';
import { USD_KINDS, type UsdKind } from './model.ts';

/**
 * 美元份额识别（纯函数）。
 *
 * 币种判定本身复用 `parseCurrencyFromName`（「人民币」优先那条规则很关键），
 * 这里只负责：① 是否是美元份额；② 是现汇还是现钞。
 */

/**
 * 份额形式判定：现钞 / 美钞 → 现钞；现汇 / 美汇 → 现汇；其余（仅含「美元」）→ 未标注。
 *
 * 顺序敏感：`美元现汇` 同时含「美元」与「现汇」，必须先判现钞 / 现汇再兜底到「未标注」。
 */
export function parseUsdKind(name: string): UsdKind {
  if (name.includes('现钞') || name.includes('美钞')) return USD_KINDS.Cash;
  if (name.includes('现汇') || name.includes('美汇')) return USD_KINDS.Spot;
  return USD_KINDS.Unspecified;
}

/** 是否是美元份额（币种由名称判定，见 `parseCurrencyFromName`） */
export function isUsdShare(fund: { currency: Currency }): boolean {
  return fund.currency === 'USD';
}

/**
 * 是否**可用美元购买**。
 *
 * 口径（本工具明确决策）：**以申购状态为准** —— `开放申购` / `限大额` 即视为可买。
 * 日限额（`dailyLimit`）因渠道不售而不可靠，故不参与判定（见 `describeUsdLimit`）。
 */
export function isUsdBuyable(fund: { status: PurchaseStatus }): boolean {
  return isBuyable(fund);
}
