/**
 * 通用基金领域模型（纯类型，零 IO、零框架依赖）。
 *
 * 这些概念与 QDII 无关，是任何「按份额查询基金」的工具共用的词汇：
 * 申购/赎回状态、份额币种、上游行、归一化后的额度记录。
 * 第二个工具（美元份额）直接复用它们，QDII 切片也从这里取（见 `qdii/model.ts` 的转发）。
 *
 * 取值字面量必须与 `@funds-helper/shared` 的传输契约保持一致
 * —— 服务端有一致性测试兜住漂移。
 */

/** 申购状态。注意：赎回状态是另一套枚举，不能复用（见 RedeemStatus）。 */
export const PurchaseStatus = {
  Open: '开放申购',
  Limited: '限大额',
  Suspended: '暂停申购',
  OnExchange: '场内交易',
  Closed: '封闭期',
  Subscribing: '认购期',
  Unknown: '',
} as const;
export type PurchaseStatus = (typeof PurchaseStatus)[keyof typeof PurchaseStatus];

export const REDEEM_STATUS_VALUES = {
  Open: '开放赎回',
  Suspended: '暂停赎回',
  OnExchange: '场内交易',
  Closed: '封闭期',
  Subscribing: '认购期',
  Unknown: '',
} as const;
export type RedeemStatus = (typeof REDEEM_STATUS_VALUES)[keyof typeof REDEEM_STATUS_VALUES];

export const CURRENCY_VALUES = {
  CNY: 'CNY',
  USD: 'USD',
  HKD: 'HKD',
} as const;
export type Currency = (typeof CURRENCY_VALUES)[keyof typeof CURRENCY_VALUES];

/**
 * 上游接口 A 的一行，已被适配器解析成具名字段。
 * core 只负责把它的**语义**归一化，不负责它的**形状**解析（那是 sources 的职责）。
 */
export interface RawFundRow {
  code: string;
  name: string;
  fundType: string;
  nav: string | null;
  navDate: string | null;
  purchaseStatus: string | null;
  redeemStatus: string | null;
  nextOpenDate: string | null;
  minPurchase: string | null;
  dailyLimit: string | null;
  fee: string | null;
}

/** 归一化后的基金额度记录 */
export interface FundLimit {
  code: string;
  name: string;
  fundType: string;
  currency: Currency;

  status: PurchaseStatus;
  /** null = 无限额。哨兵值已在归一化阶段消灭，下游不必再判断阈值 */
  dailyLimit: number | null;
  minPurchase: number | null;
  nextOpenDate: string | null;

  redeemStatus: RedeemStatus;

  nav: number | null;
  /** 接口 A 只给 MM-DD，接口 B 才带年份；由调用方决定语义 */
  navDate: string | null;
  fee: string;
}
