import { ParseError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import { snippet, str } from './util.ts';

/**
 * 接口 E：全量基金列表（约 3.1 MB，**带 BOM**）。
 * 用于搜索联想（代码 / 名称 / 拼音）。
 */

export interface FundCatalogEntry {
  code: string;
  pinyinAbbr: string | null;
  name: string;
  fundType: string;
  pinyinFull: string | null;
}

export const FUND_CATALOG_URL = 'https://fund.eastmoney.com/js/fundcode_search.js';

export function parseFundCatalog(text: string): FundCatalogEntry[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new ParseError('基金列表响应结构不符合预期：未找到数组', { detail: snippet(text) });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ParseError('基金列表数组解析失败', { detail: snippet(text) });
  }

  if (!Array.isArray(parsed)) {
    throw new ParseError('基金列表不是数组', { detail: snippet(text) });
  }

  const entries: FundCatalogEntry[] = [];
  for (const row of parsed) {
    if (!Array.isArray(row)) continue;
    const code = str(row[0]);
    const name = str(row[2]);
    const fundType = str(row[3]);
    if (!code || !name || !fundType) continue;
    entries.push({ code, name, pinyinAbbr: str(row[1]), fundType, pinyinFull: str(row[4]) });
  }

  if (entries.length === 0) {
    throw new ParseError('基金列表解析结果为空', { detail: snippet(text) });
  }
  return entries;
}

export async function fetchFundCatalog(client: HttpClient): Promise<FundCatalogEntry[]> {
  // 该接口带 BOM，HttpClient 已按 utf-8 解码并剥离 BOM
  const text = await client.getText(FUND_CATALOG_URL);
  return parseFundCatalog(text);
}
