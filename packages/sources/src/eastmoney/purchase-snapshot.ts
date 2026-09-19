import { ParseError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import { snippet, str } from './util.ts';

/**
 * 接口 A：全市场基金申购状态（主数据源）。
 *
 * 唯一能**一次请求覆盖全部 QDII** 的接口（27538 行 / 约 4 MB），
 * 因此是列表页的数据来源。绝不用接口 B 逐只轮询 —— 735 次请求对非官方接口是滥用。
 *
 * 响应是 **JS 对象字面量而非合法 JSON**（外层 key 无引号），必须先截取 datas 数组。
 */

export const PURCHASE_SNAPSHOT_COLUMNS = 13;

export interface PurchaseSnapshotRow {
  code: string;
  name: string;
  fundType: string;
  nav: string | null;
  navDate: string | null;
  purchaseStatus: string | null;
  redeemStatus: string | null;
  nextOpenDate: string | null;
  minPurchase: string | null;
  dailyLimit: string | null;
  fee: string | null;
}

export interface PurchaseSnapshotMeta {
  record: number | null;
  pages: string | null;
  curpage: string | null;
  /** showday[0] 是数据日期 */
  showday: string[];
  /** 因缺少基金代码而跳过的行数（实测上游确实存在字段残缺的行） */
  skippedRows: number;
}

export interface PurchaseSnapshot {
  rows: PurchaseSnapshotRow[];
  meta: PurchaseSnapshotMeta;
}

// 注意：`datas:` 后面紧跟的就是数组值本身，切片时必须从 `[` 开始（多含一个 `[` 会丢掉外层数组括号）
const DATAS_START = 'datas:';
const DATAS_END = '],record:';

/**
 * 行级解析**刻意宽松**：只要求基金代码存在。
 *
 * 实测上游确实存在字段残缺的行（如 `028912` 的「基金类型」为空串），
 * 一行脏数据不该让整个 27538 行的数据集失败 —— 这类行本来也不是 QDII，
 * 交给 core 的 QDII 口径过滤掉即可。
 *
 * 真正代表「上游改版」的信号是**列数变化**，那个校验保留在 parsePurchaseSnapshot 里。
 */
function toRow(cells: unknown[]): PurchaseSnapshotRow | null {
  const code = str(cells[0]);
  if (!code) return null;

  return {
    code,
    name: str(cells[1]) ?? '',
    fundType: str(cells[2]) ?? '',
    nav: str(cells[3]),
    navDate: str(cells[4]),
    purchaseStatus: str(cells[5]),
    redeemStatus: str(cells[6]),
    nextOpenDate: str(cells[7]),
    minPurchase: str(cells[8]),
    dailyLimit: str(cells[9]),
    fee: str(cells[12]),
  };
}

function parseMeta(text: string, skippedRows: number): PurchaseSnapshotMeta {
  const at = text.indexOf('record:');
  const tail = at === -1 ? text : text.slice(at);

  const recordMatch = /record:"?(\d+)"?/.exec(tail);
  const pagesMatch = /pages:"([^"]*)"/.exec(tail);
  const curpageMatch = /curpage:"([^"]*)"/.exec(tail);
  const showdayMatch = /showday:(\[[^\]]*\])/.exec(tail);

  let showday: string[] = [];
  if (showdayMatch?.[1]) {
    try {
      const parsed: unknown = JSON.parse(showdayMatch[1]);
      if (Array.isArray(parsed)) showday = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      showday = [];
    }
  }

  return {
    record: recordMatch?.[1] ? Number(recordMatch[1]) : null,
    pages: pagesMatch?.[1] ?? null,
    curpage: curpageMatch?.[1] ?? null,
    showday,
    skippedRows,
  };
}

/**
 * 纯解析函数（可脱离网络用 fixture 测试）。
 *
 * 结构校验是**前置**的：缺 datas、列数变更都会立刻抛 ParseError，
 * 而不是让脏数据流到下游。
 */
export function parsePurchaseSnapshot(text: string): PurchaseSnapshot {
  const start = text.indexOf(DATAS_START);
  const end = text.indexOf(DATAS_END);

  if (start === -1 || end === -1 || end < start) {
    throw new ParseError('申购状态响应结构不符合预期：未找到 datas 数组', {
      detail: snippet(text),
    });
  }

  const jsonText = text.slice(start + DATAS_START.length, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ParseError('申购状态 datas 数组解析失败', { detail: snippet(jsonText) });
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ParseError('申购状态 datas 不是非空数组', { detail: snippet(jsonText) });
  }

  const first = parsed[0];
  if (!Array.isArray(first) || first.length !== PURCHASE_SNAPSHOT_COLUMNS) {
    const actual = Array.isArray(first) ? first.length : '非数组';
    throw new ParseError(`申购状态列数异常：期望 ${PURCHASE_SNAPSHOT_COLUMNS}，实际 ${actual}`, {
      detail: snippet(jsonText),
    });
  }

  let skippedRows = 0;
  const rows: PurchaseSnapshotRow[] = [];
  for (const cells of parsed) {
    if (!Array.isArray(cells)) {
      skippedRows += 1;
      continue;
    }
    const row = toRow(cells);
    if (row === null) {
      skippedRows += 1;
      continue;
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    throw new ParseError('申购状态解析后没有任何有效行', { detail: snippet(jsonText) });
  }

  return { rows, meta: parseMeta(text, skippedRows) };
}

export const PURCHASE_SNAPSHOT_URL = 'https://fund.eastmoney.com/Data/Fund_JJJZ_Data.aspx';

export async function fetchPurchaseSnapshot(client: HttpClient): Promise<PurchaseSnapshot> {
  const params = new URLSearchParams({
    t: '8',
    page: '1,50000',
    js: 'reData',
    sort: 'fcode,asc',
  });
  const url = `${PURCHASE_SNAPSHOT_URL}?${params.toString()}`;
  const text = await client.getText(url, {
    headers: { Referer: 'https://fund.eastmoney.com/Fund_sgzt_bzdm.html' },
  });
  return parsePurchaseSnapshot(text);
}
