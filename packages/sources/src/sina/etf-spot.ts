import { ParseError } from '../errors.ts';
import type { EtfSpotItem } from '../etf/spot.ts';
import type { HttpClient } from '../http.ts';

/**
 * 默认行情源：新浪财经「ETF 基金行情」节点列表。
 *
 * 东财 `clist`（字段更全，但被上游按接口重置，见 `docs/design/etf-data-sources.md` §1.4 / §7.4）
 * 只在 `ETF_EASTMONEY_ENABLED=true` 时才会尝试，失败仍然回到这里。
 * 选它而不是腾讯 `qt.gtimg.cn` 的原因：
 * - **自带全市场代码池** —— 列表接口本身就是行情，不需要先有代码再批量查（冷启动也能用）；
 * - **UTF-8 JSON**（非 ASCII 用 `\uXXXX` 转义），不需要给 `HttpClient` 加 GBK 解码；
 * - 腾讯一次可查 500 只（4 次请求），但拿不到代码池、且是 GBK —— 适合当第三级，暂不实现。
 *
 * 代价：`num` 上限同样是 **100**（传 500/1000/2000 也只回 100），全市场 1676 只 = 17 页，
 * 与主源一致；且**没有折溢价 / 上市日期 / 主力净流入 / 量比**（见 §7.1 的字段对照表）。
 */

export const SINA_ETF_LIST_URL =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
export const SINA_ETF_COUNT_URL =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount';

/** 新浪的「ETF 基金行情」节点（节点树里叫 `ETF基金行情`，id 是 `etf_hq_fund`） */
export const SINA_ETF_NODE = 'etf_hq_fund';

/** `num` 实测上限 100 */
export const SINA_ETF_PAGE_SIZE = 100;
/** 报表规模护栏：实测 1676 */
export const SINA_ETF_MAX_COUNT = 5000;
/** 取满比例下限：低于它说明翻页期间列表发生了抖动，宁可报错也不要交出残缺快照 */
const SINA_ETF_MIN_RATIO = 0.9;

const SINA_HEADERS = { Referer: 'https://finance.sina.com.cn' } as const;

/** 新浪把数字混着字符串下发（`"trade":"1.754"` / `"nmc":10939124.1`），落成 null 比落成 NaN 安全 */
function num(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '--' || trimmed === '-') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function str(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function snippet(text: string, size = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= size ? clean : `${clean.slice(0, size)}…`;
}

/** 符号前缀 → 交易所（`sh` = 1 沪市、`sz` = 0 深市，与东财 `f13` 同口径） */
function marketOf(symbol: string): number | null {
  if (symbol.startsWith('sh')) return 1;
  if (symbol.startsWith('sz')) return 0;
  return null;
}

/** 振幅 %（新浪不提供，用东财同口径 (高−低)/昨收 推导） */
function amplitudeOf(row: Record<string, unknown>): number | null {
  const high = num(row.high);
  const low = num(row.low);
  const prevClose = num(row.settlement);
  if (high === null || low === null || prevClose === null || prevClose <= 0) return null;
  return ((high - low) / prevClose) * 100;
}

function toItem(raw: unknown): EtfSpotItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;

  const symbol = str(row.symbol);
  const name = str(row.name);
  if (symbol === null || name === null) return null;

  const market = marketOf(symbol);
  const code = symbol.slice(2);
  // 交易所无法判定（非 sh/sz 前缀）时跳过：代码是唯一键，市场错了会污染统计
  if (market === null || !/^\d{6}$/.test(code)) return null;

  // 新浪 `volume` 是**股**，与东财 `f5` 的「手」不同口径 —— 这里统一成手
  const volumeShares = num(row.volume);
  // `nmc`（流通市值，万元）实测与东财 `f20`（场内规模）一致：
  // 511990 = 967.20 亿 vs f20 的 967.25 亿、510300 = 1093.91 亿 vs 1093.91 亿
  const nmcWan = num(row.nmc);

  return {
    code,
    name,
    market,
    price: num(row.trade),
    changePct: num(row.changepercent),
    changeAmt: num(row.pricechange),
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    prevClose: num(row.settlement),
    amplitude: amplitudeOf(row),
    turnover: num(row.turnoverratio),
    // 新浪列表没有量比 / 折溢价 / 上市日期 / 主力净流入
    volumeRatio: null,
    volume: volumeShares === null ? null : volumeShares / 100,
    amount: num(row.amount),
    scale: nmcWan === null ? null : nmcWan * 1e4,
    floatScale: null,
    discountRate: null,
    listingDate: null,
    mainInflow: null,
    // 上游只给 `ticktime`（HH:MM:SS）没有日期，无法还原真实行情时间戳 —— 宁可留空
    quoteTs: null,
  };
}

/** 解析一页列表（**不是** `data.xxx` 包装，直接是数组；空页返回 `null`） */
export function parseSinaEtfListPage(text: string): EtfSpotItem[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('新浪 ETF 列表响应不是合法 JSON', { detail: snippet(text) });
  }

  // 越界页码返回 null（不是错误）
  if (payload === null) return [];
  if (!Array.isArray(payload)) {
    throw new ParseError('新浪 ETF 列表响应不是数组', { detail: snippet(text) });
  }

  const items: EtfSpotItem[] = [];
  for (const row of payload) {
    const item = toItem(row);
    if (item !== null) items.push(item);
  }
  return items;
}

/** 解析总数（响应是 `"1676"` 这样的 JSON 字符串） */
export function parseSinaEtfCount(text: string): number {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('新浪 ETF 数量响应不是合法 JSON', { detail: snippet(text) });
  }
  const value = num(payload);
  if (value === null) {
    throw new ParseError('新浪 ETF 数量响应不是数字', { detail: snippet(text) });
  }
  if (value > SINA_ETF_MAX_COUNT) {
    throw new ParseError(`新浪 ETF 数量异常（${value}），疑似节点或接口结构变更`);
  }
  return value;
}

async function fetchCount(client: HttpClient): Promise<number> {
  const text = await client.getText(`${SINA_ETF_COUNT_URL}?node=${SINA_ETF_NODE}`, {
    headers: { ...SINA_HEADERS },
    timeoutMs: 20_000,
  });
  return parseSinaEtfCount(text);
}

/**
 * 取全市场 ETF 行情（按 `page` 翻页到总数，按代码去重）。
 *
 * `sort=symbol&asc=1` 是**稳定排序**：翻页期间列表抖动会漏行，靠 `SINA_ETF_MIN_RATIO` 兜住
 * （宁可报错让上层走陈旧快照，也不要交出缺了一块的行情）。
 */
export async function fetchSinaEtfSpot(client: HttpClient): Promise<EtfSpotItem[]> {
  const total = await fetchCount(client);
  const byCode = new Map<string, EtfSpotItem>();
  const maxPages = Math.ceil(SINA_ETF_MAX_COUNT / SINA_ETF_PAGE_SIZE);

  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      page: String(page),
      num: String(SINA_ETF_PAGE_SIZE),
      sort: 'symbol',
      asc: '1',
      node: SINA_ETF_NODE,
      symbol: '',
      _s_r_a: 'page',
    });

    const text = await client.getText(`${SINA_ETF_LIST_URL}?${params.toString()}`, {
      headers: { ...SINA_HEADERS },
      timeoutMs: 20_000,
    });
    const items = parseSinaEtfListPage(text);
    for (const item of items) byCode.set(item.code, item);

    if (items.length < SINA_ETF_PAGE_SIZE) break;
    if (byCode.size >= total) break;
  }

  if (byCode.size === 0) {
    throw new ParseError('新浪 ETF 列表未返回任何行，疑似节点参数变更');
  }
  if (total > 0 && byCode.size < total * SINA_ETF_MIN_RATIO) {
    throw new ParseError(`新浪 ETF 列表只取到 ${byCode.size}/${total} 行，疑似翻页期间列表抖动`);
  }

  return [...byCode.values()];
}
