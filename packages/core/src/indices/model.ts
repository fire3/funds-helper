/**
 * 国际行情工具（`indices`）的领域模型。
 *
 * 本工具的核心是「一组指数 × 各自一条日线序列」，因此模型围绕
 * 「地区分组」「展示区间」「统计区间」展开。
 *
 * 区间与统计函数**直接复用 fx 的实现**（`core/fx/series.ts`，本质是通用日线统计）：
 * `INDEX_RANGE_KEYS` / `INDEX_INTERVAL_KEYS` 的字面量取值必须与 `FX_*` 完全一致 ——
 * 服务端会把本模块的 key 直接传给 fx 函数，类型不同则**编译失败**，这是零成本护栏。
 */

/** 地区分组：展示顺序即数组顺序 */
export const INDEX_REGION_KEYS = ['us', 'hk', 'apac', 'europe', 'americas'] as const;
export type IndexRegionKey = (typeof INDEX_REGION_KEYS)[number];

export const INDEX_REGION_LABELS: Record<IndexRegionKey, string> = {
  us: '美国',
  hk: '中国香港',
  apac: '亚太',
  europe: '欧洲',
  americas: '美洲',
};

/** 展示区间（相对最后一个交易日回看，与 fx 同语义） */
export const INDEX_RANGE_KEYS = ['1y', '3y', '5y', '10y', 'all'] as const;
export type IndexRangeKey = (typeof INDEX_RANGE_KEYS)[number];

export const INDEX_RANGE_LABELS: Record<IndexRangeKey, string> = {
  '1y': '近1年',
  '3y': '近3年',
  '5y': '近5年',
  '10y': '近10年',
  all: '全部',
};

/** 「主要指数现在多少、怎么走」默认看近 5 年 */
export const INDEX_DEFAULT_RANGE: IndexRangeKey = '5y';

/** 统计区间（区间涨跌表），与 fx 同取值 */
export const INDEX_INTERVAL_KEYS = ['1m', '3m', '6m', '1y', '3y', '5y', 'ytd', 'all'] as const;
export type IndexIntervalKey = (typeof INDEX_INTERVAL_KEYS)[number];

export const INDEX_INTERVAL_LABELS: Record<IndexIntervalKey, string> = {
  '1m': '近1月',
  '3m': '近3月',
  '6m': '近6月',
  '1y': '近1年',
  '3y': '近3年',
  '5y': '近5年',
  ytd: '年初至今',
  all: '全部',
};

/**
 * 走势图最多下发多少点。
 * 单指数全历史约 1.4 万根日线（标普自 1970），全量下发会让响应膨胀到数百 KB。
 */
export const INDEX_MAX_CHART_POINTS = 1600;

/** 默认展示的指数：标普 500 是「美股怎么样了」的第一问 */
export const INDEX_DEFAULT_CODE = 'SPX';

/**
 * 一根日线 —— 结构与 `FxBar` 完全相同，
 * 服务端因此可以把 `IndexBar[]` 直接传给 fx 的序列统计函数。
 */
export interface IndexBar {
  date: string;
  open: number | null;
  low: number | null;
  high: number | null;
  close: number;
}

/** 跨源新鲜度护栏：同日收盘价偏差超过该比例即告警（数据源疑似陈旧，见调研报告 §7.1） */
export const INDEX_CROSS_SOURCE_DRIFT = 0.005;
