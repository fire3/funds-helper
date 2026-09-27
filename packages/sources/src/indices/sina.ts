import { snippet } from '../eastmoney/util.ts';
import { ParseError, UpstreamError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import type { RawIndexBar } from './yahoo.ts';

/**
 * 新浪「环球市场」全球指数日线（`gi.finance.sina.com.cn/hq/daily`）—— 国际指数**第四源**。
 *
 * 线索来自 akshare 的 `index_global_hist_sina`（2026-09-27 实测复核，见
 * `docs/design/global-index-data-sources.md` §14）。三条关键事实：
 *
 * - **数据是新鲜的**，与 Yahoo 逐日一致（2026-09-27 交叉验证：DAX/NKY/UKX 均停在 09-25；
 *   KOSPI 停 09-23、台股停 09-24 是**当地假期** —— 与 Yahoo 同日同值，不是陈旧 feed）。
 *   注意与调研报告 §7.1 弃用的**旧接口** `hq.sinajs.cn/list=int_*` 是两回事：
 *   旧的实时 `int_*` 系列陈旧弃用，这个 `gi` 日线接口是 akshare 新接入的、实测可用。
 * - **覆盖与 Yahoo/东财互补**：欧亚/美洲/大洋洲 18+ 指数，**没有美股与恒指系**
 *   （实测 `INX/DJI/NDX/HSI/HSCE/HSTECH` 均回「not found」）—— 所以注册表里
 *   美/港指数的 `sina` 字段为 null，由腾讯应急源兜底。
 * - **深度上限 1000 行**（`num=10000` 也只回 1000，约 4 年）—— 做不了全量回填，
 *   只做日线增量/应急；全量历史仍靠 Yahoo/东财。
 *
 * 行结构：`{d: '2026-09-25', v: '成交量', c: 收, o: 开, l: 低, h: 高}`（**字符串数值**、
 * 按日期升序）。`v` 对指数常为 0（如日经），忽略。未知符号回
 * `{"code":20001,"message":"…not found…","result":{"data":{}}}` —— 「上游说没有」，
 * 按 UpstreamError 抛，交降级链的下一环。
 */

export const SINA_GLOBAL_DAILY_URL = 'https://gi.finance.sina.com.cn/hq/daily';

/** 上游硬上限：实测 num=10000 也只回 1000 行（约 4 年日线） */
export const SINA_GLOBAL_MAX_BARS = 1000;

export interface SinaGlobalSeries {
  /** 新浪环球市场符号（如 'DAX'/'NKY'，与 Yahoo/东财代码都不同） */
  symbol: string;
  /** 按日期升序，同日已去重（保留后者） */
  bars: RawIndexBar[];
  /** 被跳过的行数（日期非法或收盘价缺失/非正数） */
  skippedRows: number;
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '--' || trimmed === '-') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseSinaGlobalDaily(text: string, symbol: string): SinaGlobalSeries {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('新浪全球指数日线响应不是合法 JSON', { detail: snippet(text) });
  }

  if (!isRecord(payload)) {
    throw new ParseError('新浪全球指数日线响应结构异常', { detail: snippet(text) });
  }

  // code !== 0（实测 20001 = 符号不存在）——「上游说没有」，交降级链下一环
  if (typeof payload.code === 'number' && payload.code !== 0) {
    throw new UpstreamError(
      `新浪没有该指数的数据（symbol=${symbol}, code=${payload.code}）：${String(payload.message ?? '')}`,
    );
  }

  const result = payload.result;
  if (!isRecord(result)) {
    throw new ParseError('新浪全球指数日线响应缺少 result 节点（上游可能已改版）', {
      detail: snippet(text),
    });
  }

  const rows = result.data;
  // code=0 但 data 不是数组 = 上游改版信号（code≠0 的空对象已在上面拦截）
  if (!Array.isArray(rows)) {
    throw new ParseError('新浪全球指数日线响应缺少 data 数组（上游可能已改版）', {
      detail: snippet(text),
    });
  }
  if (rows.length === 0) {
    throw new UpstreamError(`新浪没有该指数的数据（symbol=${symbol}）`);
  }

  const byDate = new Map<string, RawIndexBar>();
  let skippedRows = 0;
  for (const row of rows) {
    if (!isRecord(row)) {
      skippedRows += 1;
      continue;
    }
    const date = typeof row.d === 'string' ? row.d : '';
    const close = toNumber(row.c);
    // 行级宽松：日期非法或缺收盘价的行跳过并计数，不让整批失败
    if (!DATE_PATTERN.test(date) || close === null || close <= 0) {
      skippedRows += 1;
      continue;
    }
    byDate.set(date, {
      date,
      open: toNumber(row.o),
      low: toNumber(row.l),
      high: toNumber(row.h),
      close,
    });
  }

  const bars = [...byDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  if (bars.length === 0) {
    throw new ParseError(`新浪全球指数日线（symbol=${symbol}）解析后没有任何有效日线`, {
      detail: snippet(text),
    });
  }

  return { symbol, bars, skippedRows };
}

export interface SinaGlobalFetchOptions {
  /** 只保留该日期往前 10 天起的日线（与东财 beg 的回看余量同口径）；不传 = 全部 */
  since?: string | null;
  /** 请求行数（上游硬上限 1000，见 SINA_GLOBAL_MAX_BARS） */
  num?: number;
}

export function sinaGlobalDailyUrl(symbol: string, options: SinaGlobalFetchOptions = {}): string {
  const params = new URLSearchParams({
    symbol,
    num: String(options.num ?? SINA_GLOBAL_MAX_BARS),
  });
  return `${SINA_GLOBAL_DAILY_URL}?${params.toString()}`;
}

/** since 语义与东财一致：回看 10 天，容忍上游修订最近几根 K 线 */
function filterSince(bars: RawIndexBar[], since: string | null | undefined): RawIndexBar[] {
  if (since == null) return bars;
  const cutoff = new Date(Date.parse(`${since}T00:00:00Z`) - 10 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return bars.filter((bar) => bar.date >= cutoff);
}

export async function fetchSinaGlobalDaily(
  client: HttpClient,
  symbol: string,
  options: SinaGlobalFetchOptions = {},
): Promise<SinaGlobalSeries> {
  const url = sinaGlobalDailyUrl(symbol, options);
  const text = await client.getText(url, { timeoutMs: 30_000 });
  const series = parseSinaGlobalDaily(text, symbol);
  return { ...series, bars: filterSince(series.bars, options.since) };
}
