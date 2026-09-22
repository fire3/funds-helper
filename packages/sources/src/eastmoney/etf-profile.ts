import { ParseError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import { array, num, record, snippet, str } from './util.ts';

/**
 * 接口 B：ETF 目录（跟踪指数 + 分类标志位 + 区间涨跌 + 份额）。
 *
 * 东方财富数据中心报表 `RPT_FUND_ETFLIST`，实测 1675 行、`pageSize` 上限 1000 → 2 页。
 * 比行情多出约 52 行（已成立未上市的新 ETF），所以**不能**把它当成行情的替代品。
 *
 * `IS_*ETF` 标志位的语义是逆向推断的（`IS_KJETF` = 宽基、`IS_HYETF` = 行业主题、
 * `IS_FGETF` = 风格…），证据见 `docs/design/etf-data-sources.md` §2.2；
 * 这里只做**形状解析**（0/1 → boolean），分类优先级放在 `@funds-helper/core`。
 */

export interface RawEtfProfile {
  code: string;
  name: string;
  /** 上游 `510300.SH`，用于交叉验证交易所 */
  secuCode: string | null;
  indexCode: string | null;
  indexName: string | null;

  money: boolean;
  crossBorder: boolean;
  bond: boolean;
  commodity: boolean;
  broad: boolean;
  industry: boolean;
  style: boolean;

  change1w: number | null;
  change1m: number | null;
  change3m: number | null;
  ytdChange: number | null;
  maxDrawdown1y: number | null;

  /** `DEC_NAV`：实测单位是**亿元**（价格 × 份额），不是净值 */
  netAssetsYi: number | null;
  /** `DEC_TOTALSHARE`：份额（份） */
  shares: number | null;
}

export interface EtfProfilePage {
  count: number;
  pages: number;
  rows: RawEtfProfile[];
}

export const ETF_PROFILE_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
export const ETF_PROFILE_REPORT = 'RPT_FUND_ETFLIST';
export const ETF_PROFILE_PAGE_SIZE = 1000;
/** 报表规模护栏：实测 1675 行 */
export const ETF_PROFILE_MAX_COUNT = 20_000;
/**
 * 取满比例下限：低于它说明只翻到了报表的一部分（上游 `count` 与分页对不上）。
 *
 * 目录不仅提供分类与跟踪指数，**还是东财批量报价（`ulist.np`）的代码池** ——
 * 少拿一页就等于数据集少一批标的，因此宁可报错让上层降级，也不要交出残缺的目录。
 * 实测：`count = 1675`、7 行没有场内行情（已成立未上市）→ 覆盖率 99.6%，0.9 有充足余量。
 */
const ETF_PROFILE_MIN_RATIO = 0.9;

/** 上游用 0/1（可能是数字也可能是字符串）表示标志位 */
function flag(raw: unknown): boolean {
  return num(raw) === 1;
}

export function parseEtfProfilePage(text: string): EtfProfilePage {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('ETF 目录响应不是合法 JSON', { detail: snippet(text) });
  }

  // 报表接口的空结果形态是 result: null（count 0），不是错误
  const result = record(record(payload)?.result);
  if (!result) return { count: 0, pages: 0, rows: [] };

  if (!Array.isArray(result.data)) {
    throw new ParseError('ETF 目录响应缺少 result.data 数组', { detail: snippet(text) });
  }

  const count = num(result.count) ?? 0;
  if (count > ETF_PROFILE_MAX_COUNT) {
    throw new ParseError(`ETF 目录 count 异常（${count}），疑似报表参数或结构变更`);
  }

  const rows: RawEtfProfile[] = [];
  for (const item of array(result.data)) {
    const row = record(item);
    if (!row) continue;
    const code = str(row.SECURITY_CODE);
    const name = str(row.SECURITY_NAME_ABBR);
    // 代码与名称都是必需字段：缺一个就无法展示
    if (!code || !name) continue;
    rows.push({
      code,
      name,
      secuCode: str(row.SECUCODE),
      indexCode: str(row.INDEX_CODE),
      indexName: str(row.INDEX_NAME),
      money: flag(row.IS_HBETF),
      crossBorder: flag(row.IS_WPETF),
      bond: flag(row.IS_ZQETF),
      commodity: flag(row.IS_SPETF),
      broad: flag(row.IS_KJETF),
      industry: flag(row.IS_HYETF),
      style: flag(row.IS_FGETF),
      change1w: num(row.CHANGE_RATE_1W),
      change1m: num(row.CHANGE_RATE_1M),
      change3m: num(row.CHANGE_RATE_3M),
      ytdChange: num(row.YTD_CHANGE_RATE),
      maxDrawdown1y: num(row.MAXDRAWDOWN1Y),
      netAssetsYi: num(row.DEC_NAV),
      shares: num(row.DEC_TOTALSHARE),
    });
  }

  return { count, pages: num(result.pages) ?? 0, rows };
}

/** 取全量目录（pageSize 1000，翻到 pages 为止） */
export async function fetchEtfProfiles(client: HttpClient): Promise<RawEtfProfile[]> {
  const byCode = new Map<string, RawEtfProfile>();
  let pages = 0;
  let count = 0;

  for (let page = 1; page <= 100; page += 1) {
    const params = new URLSearchParams({
      reportName: ETF_PROFILE_REPORT,
      columns: 'ALL',
      pageSize: String(ETF_PROFILE_PAGE_SIZE),
      pageNumber: String(page),
      sortColumns: 'SECURITY_CODE',
      sortTypes: '1',
    });

    const text = await client.getText(`${ETF_PROFILE_URL}?${params.toString()}`, {
      headers: { Referer: 'https://data.eastmoney.com/' },
      timeoutMs: 20_000,
    });
    const parsed = parseEtfProfilePage(text);
    for (const row of parsed.rows) byCode.set(row.code, row);

    pages = parsed.pages;
    count = Math.max(count, parsed.count);
    if (parsed.rows.length === 0 || parsed.rows.length < ETF_PROFILE_PAGE_SIZE) break;
    if (pages > 0 && page >= pages) break;
  }

  if (byCode.size === 0) {
    throw new ParseError('ETF 目录未返回任何行，疑似报表参数变更');
  }
  if (count > 0 && byCode.size < count * ETF_PROFILE_MIN_RATIO) {
    throw new ParseError(`ETF 目录只取到 ${byCode.size}/${count} 行，疑似分页被上游截断`);
  }
  return [...byCode.values()];
}
