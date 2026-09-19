import { z } from 'zod';
import { FreshnessSchema } from './envelope.ts';
import { CurrencySchema, PurchaseStatusSchema, RedeemStatusSchema } from './fund.ts';
import {
  AdviceItemSchema,
  FundDetailBaseSchema,
  FundDetailSectionsSchema,
  ShareClassSchema,
} from './fund-detail.ts';

/**
 * QDII 工具的 API 传输契约（transport contract）。
 *
 * 通用部分（币种/状态枚举、详情区块）在 `fund.ts` / `fund-detail.ts`，这里只放 QDII 专有载荷。
 * 服务端用它校验/序列化，前端用它解析响应。
 */

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
// 单只基金详情（通用区块 + QDII 专有：record / shareClasses / advice / notices）
// ---------------------------------------------------------------------------

export const QdiiFundDetailResponseSchema = FundDetailSectionsSchema.extend({
  code: z.string(),
  /** 数据集中的那一行（含区域/主题/额度），保证抽屉与列表口径一致 */
  record: FundRecordSchema.nullable(),
  base: FundDetailBaseSchema.nullable(),

  /** 同基金其它份额类别（A/C 选择用） */
  shareClasses: z.array(ShareClassSchema),
  /** 购买建议 */
  advice: z.array(AdviceItemSchema),

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
