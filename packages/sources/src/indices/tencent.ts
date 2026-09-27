import { snippet } from '../eastmoney/util.ts';
import { ParseError, UpstreamError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import type { RawIndexBar } from './yahoo.ts';

/**
 * 腾讯行情全球指数日线（`web.ifzq.gtimg.cn` kline）—— 国际指数**应急源**。
 *
 * 实测结论（`docs/design/global-index-data-sources.md` §6，2026-09-26 复测）：
 * - **覆盖恰好 5 个**：标普 / 纳斯达克综合 / 纳指100 / 道指 / 恒生（注册表 `tencent` 字段）；
 *   其余市场（日经/欧洲/亚太等）实测全部无代码 —— 所以它只做**最后的兜底**，不是备选主源。
 * - **行结构是 JSON 数组**，字段序 `[日期, 开盘, 收盘, 最高, 最低, 成交额]`
 *   —— 收盘在**第 3 列**（第 2 列是开盘），与东财/新浪的直觉顺序都不同；
 *   验证：2026-09-25 恒生收盘 24510.090、道指 51828.620、标普 7743.410，与快照逐分一致。
 * - **响应 key 会归一化**：参数 `usDJI` → `data["us.DJI"]`、`usINX` → `data["us.INX"]`，
 *   只有 `hkHSI` 与参数同名 —— 解析器必须取 `data` 的第一个 key，不能用参数拼。
 * - `count` 可要到 1600 行（约 6.5 年）；`99999` 这类非法 count 回
 *   `{"msg":"param error","data":[]}` —— 形态异常按 ParseError。
 * - 错误符号回 `day: []`（不是报错）——按 UpstreamError 抛，交由上层决定降级。
 */

export const TENCENT_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline';

/** 全量回填时请求的行数上限（实测 1600 可用；腾讯没有更深历史，作为应急源可接受） */
export const TENCENT_MAX_BARS = 1600;
/** 增量抓取（since 模式）只要最近若干行 */
export const TENCENT_INCREMENTAL_BARS = 40;

export interface TencentIndexSeries {
  /** 请求的标的代码（如 'usDJI'） */
  code: string;
  /** 按日期升序，同日已去重 */
  bars: RawIndexBar[];
  skippedRows: number;
}

function toNumber(raw: unknown): number | null {
  // 腾讯的行元素是**字符串**（"24510.090"），不是数字 —— 与东财 util.num 同口径处理
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '--') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseTencentKline(text: string, code: string): TencentIndexSeries {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('腾讯 K 线响应不是合法 JSON', { detail: snippet(text) });
  }

  if (!isRecord(payload)) {
    throw new ParseError('腾讯 K 线响应结构异常', { detail: snippet(text) });
  }
  const data = payload.data;
  // data: [] （如 count 参数非法，实测 msg='param error'）—— 响应形态不符，属改版/参数契约信号
  if (data === null || data === undefined || Array.isArray(data)) {
    throw new ParseError('腾讯 K 线响应缺少 data 对象', {
      detail: snippet(`${payload.msg ?? ''} ${text}`),
    });
  }

  // 响应 key 会归一化（usDJI → us.DJI）：每次请求只有一个标的，取第一个 entry 即可
  const entry = Object.values(data)[0];
  if (!isRecord(entry) || !Array.isArray(entry.day)) {
    throw new ParseError('腾讯 K 线响应缺少 day 数组', { detail: snippet(text) });
  }

  const rows = entry.day;
  // 错误符号回 day: []（不是报错）——「上游说没有」，交上层降级
  if (rows.length === 0) {
    throw new UpstreamError(`腾讯没有该指数的数据（code=${code}）`);
  }

  // 结构级严格：首行元素数不符 = 上游改版信号
  const first = rows[0];
  if (!Array.isArray(first) || first.length !== 6) {
    throw new ParseError(
      `腾讯 K 线列数异常：期望 6，实际 ${Array.isArray(first) ? first.length : '非数组'}（上游可能已改版）`,
      { detail: snippet(JSON.stringify(first)) },
    );
  }

  const byDate = new Map<string, RawIndexBar>();
  let skippedRows = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) {
      skippedRows += 1;
      continue;
    }
    const date = row[0];
    const close = toNumber(row[2]);
    // 行级宽松：日期非法或缺收盘价的行跳过并计数
    if (typeof date !== 'string' || !DATE_PATTERN.test(date) || close === null || close <= 0) {
      skippedRows += 1;
      continue;
    }
    byDate.set(date, {
      date,
      open: toNumber(row[1]),
      low: toNumber(row[4]),
      high: toNumber(row[3]),
      close,
    });
  }

  const bars = [...byDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  if (bars.length === 0) {
    throw new ParseError('腾讯 K 线解析后没有任何有效数据', { detail: snippet(text) });
  }

  return { code, bars, skippedRows };
}

export interface TencentFetchOptions {
  /** 只要最近 N 行（增量抓取）；不传 = 请求全量上限 */
  count?: number;
}

export function tencentKlineUrl(code: string, options: TencentFetchOptions = {}): string {
  const count = options.count ?? TENCENT_MAX_BARS;
  const params = new URLSearchParams({ param: `${code},day,,,${count}` });
  return `${TENCENT_KLINE_URL}?${params.toString()}`;
}

export async function fetchTencentDailyBars(
  client: HttpClient,
  code: string,
  options: TencentFetchOptions = {},
): Promise<TencentIndexSeries> {
  const url = tencentKlineUrl(code, options);
  const text = await client.getText(url, { timeoutMs: 20_000 });
  return parseTencentKline(text, code);
}
