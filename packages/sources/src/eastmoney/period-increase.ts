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

/** 批量抓取时同时在飞的请求数上限（与联接反查同参数，见 etf/data-source.ts 的实测依据） */
export const PERIOD_INCREASE_CONCURRENCY = 6;

export interface PeriodIncreaseBatchResult {
  /** code → 结果；失败的代码**不在**其中（调用方保留旧行，下轮重试） */
  data: Map<string, PeriodIncreaseData>;
  /** 请求失败的代码（网络/解析错误） */
  failed: string[];
}

/**
 * 按一批基金代码抓接口 H（区间涨幅的每周批量刷新）。
 *
 * 编排与 `fetchFeederTargets` 同构：单只失败不中断整轮 ——
 * 一次网络抖动不该让 1500 个请求的结果全丢。
 */
export async function fetchPeriodIncrements(
  client: HttpClient,
  codes: readonly string[],
  options: {
    concurrency?: number;
    /** 单只抓取的注入点（测试用；默认走接口 H） */
    fetchOne?: (code: string) => Promise<PeriodIncreaseData>;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<PeriodIncreaseBatchResult> {
  const concurrency = Math.max(1, options.concurrency ?? PERIOD_INCREASE_CONCURRENCY);
  const fetchOne = options.fetchOne ?? ((code: string) => fetchPeriodIncrease(client, code));

  const result: PeriodIncreaseBatchResult = { data: new Map(), failed: [] };
  let cursor = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const code = codes[cursor];
      cursor += 1;
      if (code === undefined) return;
      try {
        result.data.set(code, await fetchOne(code));
      } catch {
        // 失败原因不分流：网络错误与解析错误的重试语义相同（都是下次再查一遍）
        result.failed.push(code);
      }
      done += 1;
      options.onProgress?.(done, codes.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, codes.length) }, worker));
  return result;
}
