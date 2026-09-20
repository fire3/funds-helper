import {
  FX_DIRECTIONS,
  FX_INTERVAL_DAYS,
  FX_INTERVAL_KEYS,
  FX_INTERVAL_LABELS,
  FX_RANGE_DAYS,
  type FxBar,
  type FxDirection,
  type FxExtreme,
  type FxIntervalKey,
  type FxRangeKey,
} from './model.ts';

const MS_PER_DAY = 86_400_000;
/** 一年约 252 个交易日，用于把日波动换算成年化 */
const TRADING_DAYS_PER_YEAR = 252;

/** 日期加减（按 UTC 计算，避免本地时区把日期挪一天） */
export function shiftDate(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return new Date(timestamp + days * MS_PER_DAY).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 方向换算
// ---------------------------------------------------------------------------

/** 单值方向换算：`CNY/USD` 即取倒数 */
export function convertRate(rate: number, direction: FxDirection): number {
  return direction === FX_DIRECTIONS.UsdCny ? rate : 1 / rate;
}

/**
 * 整根 K 线的方向换算。
 *
 * 取倒数会**反转高低**：反向后的最低价是 `1 / 原最高价`。
 * 漏掉这一步，`CNY/USD` 走势图的高低带会整体错位 —— 是错的，不是精度问题。
 */
export function convertBar(bar: FxBar, direction: FxDirection): FxBar {
  if (direction === FX_DIRECTIONS.UsdCny) return bar;
  return {
    date: bar.date,
    open: bar.open === null ? null : 1 / bar.open,
    low: bar.high === null ? null : 1 / bar.high,
    high: bar.low === null ? null : 1 / bar.low,
    close: 1 / bar.close,
  };
}

// ---------------------------------------------------------------------------
// 区间裁剪与抽稀
// ---------------------------------------------------------------------------

/**
 * 展示区间裁剪。锚定**最后一根 K 线**而不是当前时间：
 * 周末与节假日请求同一链接应得到相同结果（可缓存、可测试、可分享）。
 */
export function sliceRange(bars: readonly FxBar[], range: FxRangeKey): FxBar[] {
  const last = bars.at(-1);
  if (last === undefined) return [];
  if (range === 'all') return [...bars];

  const from = shiftDate(last.date, -FX_RANGE_DAYS[range]);
  return bars.filter((bar) => bar.date >= from);
}

/** 等距抽稀，保留首尾（只用于展示，极值仍取自全量序列） */
export function downsample(bars: readonly FxBar[], maxPoints: number): FxBar[] {
  if (maxPoints < 2 || bars.length <= maxPoints) return [...bars];

  const step = Math.ceil(bars.length / maxPoints);
  const sampled: FxBar[] = [];
  for (let index = 0; index < bars.length; index += step) {
    const bar = bars[index];
    if (bar !== undefined) sampled.push(bar);
  }

  const last = bars.at(-1);
  if (last !== undefined && sampled.at(-1)?.date !== last.date) sampled.push(last);
  return sampled;
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

export interface FxIntervalChange {
  key: FxIntervalKey;
  label: string;
  from: string | null;
  to: string;
  startRate: number | null;
  endRate: number;
  change: number | null;
  changePct: number | null;
}

function windowStart(lastDate: string, key: FxIntervalKey): string | null {
  if (key === 'all') return null;
  if (key === 'ytd') return `${lastDate.slice(0, 4)}-01-01`;
  return shiftDate(lastDate, -FX_INTERVAL_DAYS[key]);
}

/**
 * 区间涨跌。**始终返回全部区间**（数据不足时字段为 null），
 * 让界面稳定渲染整张表，而不是随数据长度增减行。
 */
export function intervalChanges(bars: readonly FxBar[]): FxIntervalChange[] {
  const last = bars.at(-1);
  if (last === undefined) return [];

  const result: FxIntervalChange[] = [];
  for (const key of FX_INTERVAL_KEYS) {
    const label = FX_INTERVAL_LABELS[key];
    const from = windowStart(last.date, key);
    const first = from === null ? bars[0] : bars.find((bar) => bar.date >= from);

    if (first === undefined || first.date === last.date) {
      result.push({
        key,
        label,
        from: null,
        to: last.date,
        startRate: null,
        endRate: last.close,
        change: null,
        changePct: null,
      });
      continue;
    }

    const change = last.close - first.close;
    result.push({
      key,
      label,
      from: first.date,
      to: last.date,
      startRate: first.close,
      endRate: last.close,
      change,
      changePct: first.close === 0 ? null : (change / first.close) * 100,
    });
  }
  return result;
}

export interface FxYearStat {
  year: string;
  /** 年初（该年首个交易日收盘） */
  open: number;
  /** 年末（该年最后一个交易日收盘） */
  close: number;
  low: number;
  high: number;
  /** 年内日均（收盘均值） */
  avg: number;
  changePct: number | null;
}

/** 年度统计。年初/年末取收盘价，最高/最低取日内价（缺失时回退收盘价） */
export function yearlyStats(bars: readonly FxBar[]): FxYearStat[] {
  const buckets = new Map<string, FxBar[]>();
  for (const bar of bars) {
    const year = bar.date.slice(0, 4);
    const list = buckets.get(year);
    if (list) list.push(bar);
    else buckets.set(year, [bar]);
  }

  const stats: FxYearStat[] = [];
  for (const [year, list] of buckets) {
    const first = list[0];
    const last = list.at(-1);
    if (first === undefined || last === undefined) continue;

    const closes = list.map((bar) => bar.close);
    const change = last.close - first.close;
    stats.push({
      year,
      open: first.close,
      close: last.close,
      low: Math.min(...list.map((bar) => bar.low ?? bar.close)),
      high: Math.max(...list.map((bar) => bar.high ?? bar.close)),
      avg: closes.reduce((sum, value) => sum + value, 0) / closes.length,
      changePct: first.close === 0 ? null : (change / first.close) * 100,
    });
  }

  return stats.sort((a, b) => (a.year < b.year ? -1 : 1));
}

export interface FxExtremes {
  high: FxExtreme | null;
  low: FxExtreme | null;
}

/** 极值按**收盘价**取，与走势图口径一致 */
export function extremes(bars: readonly FxBar[]): FxExtremes {
  let high: FxExtreme | null = null;
  let low: FxExtreme | null = null;

  for (const bar of bars) {
    if (high === null || bar.close > high.rate) high = { date: bar.date, rate: bar.close };
    if (low === null || bar.close < low.rate) low = { date: bar.date, rate: bar.close };
  }
  return { high, low };
}

export interface FxDayChange {
  latest: FxExtreme;
  previous: FxExtreme;
  change: number;
  changePct: number | null;
}

/** 最新一根较上一交易日的变动 */
export function dayChange(bars: readonly FxBar[]): FxDayChange | null {
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  if (latest === undefined || previous === undefined) return null;

  const change = latest.close - previous.close;
  return {
    latest: { date: latest.date, rate: latest.close },
    previous: { date: previous.date, rate: previous.close },
    change,
    changePct: previous.close === 0 ? null : (change / previous.close) * 100,
  };
}

/**
 * 年化波动率：近 `windowDays` 个自然日内日对数收益标准差 × √252，单位为百分比。
 *
 * 汇率没有周末与节假日报价，因此按「实际有报价的交易日」计数 ——
 * 用自然日数去除会系统性低估波动。
 */
export function annualizedVolatility(bars: readonly FxBar[], windowDays = 365): number | null {
  const last = bars.at(-1);
  if (last === undefined) return null;

  const from = shiftDate(last.date, -windowDays);
  const window = bars.filter((bar) => bar.date >= from);

  const returns: number[] = [];
  for (let index = 1; index < window.length; index += 1) {
    const current = window[index];
    const previous = window[index - 1];
    if (current === undefined || previous === undefined) continue;
    if (current.close <= 0 || previous.close <= 0) continue;
    returns.push(Math.log(current.close / previous.close));
  }
  if (returns.length < 20) return null;

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}
