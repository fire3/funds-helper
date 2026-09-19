import type { HttpClient } from '../http.ts';
import { array, record, str, stripJsonp } from './util.ts';

/**
 * 接口 D：基金公告。`type=5` 是**申购赎回类（限购公告）**，是限购查询的入口。
 * 上游是 JSONP（`cb({...})`），需剥离回调外壳。
 */

export interface RawNotice {
  /** 上游公告 ID —— 天然幂等键，用于数据库去重 */
  id: string;
  title: string;
  publishDate: string;
  category: string | null;
}

const BASE_URL = 'https://api.fund.eastmoney.com/f10/JJGG';

/** 公告详情页 URL */
export function noticeUrl(code: string, id: string): string {
  return `https://fund.eastmoney.com/gonggao/${code},${id}.html`;
}

export function parseNotices(text: string): RawNotice[] {
  const body = stripJsonp(text);
  if (!body) return [];

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }

  const rows = array(record(payload)?.Data);
  const notices: RawNotice[] = [];

  for (const row of rows) {
    const item = record(row);
    if (!item) continue;
    const id = str(item.ID);
    const title = str(item.TITLE);
    const publishDate = str(item.PUBLISHDATEDesc) ?? str(item.PUBLISHDATE);
    if (!id || !title || !publishDate) continue;
    notices.push({
      id,
      title,
      publishDate: publishDate.slice(0, 10),
      category: str(item.NEWCATEGORY),
    });
  }

  return notices;
}

export async function fetchLimitNotices(
  client: HttpClient,
  code: string,
  size = 10,
): Promise<RawNotice[]> {
  const params = new URLSearchParams({
    callback: 'cb',
    fundcode: code,
    pageIndex: '1',
    pageSize: String(size),
    type: '5',
  });
  const url = `${BASE_URL}?${params.toString()}`;
  const text = await client.getText(url, {
    headers: { Referer: 'https://fundf10.eastmoney.com/' },
  });
  return parseNotices(text);
}
