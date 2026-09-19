import { ParseError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import { array, record, snippet, str } from './util.ts';

/**
 * 接口 H：分周期收益率 + 同类平均 + 沪深300 + 同类排名。
 *
 * `title` 里 **`Y` 是「月」、`N` 是「年」**，不要按字面理解成 y/n。
 * `LN`（成立来）的 avg / hs300 / rank 常为空字符串，展示时需兜底。
 */

export interface RawPeriod {
  title: string;
  /** 本基金区间收益率 % */
  ret: string | null;
  /** 同类平均 % */
  avg: string | null;
  /** 沪深300 同期 % */
  bench: string | null;
  rank: string | null;
  total: string | null;
}

export interface PeriodIncreaseData {
  periods: RawPeriod[];
  estabDate: string | null;
  /** 数据时间 */
  time: string | null;
}

const BASE_URL = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNPeriodIncrease';

export function parsePeriodIncrease(text: string): PeriodIncreaseData {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('阶段涨幅响应不是合法 JSON', { detail: snippet(text) });
  }

  const root = record(payload);
  const expansion = record(root?.Expansion);

  const periods: RawPeriod[] = [];
  for (const raw of array(root?.Datas)) {
    const item = record(raw);
    if (!item) continue;
    const title = str(item.title);
    if (!title) continue;
    periods.push({
      title,
      ret: str(item.syl),
      avg: str(item.avg),
      bench: str(item.hs300),
      rank: str(item.rank),
      total: str(item.sc),
    });
  }

  return {
    periods,
    estabDate: str(expansion?.ESTABDATE),
    time: str(expansion?.TIME),
  };
}

export async function fetchPeriodIncrease(
  client: HttpClient,
  code: string,
): Promise<PeriodIncreaseData> {
  const params = new URLSearchParams({
    FCODE: code,
    deviceid: 'funds-helper',
    plat: 'Android',
    product: 'EFund',
    version: '6.2.8',
  });
  const text = await client.getText(`${BASE_URL}?${params.toString()}`);
  return parsePeriodIncrease(text);
}
