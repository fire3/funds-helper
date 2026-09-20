/**
 * 汇率工具（`fx`）的领域模型。
 *
 * 与其它工具不同，本工具的核心是**一条时间序列**，因此模型围绕
 * 「报价方向」「展示区间」「统计区间」这三个维度展开。
 */

/**
 * 报价方向。
 * - `USD/CNY` = 1 美元兑多少人民币（国内习惯报价，数值约 7.1）
 * - `CNY/USD` = 1 人民币兑多少美元（数值约 0.14）
 */
export const FX_DIRECTIONS = {
  UsdCny: 'USD/CNY',
  CnyUsd: 'CNY/USD',
} as const;
export type FxDirection = (typeof FX_DIRECTIONS)[keyof typeof FX_DIRECTIONS];

export const FX_DIRECTION_LABELS: Record<FxDirection, string> = {
  'USD/CNY': '美元兑人民币',
  'CNY/USD': '人民币兑美元',
};

/** 展示区间：相对**最后一个交易日**回看，而不是相对「今天」 */
export const FX_RANGE_KEYS = ['1y', '3y', '5y', '10y', 'all'] as const;
export type FxRangeKey = (typeof FX_RANGE_KEYS)[number];

export const FX_RANGE_LABELS: Record<FxRangeKey, string> = {
  '1y': '近1年',
  '3y': '近3年',
  '5y': '近5年',
  '10y': '近10年',
  all: '全部',
};

/** 各展示区间的自然日跨度（5/10 年按含闰年计） */
export const FX_RANGE_DAYS: Record<Exclude<FxRangeKey, 'all'>, number> = {
  '1y': 365,
  '3y': 1095,
  '5y': 1826,
  '10y': 3653,
};

/** 「美元兑人民币现在多少」是主问题，默认看近 5 年 */
export const FX_DEFAULT_RANGE: FxRangeKey = '5y';

/** 统计区间（区间涨跌表） */
export const FX_INTERVAL_KEYS = ['1m', '3m', '6m', '1y', '3y', '5y', 'ytd', 'all'] as const;
export type FxIntervalKey = (typeof FX_INTERVAL_KEYS)[number];

export const FX_INTERVAL_LABELS: Record<FxIntervalKey, string> = {
  '1m': '近1月',
  '3m': '近3月',
  '6m': '近6月',
  '1y': '近1年',
  '3y': '近3年',
  '5y': '近5年',
  ytd: '年初至今',
  all: '全部',
};

export const FX_INTERVAL_DAYS: Record<Exclude<FxIntervalKey, 'ytd' | 'all'>, number> = {
  '1m': 30,
  '3m': 91,
  '6m': 182,
  '1y': 365,
  '3y': 1095,
  '5y': 1826,
};

/**
 * 走势图最多下发多少点。
 * 32 年日线约 8000 点：全量下发让响应膨胀到数百 KB，而图表上看不出差别。
 * 极值与统计**始终基于全量序列**，抽稀只影响图。
 */
export const FX_MAX_CHART_POINTS = 1600;

/** 一根日线。早期（1994–2005）固定汇率时期四列相同 */
export interface FxBar {
  date: string;
  open: number | null;
  low: number | null;
  high: number | null;
  close: number;
}

/** 单日极值点（用于「历史最高 / 最低」） */
export interface FxExtreme {
  date: string;
  rate: number;
}
