import { z } from 'zod';

/**
 * 通用基金传输契约（与具体工具无关）。
 *
 * 与 `@funds-helper/core` 的分工：core 定义**领域模型**（纯 TS），这里定义**传输契约**（zod）。
 * 两边的取值字面量必须一致，服务端 `contract.test.ts` 兜住漂移。
 * QDII 与美元份额两个工具共用这三个枚举。
 */

export const CURRENCIES = ['CNY', 'USD', 'HKD'] as const;
export const CurrencySchema = z.enum(CURRENCIES);
export type Currency = z.infer<typeof CurrencySchema>;

export const PURCHASE_STATUSES = [
  '开放申购',
  '限大额',
  '暂停申购',
  '场内交易',
  '封闭期',
  '认购期',
  '',
] as const;
export const PurchaseStatusSchema = z.enum(PURCHASE_STATUSES);
export type PurchaseStatus = z.infer<typeof PurchaseStatusSchema>;

export const REDEEM_STATUSES = [
  '开放赎回',
  '暂停赎回',
  '场内交易',
  '封闭期',
  '认购期',
  '',
] as const;
export const RedeemStatusSchema = z.enum(REDEEM_STATUSES);
export type RedeemStatus = z.infer<typeof RedeemStatusSchema>;
