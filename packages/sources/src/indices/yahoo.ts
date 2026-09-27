import { ParseError, UpstreamError } from '../errors.ts';
import { type HttpClient, sleep } from '../http.ts';

/**
 * Yahoo Finance `chart` v8 接口（国际指数主源）。
 *
 * 实测结论（`docs/design/global-index-data-sources.md` §4）：
 * - 无需 cookie/crumb（`v7/finance/download` 已要 crumb，实测 401，不要用）；
 * - 全量日线要走 `period1=0&period2=now&interval=1d` ——
 *   **`range=max&interval=1d` 会被上游降级成月线**（实测只回 169 行月 K）；
 * - 日线时间戳是**交易所开盘时刻**（如纽约 13:30/14:30 UTC = 当地 9:30），
 *   日期必须按 `meta.exchangeTimezoneName` 换算，用 UTC 裁剪在夏令时切换附近会错一天；
 * - 响应里 `chart.error` 非 null（如符号不存在）时 `result` 为 null ——
 *   这是「上游说没有」，按 UpstreamError 抛，让备源（东财）接管；
 * - 22 个指数全量回填约 1.5 MB/个，单响应远低于 16 MB 上限。
 */

export const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

export interface RawIndexBar {
  date: string;
  open: number | null;
  low: number | null;
  high: number | null;
  close: number;
}

export interface YahooChartSeries {
  /** 上游符号原样回传，便于排障 */
  symbol: string;
  /** 原生计价币种（meta.currency），缺失为 null */
  currency: string | null;
  /** 交易所时区（IANA，meta.exchangeTimezoneName），缺失为 null */
  timeZone: string | null;
  /** 按日期升序，同日已去重（保留后者） */
  bars: RawIndexBar[];
  /** 被跳过的行数（close 缺失或非正数） */
  skippedRows: number;
}

/** 按交易所时区把时间戳换算成 YYYY-MM-DD；formatter 按时区缓存（构造成本高） */
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = dateFormatterCache.get(timeZone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatterCache.set(timeZone, formatter);
    return formatter;
  } catch {
    // 时区名非法（上游改了值）：不缓存，调用方回退 UTC
    return null;
  }
}

function barDate(timestamp: number, timeZone: string | null): string {
  const formatter = timeZone === null ? null : dateFormatter(timeZone);
  if (formatter) return formatter.format(new Date(timestamp * 1000));
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function toNumber(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw;
}

function snippet(text: string, size = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= size * 2) return clean;
  return `${clean.slice(0, size)} … ${clean.slice(-size)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseYahooChart(text: string): YahooChartSeries {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('Yahoo 响应不是合法 JSON', { detail: snippet(text) });
  }

  if (!isRecord(payload) || !isRecord(payload.chart)) {
    throw new ParseError('Yahoo 响应缺少 chart 节点（上游可能已改版）', { detail: snippet(text) });
  }

  // chart.error 非 null（符号不存在等）——「上游说没有」，属网络层语义，交给备源
  const error = payload.chart.error;
  if (error !== null && error !== undefined) {
    const description = isRecord(error)
      ? (error.description ?? error.code ?? '未知错误')
      : String(error);
    throw new UpstreamError(`Yahoo 指数接口返回错误：${String(description)}`);
  }

  const result = payload.chart.result;
  if (!Array.isArray(result) || !isRecord(result[0])) {
    throw new ParseError('Yahoo 响应缺少 result（上游可能已改版）', { detail: snippet(text) });
  }
  const root = result[0];

  const meta = root.meta;
  const symbol = isRecord(meta) && typeof meta.symbol === 'string' ? meta.symbol : '';
  const currency = isRecord(meta) && typeof meta.currency === 'string' ? meta.currency : null;
  const timeZone =
    isRecord(meta) && typeof meta.exchangeTimezoneName === 'string'
      ? meta.exchangeTimezoneName
      : null;

  const timestamps = root.timestamp;
  if (!Array.isArray(timestamps) || timestamps.length === 0) {
    throw new ParseError('Yahoo 响应没有时间戳序列（上游可能已改版）', { detail: snippet(text) });
  }

  const indicators = root.indicators;
  const quote =
    isRecord(indicators) && Array.isArray(indicators.quote) ? indicators.quote[0] : null;
  if (!isRecord(quote) || !Array.isArray(quote.close)) {
    throw new ParseError('Yahoo 响应缺少 indicators.quote 序列', { detail: snippet(text) });
  }

  const closes = quote.close;
  const opens = Array.isArray(quote.open) ? quote.open : [];
  const highs = Array.isArray(quote.high) ? quote.high : [];
  const lows = Array.isArray(quote.low) ? quote.low : [];

  // 结构级严格：数组长度不齐才是「上游改版」的信号
  if (closes.length !== timestamps.length) {
    throw new ParseError(
      `Yahoo 序列长度不一致：timestamps=${timestamps.length} close=${closes.length}`,
      { detail: snippet(text) },
    );
  }

  const byDate = new Map<string, RawIndexBar>();
  let skippedRows = 0;
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    const close = toNumber(closes[index]);
    // 行级宽松：缺 close（停牌/未成交）或非正数的行跳过并计数，不让整批失败
    if (typeof timestamp !== 'number' || close === null || close <= 0) {
      skippedRows += 1;
      continue;
    }
    const date = barDate(timestamp, timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      skippedRows += 1;
      continue;
    }
    // 同日重复行（最后一天常带盘中快照）保留后者
    byDate.set(date, {
      date,
      open: toNumber(opens[index]),
      low: toNumber(lows[index]),
      high: toNumber(highs[index]),
      close,
    });
  }

  const bars = [...byDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  if (bars.length === 0) {
    throw new ParseError('Yahoo 响应解析后没有任何有效日线', { detail: snippet(text) });
  }

  return { symbol, currency, timeZone, bars, skippedRows };
}

export interface YahooFetchOptions {
  /** 只要这个日期之后的 K 线（增量抓取）；不传 = 全量回填 */
  since?: string | null;
  /** 注入当前时间（测试） */
  now?: number;
}

/**
 * 拼接 `period1/period2`。
 * `since` 往前多留 `backfillDays` 天：上游偶尔修订最近几根 K 线，多拉几天即自愈。
 */
export function yahooChartUrl(symbol: string, options: YahooFetchOptions = {}): string {
  const now = options.now ?? Date.now();
  const period2 = Math.floor(now / 1000) + 86_400; // 覆盖到明天，避免时区边界少一天
  const period1 =
    options.since == null
      ? 0 // 全量：实测 ^GSPC 自 1970-01-02 起 14305 行
      : Math.max(0, Math.floor(Date.parse(`${options.since}T00:00:00Z`) / 1000) - 10 * 86_400);
  const params = new URLSearchParams({
    period1: String(period1),
    period2: String(period2),
    interval: '1d',
  });
  return `${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?${params.toString()}`;
}

/**
 * 429 冷却窗口（模块级，本源全部请求共用）。
 *
 * 实测（2026-09-26）：Yahoo 的 429 是**短窗口限流** —— 同一时刻小请求还能 200、
 * 连发几轮后全部 429，几分钟后自解。策略（先探后放，避免链式拖慢）：
 * 1. 冷却窗口**外**的首个请求吃到 429 → 退避 20~30s 重试一次（报告 §4.4 的「指数退避」）；
 * 2. 重试成功 → 清除窗口，一切照旧；重试仍 429 → **延长窗口，后续请求在窗口内直接快速失败** ——
 *    否则 captureAll 的 28 个指数会在每个冷却过期点各付一次 25s，链式拖到数分钟；
 * 3. 窗口过期后下个请求再次充当探针。
 * 全局 HttpClient 仍保持「4xx 不重试」的克制默认，这里是上游特有的事实，收在适配层。
 */
let yahooCooldownUntil = 0;

/** 仅测试用：重置模块级冷却状态（否则测试间互相污染） */
export function resetYahooRateLimitState(): void {
  yahooCooldownUntil = 0;
}

function isRateLimited(error: unknown): error is UpstreamError {
  return error instanceof UpstreamError && error.status === 429;
}

async function getTextWithRateLimitRetry(
  client: HttpClient,
  url: string,
  options: { rateLimitBackoffMs?: number } = {},
): Promise<string> {
  // 窗口内：别的请求已经探过路了，直接快速失败（错误信息要能看出是限流冷却）
  if (Date.now() < yahooCooldownUntil) {
    throw new UpstreamError('Yahoo 处于 429 限流冷却窗口，本次跳过（稍后任务会自动重试）', {
      status: 429,
    });
  }

  try {
    return await client.getText(url, { timeoutMs: 60_000 });
  } catch (error) {
    if (!isRateLimited(error)) throw error;

    const backoff = options.rateLimitBackoffMs ?? 20_000 + Math.random() * 10_000;
    yahooCooldownUntil = Date.now() + backoff;
    await sleep(backoff);

    try {
      const text = await client.getText(url, { timeoutMs: 60_000 });
      yahooCooldownUntil = 0; // 探测成功：限流已解除
      return text;
    } catch (retryError) {
      // 仍 429 → 延长窗口，让后续请求在窗口内快速失败，而不是排队撞墙
      if (isRateLimited(retryError)) yahooCooldownUntil = Date.now() + backoff;
      throw retryError;
    }
  }
}

export async function fetchYahooDailyBars(
  client: HttpClient,
  symbol: string,
  options: YahooFetchOptions & { rateLimitBackoffMs?: number } = {},
): Promise<YahooChartSeries> {
  const url = yahooChartUrl(symbol, options);
  // User-Agent 由 HttpClient 默认携带（裸 UA 实测会吃 429）
  const text = await getTextWithRateLimitRetry(client, url, options);
  return parseYahooChart(text);
}
