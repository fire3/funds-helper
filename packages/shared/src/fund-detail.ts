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
// 详情区块（跨工具共用）
// ---------------------------------------------------------------------------

/** 详情抽屉里「与工具无关」的那部分载荷：净值 / 收益 / 规模 / 配置 / 持仓 / 公告 / 局部错误 */
export const FundDetailSectionsSchema = z.object({
  navTrend: z.array(NavPointSchema),
  /** 区间统计：近1月/3月/6月/1年/3年 的涨幅与最大回撤 */
  navSummary: z.array(NavSummaryRowSchema),
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
