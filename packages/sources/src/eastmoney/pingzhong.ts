import { ParseError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import { array, num, record, snippet, str } from './util.ts';

/**
 * 接口 G：`pingzhongdata` —— 单只基金的全量数据包
 * （全历史净值 / 季度规模 / 资产配置 / 持有人结构 / 基金经理）。
 *
 * 响应是 JS 文本 `/*注释*​/var Name = <json>;` 逐块排列，**不是合法 JSON**：
 * 按 `var` 逐块截取，每个值内部不含分号，解析失败的块（函数定义等）直接跳过。
 */

export interface NavTrendPoint {
  x: number;
  y: number;
  equityReturn: number | null;
}

export interface ScalePoint {
  date: string;
  scale: number | null;
  mom: string | null;
}

export interface AllocationEntry {
  name: string;
  value: number | null;
}

const VAR_BLOCK = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+?);/g;

/** 纯解析：把 JS 文本拆成 { 块名: 已解析值 }，非 JSON 块跳过 */
export function parsePingzhong(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  VAR_BLOCK.lastIndex = 0;

  let match = VAR_BLOCK.exec(text);
  while (match !== null) {
    const name = match[1];
    const body = match[2];
    if (name && body !== undefined) {
      try {
        out[name] = JSON.parse(body);
      } catch {
        // 非 JSON 的块（如函数定义）直接跳过
      }
    }
    match = VAR_BLOCK.exec(text);
  }
  return out;
}

export function extractNavTrend(data: Record<string, unknown>): NavTrendPoint[] {
  const points: NavTrendPoint[] = [];
  for (const raw of array(data.Data_netWorthTrend)) {
    const item = record(raw);
    if (!item) continue;
    const x = num(item.x);
    const y = num(item.y);
    if (x === null || y === null) continue;
    points.push({ x, y, equityReturn: num(item.equityReturn) });
  }
  return points;
}

export function extractScale(data: Record<string, unknown>): ScalePoint[] {
  const block = record(data.Data_fluctuationScale);
  if (!block) return [];

  const categories = array(block.categories);
  const series = array(block.series);
  const points: ScalePoint[] = [];

  for (let i = 0; i < categories.length; i += 1) {
    const date = str(categories[i]);
    if (!date) continue;
    const item = record(series[i]);
    points.push({ date, scale: num(item?.y), mom: str(item?.mom) });
  }

  return points.sort((a, b) => a.date.localeCompare(b.date));
}

/** 取各占比序列的**最新一期**值；`type: 'line'` 的绝对值序列（如「净资产」）跳过 */
function latestSeriesValues(block: Record<string, unknown> | null): AllocationEntry[] {
  if (!block) return [];
  const out: AllocationEntry[] = [];
  for (const raw of array(block.series)) {
    const item = record(raw);
    if (!item || item.type === 'line') continue;
    const name = str(item.name);
    if (!name) continue;
    out.push({ name, value: num(array(item.data).at(-1)) });
  }
  return out;
}

export function extractAllocation(data: Record<string, unknown>): AllocationEntry[] {
  return latestSeriesValues(record(data.Data_assetAllocation));
}

export function extractHolders(data: Record<string, unknown>): AllocationEntry[] {
  return latestSeriesValues(record(data.Data_holderStructure));
}

export const PINGZHONG_BASE_URL = 'https://fund.eastmoney.com/pingzhongdata';

export async function fetchPingzhong(
  client: HttpClient,
  code: string,
): Promise<Record<string, unknown>> {
  const url = `${PINGZHONG_BASE_URL}/${code}.js`;
  const text = await client.getText(url, {
    headers: { Referer: `https://fund.eastmoney.com/${code}.html` },
  });
  const data = parsePingzhong(text);
  if (Object.keys(data).length === 0) {
    throw new ParseError(`基金 ${code} 的净值数据解析失败（上游可能已改版）`, {
      detail: snippet(text),
    });
  }
  return data;
}

/** 上游时间戳是**北京时间零点**，按 UTC+8 取日期才不会差一天 */
export function tsToDate(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
}
