import { z } from 'zod';
import { PurchaseStatusSchema } from './fund.ts';

/**
 * 基金详情的**通用区块**契约。
 *
 * 这些区块来自同一批上游接口（B/G/H/I/D），QDII 与美元份额两个工具的详情抽屉完全一样，
 * 因此抽到这里共用；各工具在自己的响应 schema 里用 `.extend(...)` 组合。
 */

// ---------------------------------------------------------------------------
// 单只基金详情：基础信息（接口 B）
// ---------------------------------------------------------------------------

export const FundDetailBaseSchema = z.object({
  name: z.string().nullable(),
  fundType: z.string().nullable(),
  company: z.string().nullable(),
  manager: z.string().nullable(),
  purchaseStatus: z.string().nullable(),
  redeemStatus: z.string().nullable(),
  maxPurchase: z.number().nullable(),
  minPurchase: z.number().nullable(),
  nav: z.number().nullable(),
  navDate: z.string().nullable(),
  nextOpenDate: z.string().nullable(),
  sourceRate: z.string().nullable(),
  rate: z.string().nullable(),
  riskLevel: z.string().nullable(),
});
export type FundDetailBase = z.infer<typeof FundDetailBaseSchema>;

// ---------------------------------------------------------------------------
// 净值走势与区间统计（接口 G）
// ---------------------------------------------------------------------------

export const NavPointSchema = z.object({
  date: z.string(),
  nav: z.number(),
  change: z.number().nullable(),
});
export type NavPoint = z.infer<typeof NavPointSchema>;

export const NavSummaryRowSchema = z.object({
  label: z.string(),
  returnPct: z.number().nullable(),
  maxDrawdownPct: z.number().nullable(),
});
export type NavSummaryRow = z.infer<typeof NavSummaryRowSchema>;

export const ScalePointSchema = z.object({
  date: z.string(),
  scale: z.number().nullable(),
  mom: z.string().nullable(),
});
export type ScalePoint = z.infer<typeof ScalePointSchema>;

export const AllocationItemSchema = z.object({
  name: z.string(),
  value: z.number().nullable(),
});
export type AllocationItem = z.infer<typeof AllocationItemSchema>;

// ---------------------------------------------------------------------------
// 分周期收益（接口 H）
// ---------------------------------------------------------------------------

export const PeriodReturnSchema = z.object({
  /** 上游周期键：Z / Y / 3Y / 6Y / 1N / 2N / 3N / 5N / JN / LN */
  key: z.string(),
  /** 中文标签，避免前端再维护一份映射 */
  label: z.string(),
  ret: z.number().nullable(),
  avg: z.number().nullable(),
  bench: z.number().nullable(),
  rank: z.number().nullable(),
  total: z.number().nullable(),
});
export type PeriodReturn = z.infer<typeof PeriodReturnSchema>;

// ---------------------------------------------------------------------------
// 持仓（接口 I）
// ---------------------------------------------------------------------------

export const HoldingStockSchema = z.object({
  code: z.string().nullable(),
  name: z.string().nullable(),
  weight: z.number().nullable(),
  action: z.string().nullable(),
  delta: z.number().nullable(),
});
export type HoldingStock = z.infer<typeof HoldingStockSchema>;

export const HoldingBondSchema = z.object({
  code: z.string().nullable(),
  name: z.string().nullable(),
  weight: z.number().nullable(),
});
export type HoldingBond = z.infer<typeof HoldingBondSchema>;

export const HoldingsSchema = z.object({
  stocks: z.array(HoldingStockSchema),
  bonds: z.array(HoldingBondSchema),
  /** 联接基金展示的底层 ETF */
  etf: z.object({ code: z.string(), name: z.string().nullable() }).nullable(),
});
export type Holdings = z.infer<typeof HoldingsSchema>;

// ---------------------------------------------------------------------------
// 公告 / 份额类别 / 建议
// ---------------------------------------------------------------------------

export const NoticeSchema = z.object({
  id: z.string(),
  title: z.string(),
  publishDate: z.string(),
  url: z.string().nullable(),
});
export type Notice = z.infer<typeof NoticeSchema>;

export const ShareClassSchema = z.object({
  code: z.string(),
  name: z.string(),
  dailyLimit: z.number().nullable(),
  status: PurchaseStatusSchema,
});
export type ShareClass = z.infer<typeof ShareClassSchema>;

/** 购买建议条目。tone 决定界面的视觉处理 */
export const AdviceItemSchema = z.object({
  tone: z.enum(['info', 'warn', 'good']),
  title: z.string(),
  text: z.string(),
});
export type AdviceItem = z.infer<typeof AdviceItemSchema>;

// ---------------------------------------------------------------------------
// 净值除权事件（份额分拆 / 分红除息）
// ---------------------------------------------------------------------------

/**
 * 单位净值的**除权事件**。
 *
 * 单位净值会因份额分拆机械下调：实测 159507 在 2026-06-08 每份分拆 3 份，
 * 单位净值 3.1334 → 1.0103（看起来一天跌 67.8%），而上游记录的真实涨跌只有 -3.27%。
 * 这类「净值突变」必须在卡片里解释清楚，否则会被当成亏损。
 *
 * `title` / `text` 由服务端用 core 的口径生成（数值与文案一起下发），
 * 前端只负责渲染，避免两边各有一套说法。
 */
export const NAV_EVENT_KINDS = ['split', 'dividend', 'other'] as const;
export const NavEventKindSchema = z.enum(NAV_EVENT_KINDS);
export type NavEventKind = z.infer<typeof NavEventKindSchema>;

export const NavEventSchema = z.object({
  date: z.string(),
  kind: NavEventKindSchema,
  /** 上游 `unitMoney` 原文 */
  detail: z.string(),
  /** 拆分比例：3 = 每份拆成 3 份 */
  ratio: z.number().nullable(),
  /** 每份分红金额（元）*/
  amount: z.number().nullable(),
  /** 可直接展示的标题与解释 */
  title: z.string(),
  text: z.string(),
});
export type NavEvent = z.infer<typeof NavEventSchema>;

// ---------------------------------------------------------------------------
// 详情区块（跨工具共用）
// ---------------------------------------------------------------------------

/** 详情抽屉里「与工具无关」的那部分载荷：净值 / 收益 / 规模 / 配置 / 持仓 / 公告 / 局部错误 */
export const FundDetailSectionsSchema = z.object({
  navTrend: z.array(NavPointSchema),
  /**
   * 除权事件（无事件 = 空数组）。**带 `.default([])`**：详情缓存是持久化的，
   * 旧缓存里没有这个字段，缺省成空数组能避免升级后打开抽屉直接报「数据结构不符合预期」。
   */
  navEvents: z.array(NavEventSchema).default([]),
  /** 区间统计：近1月/3月/6月/1年/3年 的涨幅与最大回撤（除权后按复权口径）*/
  navSummary: z.array(NavSummaryRowSchema),
  /** 区间统计的口径说明；序列本身可比时为 null */
  navSummaryNote: z.string().nullable().default(null),
  scale: z.array(ScalePointSchema),
  allocation: z.array(AllocationItemSchema),
  holders: z.array(AllocationItemSchema),
  periods: z.array(PeriodReturnSchema),
  holdings: HoldingsSchema,
  reportDate: z.string().nullable(),
  notices: z.array(NoticeSchema),
  /** 部分区块失败时的说明，不影响其它区块 */
  errors: z.array(z.string()),
});
export type FundDetailSections = z.infer<typeof FundDetailSectionsSchema>;
