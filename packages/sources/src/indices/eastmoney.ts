import { snippet } from '../eastmoney/util.ts';
import { ParseError, UpstreamError } from '../errors.ts';
import type { HttpClient, RequestOptions } from '../http.ts';
import type { RawIndexBar } from './yahoo.ts';

/**
 * 东方财富全球指数日线（`push2his` kline）—— 国际指数**备源**。
 *
 * 实测结论（`docs/design/global-index-data-sources.md` §5）：
 * - 全球指数统一在 `market=100`：`secid=100.SPX` / `100.HSI` / `100.N225`…；
 *   覆盖 16/22，**没有**纳指 100 / 罗素 / VIX / 恒生国企 / 恒生科技 / TSX（见注册表）。
 * - 字段序 `f51 日期, f52 开盘, f53 收盘, f54 最高, f55 最低`（请求时显式指定），
 *   验证：2026-09-01 标普 7663.63(高) > 7631.47(收) > 7611.20(低)。
 * - **HTTPS 间歇性连接失败（实测连续 15 次全 000），HTTP(80 端口) 立即稳定** ——
 *   与 `fx-data-sources.md` §1 记录的是同一类问题，因此这里 **http 在前、https 兜底**。
 * - 历史深度：道指 1990-04-25 起 9179 行；收盘价与 Yahoo 逐项一致。
 * - 上游对不存在的 secid 返回 `data: null`（rc=100）——按 UpstreamError 抛。
 */

/**
 * 主备传输端点：HTTP 在前是**有意为之**（HTTPS 抖动是实测事实，不是笔误）。
 * 备注：本项目其它东财接口走 `fetchQuoteText`（https 主 + push2delay 备），
 * 那是行情接口的结论；K 线接口（push2his）的实测结论不同，不混用。
 */
export const GLOBAL_INDEX_KLINE_HOSTS = [
  'http://push2his.eastmoney.com',
  'https://push2his.eastmoney.com',
] as const;

export interface EastmoneyIndexSeries {
  secid: string;
  /** 上游中文名（如「标普500」），缺失为 null */
  name: string | null;
  /** 按日期升序，同日已去重 */
  bars: RawIndexBar[];
  skippedRows: number;
}

/** 结构契约：fields2 固定要 5 列，列数变化 = 上游改版 */
const FIELD_COUNT = 5;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '--' || trimmed === '-') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseGlobalIndexKline(text: string, secid: string): EastmoneyIndexSeries {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('东财 K 线响应不是合法 JSON', { detail: snippet(text) });
  }

  if (!isRecord(payload)) {
    throw new ParseError('东财 K 线响应结构异常', { detail: snippet(text) });
  }

  const data = payload.data;
  if (data === null || data === undefined) {
    // rc=100：secid 不存在或无权限 —— 「上游说没有」，交由调用方决定是否已是最后一站
    throw new UpstreamError(`东财没有该指数的数据（secid=${secid}）`);
  }
  if (!isRecord(data) || !Array.isArray(data.klines)) {
    throw new ParseError('东财 K 线响应缺少 klines 数组', { detail: snippet(text) });
  }

  const rows = data.klines.filter((row): row is string => typeof row === 'string');
  if (rows.length === 0) {
    throw new ParseError('东财 K 线响应没有任何数据行', { detail: snippet(text) });
  }

  // 结构级严格：首行列数不符 = 改版信号，立刻抛
  const first = (rows[0] ?? '').split(',');
  if (first.length !== FIELD_COUNT) {
    throw new ParseError(
      `东财 K 线列数异常：期望 ${FIELD_COUNT}，实际 ${first.length}（上游可能已改版）`,
      { detail: snippet(rows[0] ?? '') },
    );
  }

  const byDate = new Map<string, RawIndexBar>();
  let skippedRows = 0;
  for (const row of rows) {
    const fields = row.split(',');
    const date = fields[0];
    const close = toNumber(fields[2]);
    // 行级宽松：日期非法或缺收盘价的行跳过并计数
    if (date === undefined || !DATE_PATTERN.test(date) || close === null || close <= 0) {
      skippedRows += 1;
      continue;
    }
    byDate.set(date, {
      date,
      open: toNumber(fields[1]),
      low: toNumber(fields[4]),
      high: toNumber(fields[3]),
      close,
    });
  }

  const bars = [...byDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  if (bars.length === 0) {
    throw new ParseError('东财 K 线解析后没有任何有效数据', { detail: snippet(text) });
  }

  const name = typeof data.name === 'string' && data.name !== '' ? data.name : null;
  return { secid, name, bars, skippedRows };
}

export interface EastmoneyFetchOptions {
  /** 只要这个日期之后的 K 线（增量）；不传 = 全量（beg=19000101） */
  since?: string | null;
}

function begFor(since: string | null | undefined): string {
  if (since == null) return '19000101';
  // 注意 Date.parse 返回毫秒：10 天 = 10 * 86_400_000（写成 86_400 只会回溯 14 分钟）
  const timestamp = Date.parse(`${since}T00:00:00Z`) - 10 * 86_400_000;
  return new Date(timestamp).toISOString().slice(0, 10).replaceAll('-', '');
}

export function globalIndexKlineUrl(secid: string, options: EastmoneyFetchOptions = {}): string {
  const params = new URLSearchParams({
    secid,
    klt: '101', // 日 K
    fqt: '0', // 不复权（指数无复权概念）
    beg: begFor(options.since),
    end: '20500101',
    fields1: 'f1,f2,f3',
    fields2: 'f51,f52,f53,f54,f55',
  });
  return `/api/qt/stock/kline/get?${params.toString()}`;
}

/** 依次尝试主备传输端点，全部失败时抛出最后一个错误（沿用 fetchQuoteText 的模式） */
export async function fetchGlobalIndexKline(
  client: HttpClient,
  secid: string,
  options: EastmoneyFetchOptions = {},
  requestOptions: RequestOptions = {},
): Promise<EastmoneyIndexSeries> {
  const path = globalIndexKlineUrl(secid, options);
  let lastError: unknown;
  for (const host of GLOBAL_INDEX_KLINE_HOSTS) {
    try {
      const text = await client.getText(`${host}${path}`, {
        timeoutMs: 30_000,
        ...requestOptions,
        headers: { Referer: 'https://quote.eastmoney.com/', ...requestOptions.headers },
      });
      return parseGlobalIndexKline(text, secid);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new UpstreamError('东财 K 线接口不可用（主备端点均失败）');
}
