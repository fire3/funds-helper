import { ParseError } from '../errors.ts';
import type { HttpClient } from '../http.ts';

/**
 * 新浪财经外汇日线（`NewForexService.getDayKLine`）。
 *
 * 上游是 JSONP：外壳 `x("…")`，载荷是**一个字符串**，内部 `|` 分行、`,` 分列，
 * **一次返回全量历史**（USD/CNY 自 1994-08-30 起，实测 8021 行 / 约 320 KB）。
 *
 * 字段序为 `date,open,low,high,close`（注意 low 在 high 之前）——
 * 这不是猜的，是用 2005-07-22 与 2015-08-11 两次汇改的真实数据交叉验证的，
 * 详见 `docs/design/fx-data-sources.md` §3.2。若按直觉的 `open,high,low,close` 解析，
 * 2015-08-11 会得到「最高 6.2856 < 最低 6.3286」这种不可能的组合。
 *
 * 编码为纯 ASCII（数字与日期），因此不需要给 HttpClient 增加 GBK 支持。
 */

export const SINA_FX_DAILY_URL =
  'https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/x/NewForexService.getDayKLine';

/** 在岸美元兑人民币即期汇率 */
export const USD_CNY_SYMBOL = 'fx_susdcny';

export interface RawFxDailyBar {
  date: string;
  open: number | null;
  low: number | null;
  high: number | null;
  close: number;
}

export interface FxDailySeries {
  symbol: string;
  /** 按日期升序，且同日已去重 */
  bars: RawFxDailyBar[];
  /** 被跳过的脏行数（日期非法或没有收盘价） */
  skippedRows: number;
}

/** 结构契约：列数变化才是「上游改版」的信号 */
const FIELD_COUNT = 5;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 解析失败时用于排障的片段（不整体打日志 —— 响应有 320 KB） */
function snippet(text: string, size = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= size * 2) return clean;
  return `${clean.slice(0, size)} … ${clean.slice(-size)}`;
}

/** 剥离 JSONP 外壳，取出 `x("…")` 里的那个字符串字面量 */
function unwrapJsonpString(text: string): string {
  const start = text.indexOf('("');
  const end = text.lastIndexOf('")');
  if (start === -1 || end === -1 || end < start + 2) {
    throw new ParseError('响应结构不符合预期：未找到 JSONP 字符串载荷', { detail: snippet(text) });
  }

  try {
    const value: unknown = JSON.parse(text.slice(start + 1, end + 1));
    if (typeof value !== 'string') throw new Error('载荷不是字符串');
    return value;
  } catch {
    throw new ParseError('JSONP 载荷解析失败', { detail: snippet(text) });
  }
}

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '--' || trimmed === '-') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** 按逗号切列，容忍行尾多余逗号（真实响应里行尾带 `,`） */
function splitFields(row: string): string[] {
  const fields = row.split(',');
  while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
  return fields;
}

/** 行级宽松：只要求日期合法且收盘价为正数，其余列缺失留 null */
function toBar(fields: readonly string[]): RawFxDailyBar | null {
  const date = fields[0];
  if (date === undefined || !DATE_PATTERN.test(date)) return null;

  const close = toNumber(fields[4]);
  if (close === null || close <= 0) return null;

  return {
    date,
    open: toNumber(fields[1]),
    low: toNumber(fields[2]),
    high: toNumber(fields[3]),
    close,
  };
}

export function parseFxDailyKline(text: string, symbol: string = USD_CNY_SYMBOL): FxDailySeries {
  const payload = unwrapJsonpString(text);
  const rows = payload
    .split('|')
    .map((row) => row.trim())
    .filter((row) => row !== '');

  if (rows.length === 0) throw new ParseError('响应中没有任何 K 线数据', { detail: snippet(text) });

  // 结构级严格：用首行判定列数，不符立刻报错
  const first = splitFields(rows[0] ?? '');
  if (first.length !== FIELD_COUNT) {
    throw new ParseError(`列数异常：期望 ${FIELD_COUNT}，实际 ${first.length}（上游可能已改版）`, {
      detail: snippet(rows[0] ?? ''),
    });
  }

  const byDate = new Map<string, RawFxDailyBar>();
  let skippedRows = 0;
  for (const row of rows) {
    const bar = toBar(splitFields(row));
    if (bar === null) {
      skippedRows += 1;
      continue;
    }
    // 同日重复行保留后者
    byDate.set(bar.date, bar);
  }

  const bars = [...byDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  if (bars.length === 0) throw new ParseError('解析后没有任何有效 K 线', { detail: snippet(text) });

  return { symbol, bars, skippedRows };
}

export async function fetchFxDailyKline(
  client: HttpClient,
  symbol: string = USD_CNY_SYMBOL,
): Promise<FxDailySeries> {
  const url = `${SINA_FX_DAILY_URL}?symbol=${encodeURIComponent(symbol)}`;
  const text = await client.getText(url, {
    headers: { Referer: 'https://finance.sina.com.cn/' },
  });
  return parseFxDailyKline(text, symbol);
}
