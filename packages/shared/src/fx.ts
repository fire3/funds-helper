import { z } from 'zod';
import { FreshnessSchema } from './envelope.ts';

/**
 * 汇率工具（`fx`）的 API 传输契约。
 *
 * 与前两个工具（截面数据）不同，本工具的载荷是**一条时间序列** + 三张派生统计表：
 * 走势点、区间涨跌、年度表现。所有派生结果都由服务端按请求的 `direction` 算好后下发 ——
 * 涨跌幅在 `1/x` 换算下**不对称**（`USD/CNY +5%` 对应 `CNY/USD ≈ −4.76%`），
 * 交给前端取倒数会得到错误数字。
 */

/** 报价方向：`USD/CNY` = 1 美元兑多少人民币 */
export const FX_DIRECTIONS = ['USD/CNY', 'CNY/USD'] as const;
export const FxDirectionSchema = z.enum(FX_DIRECTIONS);
export type FxDirection = z.infer<typeof FxDirectionSchema>;

/** 展示区间 */
export const FX_RANGES = ['1y', '3y', '5y', '10y', 'all'] as const;
export const FxRangeSchema = z.enum(FX_RANGES);
export type FxRange = z.infer<typeof FxRangeSchema>;

/** 统计区间（区间涨跌表） */
export const FX_INTERVALS = ['1m', '3m', '6m', '1y', '3y', '5y', 'ytd', 'all'] as const;

export const FX_DISCLAIMER =
  '汇率数据来自新浪财经公开接口（在岸美元兑人民币即期汇率），仅供参考；实际换汇价格以银行挂牌牌价为准';

/** 一根日线。早期（1994–2005）固定汇率时期四列相同 */
export const FxRatePointSchema = z.object({
  date: z.string(),
  open: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
  close: z.number(),
});
export type FxRatePoint = z.infer<typeof FxRatePointSchema>;

export const FxExtremeSchema = z.object({
  date: z.string(),
  rate: z.number(),
});
export type FxExtreme = z.infer<typeof FxExtremeSchema>;

export const FxIntervalChangeSchema = z.object({
  key: z.enum(FX_INTERVALS),
  label: z.string(),
  /** 区间起始交易日；数据不足时为 null（此时涨跌也为 null） */
  from: z.string().nullable(),
  to: z.string(),
  startRate: z.number().nullable(),
  endRate: z.number(),
  change: z.number().nullable(),
  changePct: z.number().nullable(),
});
export type FxIntervalChange = z.infer<typeof FxIntervalChangeSchema>;

export const FxYearStatSchema = z.object({
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
export type FxYearStat = z.infer<typeof FxYearStatSchema>;

export const FxSummarySchema = z.object({
  latest: FxExtremeSchema,
  previous: FxExtremeSchema.nullable(),
  /** 最新一根较上一交易日的变动（按展示方向计算） */
  dayChange: z.number().nullable(),
  dayChangePct: z.number().nullable(),
  /** 选定区间内的极值 */
  rangeHigh: FxExtremeSchema.nullable(),
  rangeLow: FxExtremeSchema.nullable(),
  /** 全历史极值 */
  allTimeHigh: FxExtremeSchema.nullable(),
  allTimeLow: FxExtremeSchema.nullable(),
  /** 近一年年化波动率（%），样本不足时为 null */
  annualizedVolatility: z.number().nullable(),
  /** 全历史交易日总数（走势图可能已抽稀） */
  totalBars: z.number(),
  firstDate: z.string(),
  lastDate: z.string(),
});
export type FxSummary = z.infer<typeof FxSummarySchema>;

export const FxDatasetResponseSchema = z.object({
  /** 上游标的，如 'fx_susdcny'（在岸美元兑人民币即期汇率） */
  symbol: z.string(),
  direction: FxDirectionSchema,
  range: FxRangeSchema,
  /** 选定区间内的走势点（长区间会等距抽稀，极值仍取自全量） */
  points: z.array(FxRatePointSchema),
  intervals: z.array(FxIntervalChangeSchema),
  yearly: z.array(FxYearStatSchema),
  summary: FxSummarySchema,
  freshness: FreshnessSchema,
  disclaimer: z.string(),
});
export type FxDatasetResponse = z.infer<typeof FxDatasetResponseSchema>;

export const FxRefreshResponseSchema = z.object({
  ok: z.boolean(),
  /** 上游返回的日线总数 */
  bars: z.number(),
  /** 本次新写入的行数（整段 upsert，重复抓取为 0） */
  inserted: z.number(),
  dataDate: z.string().nullable(),
  durationMs: z.number(),
  message: z.string(),
});
export type FxRefreshResponse = z.infer<typeof FxRefreshResponseSchema>;
