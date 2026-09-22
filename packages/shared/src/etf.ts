import { z } from 'zod';
import { FreshnessSchema } from './envelope.ts';
import {
  FundDetailBaseSchema,
  FundDetailSectionsSchema,
  NavPointSchema,
  PeriodReturnSchema,
  ScalePointSchema,
} from './fund-detail.ts';

/**
 * ETF 工具（`etf`）的 API 传输契约。
 *
 * 与其它工具一致：**数值与文案一起下发**（`premiumRate` + `premiumText`/`premiumNote`），
 * 前端不重复实现领域口径；分类与折溢价档位的字面量必须与 `@funds-helper/core`
 * 逐字一致（`apps/server/src/contract.test.ts` 会比对）。
 */

export const ETF_CATEGORIES = ['宽基', '行业主题', '风格', '跨境', '债券', '商品', '货币'] as const;
export const EtfCategorySchema = z.enum(ETF_CATEGORIES);
export type EtfCategory = z.infer<typeof EtfCategorySchema>;

export const ETF_MARKETS = ['沪市', '深市'] as const;
export const EtfMarketSchema = z.enum(ETF_MARKETS);
export type EtfMarket = z.infer<typeof EtfMarketSchema>;

export const ETF_PREMIUM_LEVELS = ['高溢价', '溢价', '平价', '折价', '高折价'] as const;
export const EtfPremiumLevelSchema = z.enum(ETF_PREMIUM_LEVELS);
export type EtfPremiumLevel = z.infer<typeof EtfPremiumLevelSchema>;

export const ETF_DISCLAIMER =
  'ETF 行情与折溢价来自东方财富公开接口（延时/快照数据），仅供参考；规模为场内市值估算，实际以基金定期报告为准';

// ---------------------------------------------------------------------------
// 数据集
// ---------------------------------------------------------------------------

export const EtfRecordSchema = z.object({
  code: z.string(),
  name: z.string(),
  market: EtfMarketSchema,
  category: EtfCategorySchema,
  /** 分类来自上游标志位（upstream）还是名称回退（name） */
  categorySource: z.enum(['upstream', 'name']),

  /** 跟踪指数（接口 B；货币 ETF 为空） */
  indexCode: z.string().nullable(),
  indexName: z.string().nullable(),

  /** 场内行情 */
  price: z.number().nullable(),
  changePct: z.number().nullable(),
  changeAmt: z.number().nullable(),
  open: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
  prevClose: z.number().nullable(),
  /** 振幅 % / 换手率 % / 量比 */
  amplitude: z.number().nullable(),
  turnover: z.number().nullable(),
  volumeRatio: z.number().nullable(),
  /** 成交量（手）/ 成交额（元） */
  volume: z.number().nullable(),
  amount: z.number().nullable(),

  /** 场内规模（元）：优先取行情的总市值，缺失时用目录里的规模估算 */
  scale: z.number().nullable(),
  /** 份额（份） */
  shares: z.number().nullable(),

  /** 折溢价率（%）：**正 = 溢价**（上游 f402 已取反） */
  premiumRate: z.number().nullable(),
  premiumLevel: z.union([EtfPremiumLevelSchema, z.literal('未知')]),
  /** 可直接渲染：`溢价 0.43%` / `折价 0.06%` / `—` */
  premiumText: z.string(),
  /** 仅「高溢价」时给出的提示 */
  premiumNote: z.string().nullable(),

  /** 上市日期（YYYY-MM-DD） */
  listingDate: z.string().nullable(),

  /** 区间涨跌（接口 B，%）；次新 ETF 可能为空 */
  change1w: z.number().nullable(),
  change1m: z.number().nullable(),
  change3m: z.number().nullable(),
  ytdChange: z.number().nullable(),
  /** 近一年最大回撤（%，负值） */
  maxDrawdown1y: z.number().nullable(),

  /** 行情时间戳（ISO8601，Asia/Shanghai 语义） */
  quoteAt: z.string().nullable(),
  dataDate: z.string().nullable(),
  capturedAt: z.string(),
});
export type EtfRecord = z.infer<typeof EtfRecordSchema>;

export const EtfCategoryStatSchema = z.object({
  category: EtfCategorySchema,
  count: z.number(),
  scale: z.number(),
  amount: z.number(),
});

export const EtfStatsSchema = z.object({
  total: z.number(),
  totalScale: z.number(),
  totalAmount: z.number(),
  byCategory: z.array(EtfCategoryStatSchema),
  byMarket: z.array(z.object({ market: EtfMarketSchema, count: z.number(), scale: z.number() })),
  premium: z.object({
    counts: z.record(EtfPremiumLevelSchema, z.number()),
    unknown: z.number(),
    maxPremium: z.object({ code: z.string(), name: z.string(), rate: z.number() }).nullable(),
    maxDiscount: z.object({ code: z.string(), name: z.string(), rate: z.number() }).nullable(),
  }),
  extremes: z.object({
    largest: z.object({ code: z.string(), name: z.string(), value: z.number() }).nullable(),
    mostActive: z.object({ code: z.string(), name: z.string(), value: z.number() }).nullable(),
    bestChange: z.object({ code: z.string(), name: z.string(), value: z.number() }).nullable(),
    worstChange: z.object({ code: z.string(), name: z.string(), value: z.number() }).nullable(),
  }),
  /** 覆盖率：接口 B 的目录条数与「有行情」条数之差 = 已成立未上市 */
  coverage: z.object({
    spot: z.number(),
    profile: z.number(),
    unlisted: z.number(),
  }),
});
export type EtfStats = z.infer<typeof EtfStatsSchema>;

export const EtfDatasetResponseSchema = z.object({
  freshness: FreshnessSchema,
  total: z.number(),
  stats: EtfStatsSchema,
  funds: z.array(EtfRecordSchema),
  disclaimer: z.string(),
});
export type EtfDatasetResponse = z.infer<typeof EtfDatasetResponseSchema>;

// ---------------------------------------------------------------------------
// 单只 ETF 详情
// ---------------------------------------------------------------------------

/** 接口 C 摘取的「基金概况」（费率 / 规模 / 管理人） */
export const EtfFundProfileSchema = z.object({
  fullName: z.string().nullable(),
  fundType: z.string().nullable(),
  indexCode: z.string().nullable(),
  indexName: z.string().nullable(),
  /** 管理费 / 托管费 / 销售服务费（原始百分比字符串，`null` = 不收） */
  managementFee: z.string().nullable(),
  custodyFee: z.string().nullable(),
  salesServiceFee: z.string().nullable(),
  /** 净资产规模（元）与截止日 */
  netAssets: z.number().nullable(),
  netAssetsDate: z.string().nullable(),
  shareNetAssets: z.number().nullable(),
  establishedDate: z.string().nullable(),
  company: z.string().nullable(),
  custodian: z.string().nullable(),
  manager: z.string().nullable(),
  benchmark: z.string().nullable(),
  riskLevel: z.string().nullable(),
});
export type EtfFundProfile = z.infer<typeof EtfFundProfileSchema>;

export const EtfFundDetailResponseSchema = FundDetailSectionsSchema.extend({
  code: z.string(),
  record: EtfRecordSchema.nullable(),
  profile: EtfFundProfileSchema.nullable(),
  base: FundDetailBaseSchema.nullable(),
  navTrend: z.array(NavPointSchema),
  scale: z.array(ScalePointSchema),
  periods: z.array(PeriodReturnSchema),
  freshness: FreshnessSchema,
  disclaimer: z.string(),
});
export type EtfFundDetailResponse = z.infer<typeof EtfFundDetailResponseSchema>;

// ---------------------------------------------------------------------------
// 手动刷新
// ---------------------------------------------------------------------------

export const EtfRefreshResponseSchema = z.object({
  ok: z.boolean(),
  /** 行情行数（有场内行情的 ETF） */
  spot: z.number(),
  /** 目录行数（接口 B；失败时为 0） */
  profile: z.number(),
  inserted: z.number(),
  dataDate: z.string().nullable(),
  durationMs: z.number(),
  message: z.string(),
});
export type EtfRefreshResponse = z.infer<typeof EtfRefreshResponseSchema>;
