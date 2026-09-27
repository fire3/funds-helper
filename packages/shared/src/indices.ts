import { z } from 'zod';
import { FreshnessSchema } from './envelope.ts';

/**
 * 国际行情工具（`indices`）的 API 传输契约。
 *
 * 载荷形态与 `fx` 同族：**一组指数的概览** + **单指数的时间序列与派生统计**。
 * 与 fx 的差别：
 * - 指数是**多标的**，概览按地区分组一次下发（约 28 项，小数据量）；
 * - 所有价格都是**原生币种**（USD/HKD/JPY…），不做汇率换算 ——
 *   换算需要锚定日期，属于另一个问题（用 fx 工具看汇率）；
 * - 涨跌字段叫 `value/start/end` 而不是 fx 的 `rate/startRate` ——
 *   指数点位不是「汇率」，沿用 rate 命名会误导。
 */

/** 展示区间。取值与 `FX_RANGE_KEYS` 相同（服务端复用 fx 的序列统计函数，编译期即校验一致） */
export const INDEX_RANGES = ['1y', '3y', '5y', '10y', 'all'] as const;
export const IndexRangeSchema = z.enum(INDEX_RANGES);
export type IndexRange = z.infer<typeof IndexRangeSchema>;

/** 统计区间（区间涨跌表），取值与 `FX_INTERVAL_KEYS` 相同 */
export const INDEX_INTERVALS = ['1m', '3m', '6m', '1y', '3y', '5y', 'ytd', 'all'] as const;
export const IndexIntervalSchema = z.enum(INDEX_INTERVALS);
export type IndexInterval = z.infer<typeof IndexIntervalSchema>;

export const INDEX_DISCLAIMER =
  '指数数据来自 Yahoo Finance（主源）与东方财富、腾讯、新浪财经（备源）的公开接口（免费延迟行情），按各交易所当地日期记录，仅供参考，不构成投资建议';

/** 一根日线。open/high/low 可空（上游偶发缺列），close 必有 */
export const IndexBarSchema = z.object({
  date: z.string(),
  open: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
  close: z.number(),
});
export type IndexBarDto = z.infer<typeof IndexBarSchema>;

export const IndexValueExtremeSchema = z.object({
  date: z.string(),
  value: z.number(),
});
export type IndexValueExtreme = z.infer<typeof IndexValueExtremeSchema>;

export const IndexIntervalChangeSchema = z.object({
  key: z.enum(INDEX_INTERVALS),
  label: z.string(),
  /** 区间起始交易日；数据不足时为 null */
  from: z.string().nullable(),
  to: z.string(),
  start: z.number().nullable(),
  end: z.number(),
  change: z.number().nullable(),
  changePct: z.number().nullable(),
});
export type IndexIntervalChange = z.infer<typeof IndexIntervalChangeSchema>;

export const IndexYearStatSchema = z.object({
  year: z.string(),
  /** 年初 = 该年首个交易日收盘 */
  open: z.number(),
  /** 年末 = 该年最后一个交易日收盘 */
  close: z.number(),
  low: z.number(),
  high: z.number(),
  /** 年内收盘均值 */
  avg: z.number(),
  changePct: z.number().nullable(),
});
export type IndexYearStat = z.infer<typeof IndexYearStatSchema>;

export const IndexSummarySchema = z.object({
  latest: IndexValueExtremeSchema,
  previous: IndexValueExtremeSchema.nullable(),
  /** 最新一根较上一交易日的变动 */
  dayChange: z.number().nullable(),
  dayChangePct: z.number().nullable(),
  rangeHigh: IndexValueExtremeSchema.nullable(),
  rangeLow: IndexValueExtremeSchema.nullable(),
  allTimeHigh: IndexValueExtremeSchema.nullable(),
  allTimeLow: IndexValueExtremeSchema.nullable(),
  /** 近一年年化波动率（%），样本不足时为 null */
  annualizedVolatility: z.number().nullable(),
  /** 全历史交易日总数（走势图可能已抽稀） */
  totalBars: z.number(),
  firstDate: z.string(),
  lastDate: z.string(),
});
export type IndexSummary = z.infer<typeof IndexSummarySchema>;

/** 单指数的走势数据集 */
export const IndexDatasetResponseSchema = z.object({
  /** 内部指数键（URL 参数），如 'SPX' */
  code: z.string(),
  name: z.string(),
  /** 原生计价币种，如 'USD' —— 页面不做汇率换算 */
  currency: z.string(),
  /** 交易所时区（IANA），用于提示「收盘」指哪个时区 */
  timeZone: z.string(),
  range: IndexRangeSchema,
  /** 选定区间内的走势点（长区间会等距抽稀，极值仍取自全量） */
  points: z.array(IndexBarSchema),
  intervals: z.array(IndexIntervalChangeSchema),
  yearly: z.array(IndexYearStatSchema),
  summary: IndexSummarySchema,
  freshness: FreshnessSchema,
  disclaimer: z.string(),
});
export type IndexDatasetResponse = z.infer<typeof IndexDatasetResponseSchema>;

/** 概览里的单条指数行情 */
export const IndexQuoteSchema = z.object({
  code: z.string(),
  name: z.string(),
  /** 原生币种 */
  currency: z.string(),
  /** 最新收盘价（该指数最后一个交易日） */
  price: z.number(),
  /** 上一交易日收盘；只有单根数据时为 null */
  prevClose: z.number().nullable(),
  /** 较上一交易日涨跌额/涨跌幅（按原生币种点位计算） */
  change: z.number().nullable(),
  changePct: z.number().nullable(),
  /** 该指数自身的数据日期 —— 各市场休市节奏不同，必须逐条展示 */
  date: z.string(),
  /** 该行数据实际来自哪个上游（'yahoo' | 'eastmoney' | 'tencent' | 'sina'） */
  source: z.string(),
  /** 最新一个交易日的今开/最高/最低（缺失补齐报价或库里行缺列时为 null） */
  open: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
});
export type IndexQuote = z.infer<typeof IndexQuoteSchema>;

export const IndexRegionGroupSchema = z.object({
  key: z.string(),
  label: z.string(),
  items: z.array(IndexQuoteSchema),
});
export type IndexRegionGroup = z.infer<typeof IndexRegionGroupSchema>;

export const IndexOverviewResponseSchema = z.object({
  regions: z.array(IndexRegionGroupSchema),
  freshness: FreshnessSchema,
  disclaimer: z.string(),
});
export type IndexOverviewResponse = z.infer<typeof IndexOverviewResponseSchema>;

export const IndexRefreshResponseSchema = z.object({
  ok: z.boolean(),
  /** 本次成功的指数数量 */
  indices: z.number(),
  /** 本次写入的 K 线总行数（含各指数重复日期的覆盖） */
  bars: z.number(),
  /** 其中新写入的行数 */
  inserted: z.number(),
  dataDate: z.string().nullable(),
  /** 抓取失败的指数（部分失败不整体报错，但必须可见） */
  failed: z.array(z.object({ code: z.string(), message: z.string() })),
  durationMs: z.number(),
  message: z.string(),
});
export type IndexRefreshResponse = z.infer<typeof IndexRefreshResponseSchema>;
