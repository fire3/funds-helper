import { ParseError, UpstreamError } from '../errors.ts';
import type { HttpClient, RequestOptions } from '../http.ts';
import { array, num, record, snippet, str } from './util.ts';

/**
 * 接口 F：场内行情（含折价率/溢价率）。
 *
 * **`f402 = (净值 − 价格) / 净值 × 100 = −溢价率`** —— 负值表示溢价。
 * QDII ETF 溢价 8%~10% 是常态，实测最高 23%。
 * 场外限购时「转战场内」是否划算，完全取决于这个字段。
 */

export interface QuoteItem {
  code: string;
  name: string | null;
  price: number | null;
  prevClose: number | null;
  /** 上游原值：负值 = 溢价 */
  discountRate: number | null;
  market: number | null;
}

/** 主域名偶尔连接超时，备用域名（延时行情）实测稳定，故自动切换 */
export const QUOTE_HOSTS = ['push2.eastmoney.com', 'push2delay.eastmoney.com'] as const;

/** 单次请求最多的证券数（与实测可用行为一致） */
export const QUOTE_BATCH_SIZE = 100;

/**
 * 依次尝试主备行情域名，全部失败时抛出最后一个错误。
 *
 * 主域名 `push2.eastmoney.com` 在高频访问后会被**静默重置 TLS**
 * （实测 `SSL_read: unexpected eof`），备用域名 `push2delay.eastmoney.com` 是延时行情、
 * 板块覆盖更少 —— 因此主备切换是「降级可用」而不是「等价冗余」。
 */
export async function fetchQuoteText(
  client: HttpClient,
  path: string,
  options: RequestOptions = {},
): Promise<string> {
  let lastError: unknown;
  for (const host of QUOTE_HOSTS) {
    try {
      return await client.getText(`https://${host}${path}`, {
        ...options,
        headers: { Referer: 'https://quote.eastmoney.com/', ...options.headers },
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new UpstreamError('行情接口不可用（主备域名均失败）');
}

/** 上交所 `1.`，深交所 `0.`（实测以 5 开头的为沪市） */
export function toSecId(code: string): string {
  return `${code.startsWith('5') ? '1' : '0'}.${code}`;
}

export function parseQuotes(text: string): QuoteItem[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('行情响应不是合法 JSON', { detail: snippet(text) });
  }

  const data = record(record(payload)?.data);
  // 上游对未知 secid 会返回 data: null，这不是错误
  if (!data) return [];

  if (!Array.isArray(data.diff)) {
    throw new ParseError('行情响应缺少 diff 数组', { detail: snippet(text) });
  }

  const items: QuoteItem[] = [];
  for (const row of array(data.diff)) {
    const item = record(row);
    if (!item) continue;
    const code = str(item.f12);
    if (!code) continue;
    items.push({
      code,
      name: str(item.f14),
      price: num(item.f2),
      prevClose: num(item.f18),
      discountRate: num(item.f402),
      market: num(item.f13),
    });
  }
  return items;
}

async function fetchBatch(client: HttpClient, secids: string): Promise<QuoteItem[]> {
  const params = new URLSearchParams({
    fltt: '2',
    fields: 'f2,f12,f13,f14,f18,f402',
    secids,
  });

  const text = await fetchQuoteText(client, `/api/qt/ulist.np/get?${params.toString()}`, {
    timeoutMs: 20_000,
  });
  return parseQuotes(text);
}

export async function fetchQuotes(
  client: HttpClient,
  codes: readonly string[],
): Promise<QuoteItem[]> {
  const out: QuoteItem[] = [];
  for (let i = 0; i < codes.length; i += QUOTE_BATCH_SIZE) {
    const batch = codes.slice(i, i + QUOTE_BATCH_SIZE);
    if (batch.length === 0) continue;
    out.push(...(await fetchBatch(client, batch.map(toSecId).join(','))));
  }
  return out;
}
