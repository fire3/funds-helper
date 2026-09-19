/**
 * 美元份额工具（`usd`）的领域模型。
 *
 * 复用通用基金模型（`../fund/model.ts`），只补一个美元份额特有的维度：
 * **份额形式**（现汇 / 现钞 / 未标注）—— 它在名称里，决定「怎么把这笔美元汇进去」。
 */

/** 美元份额形式。现汇 = 境外/账户间的汇划外汇；现钞 = 现金外汇 */
export const USD_KINDS = {
  Spot: '现汇',
  Cash: '现钞',
  Unspecified: '未标注',
} as const;
export type UsdKind = (typeof USD_KINDS)[keyof typeof USD_KINDS];

/** 「渠道不适用」的说明文案：美元份额在天天基金渠道通常不销售，0 值不代表真实限额 */
export const USD_CHANNEL_NOTE =
  '美元份额通常不在天天基金渠道销售，此处额度不代表真实限额，实际额度以银行 / 基金公司直销渠道为准';
