import { z } from 'zod';
import { FreshnessSchema } from './envelope.ts';

/**
 * QDII 工具的 API 传输契约（transport contract）。
 *
 * 注意与 `@funds-helper/core` 的分工：
 * - core 定义**领域模型**（纯 TS 类型 + 纯函数），不依赖 zod
 * - 这里定义**传输契约**（zod schema），服务端用它校验/序列化，前端用它解析响应
 *
 * 两者的字面量必须一致（如申购状态的取值）。服务端有一致性测试兜住漂移。
 */

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 数据集（列表页的核心载荷）
// ---------------------------------------------------------------------------

export const FundRecordSchema = z.object({
  code: z.string(),
  name: z.string(),
  fundType: z.string(),
  currency: CurrencySchema,
  /** 双维度归类结果（由 core 的纯函数计算，不落库） */
  region: z.string(),
  theme: z.string(),

  status: PurchaseStatusSchema,
  redeemStatus: RedeemStatusSchema,
  /** null = 无限额（哨兵值已在归一化阶段消灭） */
  dailyLimit: z.number().nullable(),
  /** 直接可展示的额度文案，避免前端各写一套格式化 */
  limitText: z.string(),
  minPurchase: z.number().nullable(),
  minPurchaseText: z.string(),
  nextOpenDate: z.string().nullable(),

  nav: z.number().nullable(),
  navDate: z.string().nullable(),
  fee: z.string(),

  onExchange: z.boolean(),
  buyable: z.boolean(),

  /** 该条额度数据的采集时刻与数据日期（用于展示「该额度采集于 X」） */
  capturedAt: z.string(),
  dataDate: z.string().nullable(),
});
export type FundRecord = z.infer<typeof FundRecordSchema>;

export const LimitBandSchema = z.object({
  name: z.string(),
  count: z.number(),
  low: z.number(),
  high: z.number().nullable(),
});
export type LimitBand = z.infer<typeof LimitBandSchema>;

export const CategoryCountSchema = z.object({
  name: z.string(),
  count: z.number(),
});
export type CategoryCount = z.infer<typeof CategoryCountSchema>;

export const QdiiStatsSchema = z.object({
  status: z.record(z.string(), z.number()),
  buyable: z.number(),
  limitBands: z.array(LimitBandSchema),
  /** 最紧的**正数**限额；限大额里的 0 元档不传达有效信息，故排除 */
  tightest: z.number().nullable(),
});
export type QdiiStats = z.infer<typeof QdiiStatsSchema>;

export const QdiiDatasetResponseSchema = z.object({
  freshness: FreshnessSchema,
  total: z.number(),
  stats: QdiiStatsSchema,
  categories: z.object({
    regions: z.array(CategoryCountSchema),
    themes: z.array(CategoryCountSchema),
  }),
  funds: z.array(FundRecordSchema),
  disclaimer: z.string(),
});
export type QdiiDatasetResponse = z.infer<typeof QdiiDatasetResponseSchema>;

// ---------------------------------------------------------------------------
// 单只基金详情
// ---------------------------------------------------------------------------

export const NavPointSchema = z.object({
  date: z.string(),
  nav: z.number(),
  change: z.number().nullable(),
});
export type NavPoint = z.infer<typeof NavPointSchema>;

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

export const NoticeSchema = z.object({
  id: z.string(),
  title: z.string(),
  publishDate: z.string(),
  url: z.string().nullable(),
});
export type Notice = z.infer<typeof NoticeSchema>;

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

export const QdiiFundDetailResponseSchema = z.object({
  code: z.string(),
  /** 数据集中的那一行（含区域/主题/额度），保证抽屉与列表口径一致 */
  record: FundRecordSchema.nullable(),
  base: FundDetailBaseSchema.nullable(),

  navTrend: z.array(NavPointSchema),
  /** 区间统计：近1月/3月/6月/1年/3年 的涨幅与最大回撤 */
  navSummary: z.array(
    z.object({
      label: z.string(),
      returnPct: z.number().nullable(),
      maxDrawdownPct: z.number().nullable(),
    }),
  ),
  scale: z.array(ScalePointSchema),
  allocation: z.array(AllocationItemSchema),
  holders: z.array(AllocationItemSchema),
  periods: z.array(PeriodReturnSchema),
  holdings: z.object({
    stocks: z.array(HoldingStockSchema),
    bonds: z.array(HoldingBondSchema),
    /** 联接基金展示的底层 ETF */
    etf: z.object({ code: z.string(), name: z.string().nullable() }).nullable(),
  }),
  reportDate: z.string().nullable(),

  /** 同基金其它份额类别（A/C 选择用） */
  shareClasses: z.array(ShareClassSchema),
  /** 购买建议 */
  advice: z.array(AdviceItemSchema),
  notices: z.array(NoticeSchema),

  /** 部分区块失败时的说明，不影响其它区块 */
  errors: z.array(z.string()),
  freshness: FreshnessSchema,
  disclaimer: z.string(),
});
export type QdiiFundDetailResponse = z.infer<typeof QdiiFundDetailResponseSchema>;

// ---------------------------------------------------------------------------
// 场内折溢价
// ---------------------------------------------------------------------------

export const PremiumItemSchema = z.object({
  code: z.string(),
  name: z.string(),
  /** 上游 f402：负值 = 溢价 */
  discountRate: z.number().nullable(),
  /** 语义化后的溢价率：正值 = 溢价 */
  premiumRate: z.number().nullable(),
  price: z.number().nullable(),
  nav: z.number().nullable(),
});
export type PremiumItem = z.infer<typeof PremiumItemSchema>;

export const QdiiPremiumResponseSchema = z.object({
  items: z.array(PremiumItemSchema),
  freshness: FreshnessSchema,
  disclaimer: z.string(),
});
export type QdiiPremiumResponse = z.infer<typeof QdiiPremiumResponseSchema>;

// ---------------------------------------------------------------------------
// 额度变更（相对 qdii-helper 的新能力）
// ---------------------------------------------------------------------------

export const ChangeDirectionSchema = z.enum(['tightened', 'loosened']);
export type ChangeDirection = z.infer<typeof ChangeDirectionSchema>;

export const ChangeItemSchema = z.object({
  code: z.string(),
  name: z.string(),
  dataDate: z.string(),
  detectedAt: z.string(),
  field: z.string(),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  direction: ChangeDirectionSchema,
});
export type ChangeItem = z.infer<typeof ChangeItemSchema>;

export const QdiiChangesResponseSchema = z.object({
  items: z.array(ChangeItemSchema),
  summary: z.object({ tightened: z.number(), loosened: z.number() }),
  freshness: FreshnessSchema,
  disclaimer: z.string(),
});
export type QdiiChangesResponse = z.infer<typeof QdiiChangesResponseSchema>;

// ---------------------------------------------------------------------------
// 手动刷新
// ---------------------------------------------------------------------------

export const QdiiRefreshResponseSchema = z.object({
  ok: z.boolean(),
  total: z.number(),
  inserted: z.number(),
  changed: z.number(),
  durationMs: z.number(),
  message: z.string(),
});
export type QdiiRefreshResponse = z.infer<typeof QdiiRefreshResponseSchema>;
