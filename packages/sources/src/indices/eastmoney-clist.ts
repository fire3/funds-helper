import { num, record, snippet, str } from '../eastmoney/util.ts';
import { ParseError, UpstreamError } from '../errors.ts';
import type { HttpClient, RequestOptions } from '../http.ts';

/**
 * 东财全球指数**批量实时**（`push2` clist）—— 概览的**缺失兜底**与批量报价。
 *
 * 线索来自 akshare 的 `index_global_spot_em`（2026-09-27 实测复核，见
 * `docs/design/global-index-data-sources.md` §14）。三个关键事实：
 *
 * - **`fs` 必须用显式 `i:100.<代码>` 清单**（akshare 的写法）：调研报告 §5.2 试的是
 *   `fs=m:100+t:*` 通配组合、结论「clist 全部为空」—— 换成显式清单后单请求即回
 *   **50 个指数**（2026-09-27 实测），一次拿到最新/今开/最高/最低/昨收/涨跌幅。
 * - **HTTP 在前、HTTPS 兜底**：与 push2his 同样的传输抖动（实测 https 直连 000）。
 * - **`fltt=2` 数值不再需要 ÷100**（akshare 用 fltt=1 再手动除 100，两种口径等价；
 *   本项目与 `ulist.np` 既有实现保持一致，用 fltt=2 直读）。
 *
 * 语义定位：**只做概览的「缺失补齐」**（某个指数日线全链路失败/从未入库时，
 * 概览仍能显示它的最新报价），不写日线表 —— 实时值不是收盘价，落库会污染序列统计。
 * 未知代码整批被拒（实测 `rc:102, data:null`），按 UpstreamError 抛（best-effort 场景由调用方吞掉）。
 */

/**
 * 主备传输端点：HTTP 在前是**有意为之**（push2 的 https 抖动与 push2his 同类，实测 000）。
 */
export const GLOBAL_CLIST_HOSTS = [
  'http://push2.eastmoney.com',
  'https://push2.eastmoney.com',
] as const;

export interface EastmoneyLiveQuote {
  /** 完整 secid，如 '100.SPX' —— 与注册表 `em` 字段直接对表 */
  secid: string;
  /** 上游中文名（如「标普500」），缺失为 null */
  name: string | null;
  /** 最新价（fltt=2 直读，无需 ÷100） */
  price: number;
  open: number | null;
  high: number | null;
  low: number | null;
  /** 昨收 */
  prevClose: number | null;
  /** 涨跌额（上游 f4） */
  change: number | null;
  /** 涨跌幅 %（上游 f3，相对昨收） */
  changePct: number | null;
  /** 上游行情时间戳（秒）；实测收盘后仍会跳动（feed 心跳），**不可当交易日期用** */
  quoteTime: number | null;
}

export interface EastmoneyClistResult {
  quotes: EastmoneyLiveQuote[];
  /** 请求了但上游没回的 secid 数量（东财也缺部分指数，属正常） */
  missing: number;
  skippedRows: number;
}

/**
 * 拼 clist 请求 URL。`secids` 是注册表里的东财代码（'100.SPX' 形式），
 * `fs` 用 `i:` 前缀显式列出 —— 这是 akshare 实测可用、通配组合不可用的写法。
 */
export function globalClistUrl(secids: readonly string[]): string {
  const params = new URLSearchParams({
    np: '2',
    fltt: '2',
    invt: '2',
    fs: secids.map((secid) => `i:${secid}`).join(','),
    fields: 'f12,f13,f14,f2,f3,f4,f15,f16,f17,f18,f7,f124',
    fid: 'f3',
    pn: '1',
    pz: '200', // 注册表 28 个指数，200 留足余量
    po: '1',
    dect: '1',
  });
  return `/api/qt/clist/get?${params.toString()}`;
}

export function parseGlobalClist(text: string, requested: number): EastmoneyClistResult {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('东财批量实时响应不是合法 JSON', { detail: snippet(text) });
  }

  const root = record(payload);
  if (root === null) {
    throw new ParseError('东财批量实时响应结构异常', { detail: snippet(text) });
  }

  const data = record(root.data);
  // rc≠0 或 data=null（实测全部代码非法时 rc:102）——「上游说没有/被拒」，交调用方兜底
  if (root.rc !== 0 || data === null || data === undefined) {
    throw new UpstreamError(`东财批量实时被拒（rc=${String(root.rc)}）`);
  }

  const diff = data.diff;
  let rows: unknown[];
  if (Array.isArray(diff)) rows = diff;
  else if (record(diff) !== null) rows = Object.values(diff as Record<string, unknown>);
  else rows = [];

  // 结构级严格：total>0 却没有 diff 行 = 上游改版信号
  const total = num(data.total);
  if (rows.length === 0) {
    if (total !== null && total > 0) {
      throw new ParseError('东财批量实时响应有 total 但没有数据行（上游可能已改版）', {
        detail: snippet(text),
      });
    }
    throw new UpstreamError(`东财批量实时没有返回任何指数（requested=${requested}）`);
  }

  const quotes: EastmoneyLiveQuote[] = [];
  let skippedRows = 0;
  for (const row of rows) {
    const item = record(row);
    const code = item === null ? null : str(item.f12);
    const market = item === null ? null : num(item.f13);
    const price = item === null ? null : num(item.f2);
    // 行级宽松：缺代码/市场/最新价（停牌位 '-'）的行跳过并计数
    if (code === null || market === null || price === null || price <= 0) {
      skippedRows += 1;
      continue;
    }
    quotes.push({
      secid: `${Math.trunc(market)}.${code}`,
      name: item === null ? null : str(item.f14),
      price,
      open: item === null ? null : num(item.f17),
      high: item === null ? null : num(item.f15),
      low: item === null ? null : num(item.f16),
      prevClose: item === null ? null : num(item.f18),
      change: item === null ? null : num(item.f4),
      changePct: item === null ? null : num(item.f3),
      quoteTime:
        item === null
          ? null
          : num(item.f124) === null
            ? null
            : Math.trunc(num(item.f124) as number),
    });
  }

  return { quotes, missing: Math.max(0, requested - quotes.length), skippedRows };
}

/** 依次尝试主备传输端点，全部失败时抛出最后一个错误（沿用 fetchGlobalIndexKline 的模式） */
export async function fetchGlobalClist(
  client: HttpClient,
  secids: readonly string[],
  requestOptions: RequestOptions = {},
): Promise<EastmoneyClistResult> {
  if (secids.length === 0) return { quotes: [], missing: 0, skippedRows: 0 };
  const path = globalClistUrl(secids);
  let lastError: unknown;
  for (const host of GLOBAL_CLIST_HOSTS) {
    try {
      const text = await client.getText(`${host}${path}`, {
        timeoutMs: 15_000,
        ...requestOptions,
        headers: { Referer: 'https://quote.eastmoney.com/', ...requestOptions.headers },
      });
      return parseGlobalClist(text, secids.length);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new UpstreamError('东财批量实时接口不可用（主备端点均失败）');
}
