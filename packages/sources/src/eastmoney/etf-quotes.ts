import { ParseError } from '../errors.ts';
import type { EtfSpotItem } from '../etf/spot.ts';
import type { HttpClient } from '../http.ts';
import { ETF_SPOT_FIELDS, spotItemFromRow } from './etf-spot.ts';
import { fetchQuoteText } from './quote.ts';
import { array, num, record, snippet } from './util.ts';

/**
 * 接口 A′：按 secid **批量报价**取全市场 ETF 行情（`ulist.np/get`）。
 *
 * 为什么不是 `clist`（`etf-spot.ts`）：2026-09-22 实测，东财把 `clist` **按接口**重置了 ——
 * 主域名、`push2delay` 与 `1/7/21.push2` 全部 `other side closed`，而**同一批域名**上的
 * `ulist.np/get` 完全正常（见 `docs/design/etf-data-sources.md` §7.4）。
 * 传同一串 `fields=` 时两个接口返回**同一套字段**（含 `f402` 折溢价 / `f26` 上市日 /
 * `f124` 行情时间戳），所以行映射直接复用 `spotItemFromRow`。
 *
 * 代价：它**不提供代码池**（按 secids 查），调用方必须先有代码 ——
 * 本工具用「目录接口 B」的代码池（实测 1675 个代码全部命中报价）。
 */

/** 批量上限实测 **100** 只/请求（传 200/300 只仍只回 100 行） */
export const ETF_QUOTE_BATCH_SIZE = 100;

/**
 * 覆盖率下限：命中的行数低于请求代码数的这个比例时**宁可报错**。
 *
 * 目录里有代码而在行情里没有报价，通常是「已退市/从未上市」（个别代码，正常）；
 * 但如果大面积落空，那多半是上游改了行为或只回了一部分 —— 交出一份缺了一角的
 * 快照比直接失败更糟（前端会把缺失当成「没有数据」）。
 */
const ETF_QUOTE_MIN_RATIO = 0.9;

/** 只接受场内代码：5xxxxx 沪市、1xxxxx 深市（目录里有少量场外代码，不能按市场前缀硬套） */
export function isExchangeTradedCode(code: string): boolean {
  return /^[15]\d{5}$/.test(code);
}

/** `510300` → `1.510300`（沪市 `1.`、深市 `0.`，与 `quote.ts` 同规则） */
export function toEtfSecId(code: string): string {
  return `${code.startsWith('5') ? '1' : '0'}.${code}`;
}

/** 解析批量报价响应（`data.diff`）；越界/全部未知代码时上游返回 `data: null`，不是错误 */
export function parseEtfQuoteResponse(text: string): EtfSpotItem[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('ETF 批量报价响应不是合法 JSON', { detail: snippet(text) });
  }

  const data = record(record(payload)?.data);
  if (!data) return [];

  if (!Array.isArray(data.diff)) {
    throw new ParseError('ETF 批量报价响应缺少 diff 数组', { detail: snippet(text) });
  }

  // total 只用来做护栏：报了多少行以 diff 为准
  const total = num(data.total) ?? 0;
  const items: EtfSpotItem[] = [];
  for (const row of array(data.diff)) {
    const item = spotItemFromRow(row);
    if (item !== null) items.push(item);
  }

  if (total > 0 && items.length === 0) {
    throw new ParseError(`ETF 批量报价 total=${total} 但 diff 为空，疑似接口结构变更`);
  }
  return items;
}

/**
 * 按代码批量取行情。
 *
 * 顺序发请求（`HttpClient` 自己管同 host 间隔与并发），把命中的行按代码去重后返回；
 * 调用方负责把「行情 × 目录」join 起来。
 */
export async function fetchEtfSpotBySecids(
  client: HttpClient,
  codes: readonly string[],
): Promise<EtfSpotItem[]> {
  const targets = [...new Set(codes.filter(isExchangeTradedCode))];
  if (targets.length === 0) {
    throw new ParseError('ETF 批量报价缺少可用代码（目录为空或代码格式异常）');
  }

  const byCode = new Map<string, EtfSpotItem>();
  for (let i = 0; i < targets.length; i += ETF_QUOTE_BATCH_SIZE) {
    const batch = targets.slice(i, i + ETF_QUOTE_BATCH_SIZE);
    const params = new URLSearchParams({
      fltt: '2',
      invt: '2',
      fields: ETF_SPOT_FIELDS,
      secids: batch.map(toEtfSecId).join(','),
    });

    const text = await fetchQuoteText(client, `/api/qt/ulist.np/get?${params.toString()}`, {
      timeoutMs: 20_000,
    });
    for (const item of parseEtfQuoteResponse(text)) byCode.set(item.code, item);
  }

  if (byCode.size === 0) {
    throw new ParseError('ETF 批量报价未返回任何行，疑似接口不可用或字段变更');
  }
  if (byCode.size < targets.length * ETF_QUOTE_MIN_RATIO) {
    throw new ParseError(
      `ETF 批量报价只取到 ${byCode.size}/${targets.length} 行，疑似上游只回了一部分`,
    );
  }

  return [...byCode.values()];
}
