import { ParseError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import { fetchQuoteText } from './quote.ts';
import { array, num, record, snippet, str } from './util.ts';

/**
 * 接口 A：全市场 ETF 场内行情（`clist`）。
 *
 * 与 `quote.ts`（按 secid 批量取行情）同一个上游家族，但**按板块取全量**：
 * 一次拿回「价格 / 涨跌 / 成交额 / 换手 / 规模 / 折溢价 / 上市日期」。
 * 实测结论见 `docs/design/etf-data-sources.md`：
 * - 板块并集 1623 只（`MK0024 ⊂ MK0827`，必须按代码去重）；
 * - `pz` 上限 100（传 200/500/1000 都只回 100）→ 必须翻页；
 * - `f402 = −溢价率`（与 `quote.ts` 同口径，负值 = 溢价）。
 */

export interface RawEtfSpotItem {
  code: string;
  name: string | null;
  /** 1 = 沪市，0 = 深市 */
  market: number | null;
  price: number | null;
  changePct: number | null;
  changeAmt: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  amplitude: number | null;
  turnover: number | null;
  volumeRatio: number | null;
  /** 成交量（手） */
  volume: number | null;
  /** 成交额（元） */
  amount: number | null;
  /** 场内规模（元，上游 `f20`） */
  scale: number | null;
  floatScale: number | null;
  /** 上游原值：负值 = 溢价（`f402`） */
  discountRate: number | null;
  /** 上市日期（YYYY-MM-DD） */
  listingDate: string | null;
  mainInflow: number | null;
  /** 行情时间戳（秒） */
  quoteTs: number | null;
}

export interface EtfSpotPage {
  total: number;
  items: RawEtfSpotItem[];
}

/** 板块并集 = 股票型 + 货币 + 跨境 + 商品（`MK0827` 是商品全集，含 `MK0024` 的黄金） */
export const ETF_SPOT_BOARDS = 'b:MK0021,b:MK0022,b:MK0023,b:MK0024,b:MK0827';

export const ETF_SPOT_FIELDS = [
  'f2', // 最新价
  'f3', // 涨跌幅
  'f4', // 涨跌额
  'f5', // 成交量（手）
  'f6', // 成交额（元）
  'f7', // 振幅
  'f8', // 换手率
  'f10', // 量比
  'f12', // 代码
  'f13', // 市场
  'f14', // 名称
  'f15', // 最高
  'f16', // 最低
  'f17', // 今开
  'f18', // 昨收
  'f20', // 总市值
  'f21', // 流通市值
  'f22', // 涨速
  'f26', // 上市日期
  'f62', // 主力净流入
  'f124', // 行情时间戳
  'f402', // −溢价率
].join(',');

/** `pz` 实测上限就是 100：客户端只能靠 `pn` 翻页 */
export const ETF_SPOT_PAGE_SIZE = 100;

/** `total` 护栏：实测 1623。上游异常导致 total 爆掉时立刻失败，而不是翻上千页 */
export const ETF_SPOT_MAX_TOTAL = 5000;

/** `f26` 是 `20120528` 这样的紧凑日期；非法值返回 null 而不是拼出一个假日期 */
export function parseCompactDate(raw: unknown): string | null {
  const value = num(raw);
  if (value === null) return null;
  const text = String(Math.trunc(value));
  if (!/^\d{8}$/.test(text)) return null;
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

export function parseEtfSpotPage(text: string): EtfSpotPage {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('ETF 行情响应不是合法 JSON', { detail: snippet(text) });
  }

  const data = record(record(payload)?.data);
  // 上游对越界页码/未知板块返回 data: null，这不是错误
  if (!data) return { total: 0, items: [] };

  if (!Array.isArray(data.diff)) {
    throw new ParseError('ETF 行情响应缺少 diff 数组', { detail: snippet(text) });
  }

  const total = num(data.total) ?? 0;
  if (total > ETF_SPOT_MAX_TOTAL) {
    throw new ParseError(`ETF 行情 total 异常（${total}），疑似板块参数或接口结构变更`);
  }

  const items: RawEtfSpotItem[] = [];
  for (const row of array(data.diff)) {
    const item = record(row);
    if (!item) continue;
    const code = str(item.f12);
    // 代码是唯一键：没有代码的行无法参与 join，直接跳过（行级宽松）
    if (!code) continue;
    items.push({
      code,
      name: str(item.f14),
      market: num(item.f13),
      price: num(item.f2),
      changePct: num(item.f3),
      changeAmt: num(item.f4),
      open: num(item.f17),
      high: num(item.f15),
      low: num(item.f16),
      prevClose: num(item.f18),
      amplitude: num(item.f7),
      turnover: num(item.f8),
      volumeRatio: num(item.f10),
      volume: num(item.f5),
      amount: num(item.f6),
      scale: num(item.f20),
      floatScale: num(item.f21),
      discountRate: num(item.f402),
      listingDate: parseCompactDate(item.f26),
      mainInflow: num(item.f62),
      quoteTs: num(item.f124),
    });
  }

  return { total, items };
}

/** 取全市场 ETF 行情：按 `pn` 翻页到 `total`，并按代码去重（`MK0024 ⊂ MK0827`） */
export async function fetchEtfSpot(client: HttpClient): Promise<RawEtfSpotItem[]> {
  const byCode = new Map<string, RawEtfSpotItem>();
  const maxPages = Math.ceil(ETF_SPOT_MAX_TOTAL / ETF_SPOT_PAGE_SIZE);
  let total = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      pn: String(page),
      pz: String(ETF_SPOT_PAGE_SIZE),
      po: '1',
      np: '1',
      // 不带 fltt=2 时数值会按 ×100/×1000 下发（实测），必须显式要求「已格式化」
      fltt: '2',
      invt: '2',
      fid: 'f12',
      fs: ETF_SPOT_BOARDS,
      fields: ETF_SPOT_FIELDS,
    });

    const text = await fetchQuoteText(client, `/api/qt/clist/get?${params.toString()}`, {
      timeoutMs: 20_000,
    });
    const parsed = parseEtfSpotPage(text);
    total = parsed.total;
    for (const item of parsed.items) byCode.set(item.code, item);

    // 本页不满 / 已收满 / 空页 → 结束（避免上游 total 抖动时无限翻页）
    if (parsed.items.length < ETF_SPOT_PAGE_SIZE || byCode.size >= total) break;
  }

  if (byCode.size === 0) {
    throw new ParseError('ETF 行情未返回任何行，疑似板块参数变更或接口不可用');
  }
  if (total > 0 && byCode.size < total * 0.5) {
    throw new ParseError(`ETF 行情只取到 ${byCode.size}/${total} 行，疑似分页行为变更`);
  }

  return [...byCode.values()];
}
