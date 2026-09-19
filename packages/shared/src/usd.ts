import { z } from 'zod';
import { FreshnessSchema } from './envelope.ts';
import { CurrencySchema, PurchaseStatusSchema, RedeemStatusSchema } from './fund.ts';
import { FundDetailBaseSchema, FundDetailSectionsSchema, ShareClassSchema } from './fund-detail.ts';

/**
 * 美元份额工具（`usd`）的 API 传输契约。
 *
 * 它复用 `fund.ts` / `fund-detail.ts` 的通用枚举与详情区块 ——
 * 详情抽屉与 QDII 工具完全同构，只有列表载荷多了「份额形式」这一维度。
 */

export const USD_KINDS = ['现汇', '现钞', '未标注'] as const;
export const UsdKindSchema = z.enum(USD_KINDS);
export type UsdKind = z.infer<typeof UsdKindSchema>;

// ---------------------------------------------------------------------------
// 数据集
// ---------------------------------------------------------------------------

export const UsdFundRecordSchema = z.object({
  code: z.string(),
  name: z.string(),
  fundType: z.string(),
  currency: CurrencySchema,
  /** 现汇 / 现钞 / 未标注（由名称判定） */
  usdKind: UsdKindSchema,
  /** 双维度归类结果（复用 QDII 的 classify 纯函数，不落库） */
  region: z.string(),
  theme: z.string(),

  status: PurchaseStatusSchema,
  redeemStatus: RedeemStatusSchema,
  /** 以申购状态为准：开放申购 / 限大额 = 可买 */
  buyable: z.boolean(),
  onExchange: z.boolean(),

  dailyLimit: z.number().nullable(),
  /**
   * 可展示的额度文案：
   * `2.00 美元` | `无限额` | `渠道不适用` | `暂停申购` | `场内交易`
   */
  limitText: z.string(),
  /** 当额度标注为「渠道不适用」时给出的原因说明 */
  dailyLimitNote: z.string().nullable(),
  minPurchase: z.number().nullable(),
  minPurchaseText: z.string(),
  nextOpenDate: z.string().nullable(),

  nav: z.number().nullable(),
  navDate: z.string().nullable(),
  fee: z.string(),

  capturedAt: z.string(),
  dataDate: z.string().nullable(),
});
export type UsdFundRecord = z.infer<typeof UsdFundRecordSchema>;

export const UsdStatsSchema = z.object({
  status: z.record(z.string(), z.number()),
  usdKind: z.record(z.string(), z.number()),
  buyable: z.number(),
});
export type UsdStats = z.infer<typeof UsdStatsSchema>;

export const UsdDatasetResponseSchema = z.object({
  freshness: FreshnessSchema,
  total: z.number(),
  stats: UsdStatsSchema,
  categories: z.object({
    regions: z.array(z.object({ name: z.string(), count: z.number() })),
    themes: z.array(z.object({ name: z.string(), count: z.number() })),
  }),
  funds: z.array(UsdFundRecordSchema),
  disclaimer: z.string(),
});
export type UsdDatasetResponse = z.infer<typeof UsdDatasetResponseSchema>;

// ---------------------------------------------------------------------------
// 单只基金详情（通用详情区块 + 美元份额专有：record / 人民币份额对照）
// ---------------------------------------------------------------------------

export const UsdFundDetailResponseSchema = FundDetailSectionsSchema.extend({
  code: z.string(),
  record: UsdFundRecordSchema.nullable(),
  base: FundDetailBaseSchema.nullable(),
  /** 同基金的非美元份额（人民币对照，比较成本用） */
  cnySiblings: z.array(ShareClassSchema),
  freshness: FreshnessSchema,
  disclaimer: z.string(),
});
export type UsdFundDetailResponse = z.infer<typeof UsdFundDetailResponseSchema>;

// ---------------------------------------------------------------------------
// 手动刷新
// ---------------------------------------------------------------------------

export const UsdRefreshResponseSchema = z.object({
  ok: z.boolean(),
  total: z.number(),
  inserted: z.number(),
  changed: z.number(),
  durationMs: z.number(),
  message: z.string(),
});
export type UsdRefreshResponse = z.infer<typeof UsdRefreshResponseSchema>;
