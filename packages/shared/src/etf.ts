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
  'ETF 行情来自新浪财经 / 东方财富公开接口（延时/快照数据），仅供参考；规模为场内市值估算，实际以基金定期报告为准';

/**
 * 行情渠道：各渠道的**能力差异**。
 *
 * 渠道**必须显式列出不提供哪些字段** —— 否则前端只能看到一排 `null`，
 * 很容易被误读成「这只 ETF 平价」或「没有上市日期」。
 */
export const EtfSpotSourceIdSchema = z.enum(['eastmoney', 'sina']);
export type EtfSpotSourceId = z.infer<typeof EtfSpotSourceIdSchema>;

export const EtfDataSourceInfoSchema = z.object({
  id: EtfSpotSourceIdSchema,
  /** 可直接展示的渠道名 */
  name: z.string(),
  /** 该渠道**不提供**的字段（可直接展示）；空数组 = 字段全量 */
  missing: z.array(z.string()),
});
export type EtfDataSourceInfo = z.infer<typeof EtfDataSourceInfoSchema>;

/**
 * 渠道目录。
 *
 * **默认优先东财**（只有它有折溢价率）：走 `ulist.np` 批量报价（代码池来自目录接口 B），
 * 失败自动降级回新浪；用户在界面上可以把渠道切成**只走新浪**（见 `EtfConfigResponse`），
 * 环境变量 `ETF_EASTMONEY_ENABLED` 只提供「没有运行时配置时」的默认值。
 */
export const ETF_SPOT_SOURCES: Record<EtfSpotSourceId, EtfDataSourceInfo> = {
  sina: {
    id: 'sina',
    name: '新浪财经',
    missing: ['折溢价率', '上市日期', '主力净流入', '量比'],
  },
  eastmoney: { id: 'eastmoney', name: '东方财富行情', missing: [] },
};

/** 行情渠道的展示顺序（界面上的下拉框按它排） */
export const ETF_SPOT_SOURCE_ORDER: readonly EtfSpotSourceId[] = ['eastmoney', 'sina'];

// ---------------------------------------------------------------------------
// 运行时配置（可在界面上切换行情渠道）
// ---------------------------------------------------------------------------

export const EtfConfigResponseSchema = z.object({
  /** 当前偏好：'eastmoney' = 优先东财（失败降级新浪）；'sina' = 只走新浪 */
  spotSource: EtfSpotSourceIdSchema,
  /** 没有运行时配置时使用的默认值（来自 `ETF_EASTMONEY_ENABLED`），仅用于提示 */
  envDefault: EtfSpotSourceIdSchema,
  /** 当前数据集**实际**来自哪个渠道（偏好 ≠ 实际说明发生了降级） */
  activeSource: EtfSpotSourceIdSchema,
  /** 可选渠道及其能力差异（界面据此渲染说明文案） */
  sources: z.array(EtfDataSourceInfoSchema),
});
export type EtfConfigResponse = z.infer<typeof EtfConfigResponseSchema>;

export const EtfConfigUpdateSchema = z.object({
  spotSource: EtfSpotSourceIdSchema,
});
export type EtfConfigUpdate = z.infer<typeof EtfConfigUpdateSchema>;

// ---------------------------------------------------------------------------
// 数据集
// ---------------------------------------------------------------------------

/**
 * 场外联接基金（由「ETF → 场外」反查得到，见 docs/design/etf-tool.md §11）。
 *
 * 一只 ETF 通常有多个份额（A/C/E/I/F），因此这里是数组而不是单个值；
 * `[]` 的含义是**没查到**（该 ETF 本来就没有联接基金，或反查还没跑过）——
 * 前端文案统一写「未查到场外联接基金」，避免把「没有」说成「不存在」。
 */
export const EtfFeederFundSchema = z.object({
  code: z.string(),
  name: z.string(),
});
export type EtfFeederFund = z.infer<typeof EtfFeederFundSchema>;

/** 反查快照的元信息（界面据此说明「联接名单是什么时候查的」） */
export const EtfFeederInfoSchema = z.object({
  /** 上次**成功**反查的时刻（ISO8601）；null = 还没跑过 */
  updatedAt: z.string().nullable(),
  /** 有场外联接基金的 ETF 只数 */
  etfCount: z.number(),
  /** 反查到的联接基金只数 */
  fundCount: z.number(),
});
export type EtfFeederInfo = z.infer<typeof EtfFeederInfoSchema>;

/**
 * 区间涨幅（接口 H）的覆盖度与新鲜度。
 *
 * 与 `feeder` 同一模式：这是独立的慢链路（每周约 1500 个请求），
 * 与行情快照分开计时；`total = 已落库的行数`，`covered* = 该窗口有数据的只数
 * （次新 ETF 缺 3 年数据属正常，界面给覆盖率而不是静默剔除）。
 */
export const EtfPeriodInfoSchema = z.object({
  /** 上次**成功**抓取的时刻（ISO8601）；null = 还没抓过（界面显示空态 + 抓取按钮） */
  updatedAt: z.string().nullable(),
  /** 收益数据日期（上游 `Expansion.TIME`，T-1） */
  dataDate: z.string().nullable(),
  total: z.number(),
  covered1y: z.number(),
  covered3y: z.number(),
});
export type EtfPeriodInfo = z.infer<typeof EtfPeriodInfoSchema>;

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
  /** 主力净流入（元，东财渠道独有；新浪渠道为 null，见 dataSource.missing） */
  mainInflow: z.number().nullable(),

  /** 场内规模（元）：优先取行情的总市值，缺失时用目录里的规模估算 */
  scale: z.number().nullable(),
  /** 份额（份） */
  shares: z.number().nullable(),
  /**
   * 份额变化率 %（净申购代理）：最新份额相对**积累起点**（该 ETF 首个有份额的快照日）。
   * 积累不足两天为 null —— 不能把「刚起步」显示成「0% 没变化」。
   */
  sharesChangePct: z.number().nullable(),
  /** 积累起点（YYYY-MM-DD）：界面据此标注「自 X 日起积累」；null = 还没有起点 */
  sharesSince: z.string().nullable(),

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

  /**
   * 区间涨幅（接口 H，%）：近6月 / 近1年 / 近3年。
   * 每周任务抓取（见 docs/design/etf-hotspot.md §5）；还没抓过 / 次新 ETF 为 null。
   */
  ret6m: z.number().nullable(),
  ret1y: z.number().nullable(),
  ret3y: z.number().nullable(),
  /** 沪深300 同期涨幅（接口 H 的 `hs300`，%）—— 主题/榜单表头的基准对照 */
  bench1y: z.number().nullable(),
  bench3y: z.number().nullable(),

  /** 场外联接基金（A/C/E 各份额）；空数组 = 未查到（见 EtfFeederFundSchema） */
  feederFunds: z.array(EtfFeederFundSchema),

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
  /** 本次快照的行情渠道（主源失败时会降级，前端据此提示缺失字段） */
  dataSource: EtfDataSourceInfoSchema,
  total: z.number(),
  stats: EtfStatsSchema,
  funds: z.array(EtfRecordSchema),
  /** 场外联接基金的覆盖度与新鲜度（反查是独立的慢链路，与行情快照分开计时） */
  feeder: EtfFeederInfoSchema,
  /** 区间涨幅（接口 H）的覆盖度与新鲜度（热点研究 tab 据此显示空态/覆盖率） */
  periodReturns: EtfPeriodInfoSchema,
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
  /** 本次快照实际使用的行情渠道 */
  source: EtfSpotSourceIdSchema,
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

/**
 * 「场外联接基金」反查的刷新响应。
 *
 * 这是**慢**链路（全量约 2300 个请求），因此单独回一个响应体：
 * 成功/空/失败分别计数 —— 「查了 2319 只、13 只上游还没建仓」和
 * 「查了 2319 只、2000 只请求失败」是两件完全不同的事。
 */
export const EtfFeederRefreshResponseSchema = z.object({
  ok: z.boolean(),
  /** 是否全量重建（false = 只补新的候选池代码） */
  full: z.boolean(),
  /** 本次实际反查的基金只数 */
  scanned: z.number(),
  /** 拿到目标 ETF 的只数 */
  mapped: z.number(),
  /** 上游没给目标 ETF 的只数（新成立未建仓 / 联接的是 LOF） */
  empty: z.number(),
  /** 请求失败的只数（下次刷新会自动重试） */
  failed: z.number(),
  /** 落库后的总量：有联接基金的 ETF 只数 / 联接基金只数 */
  etfCount: z.number(),
  fundCount: z.number(),
  durationMs: z.number(),
  message: z.string(),
});
export type EtfFeederRefreshResponse = z.infer<typeof EtfFeederRefreshResponseSchema>;

/**
 * 切换行情渠道的响应：**新的配置 + 切换后立刻重抓的结果**。
 *
 * 两者一起回，前端才知道「偏好已生效、数据也已经是新渠道的」；
 * 如果抓取失败，请求会整体报错，但偏好已经落库 —— 下次抓取就按新渠道来。
 */
export const EtfConfigUpdateResponseSchema = z.object({
  config: EtfConfigResponseSchema,
  refresh: EtfRefreshResponseSchema,
});
export type EtfConfigUpdateResponse = z.infer<typeof EtfConfigUpdateResponseSchema>;

/**
 * 区间涨幅抓取的响应。
 *
 * 慢链路（首次约 1500 个请求 / 3 分钟）：成功/失败分开计数 ——
 * 「查了 1500 只、20 只失败」与「全挂」是两件事，失败的下轮自动重试。
 */
export const EtfPeriodRefreshResponseSchema = z.object({
  ok: z.boolean(),
  /** 是否忽略 7 天新鲜度强制全抓 */
  full: z.boolean(),
  /** 本轮实际发起请求的只数（新鲜的直接跳过） */
  scanned: z.number(),
  /** 落库的只数 */
  updated: z.number(),
  /** 请求失败的只数（保留旧行，下轮重试） */
  failed: z.number(),
  /** 距上次抓取不足 7 天且非 full → 未打任何上游 */
  skipped: z.boolean(),
  durationMs: z.number(),
  message: z.string(),
});
export type EtfPeriodRefreshResponse = z.infer<typeof EtfPeriodRefreshResponseSchema>;
