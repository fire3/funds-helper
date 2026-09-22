import type { HttpClient } from '../http.ts';
import { HOLDINGS_URL, type HoldingsData, parseHoldings } from './holdings.ts';
import { str } from './util.ts';

/**
 * 场外联接基金反查（**场内 ETF → 场外份额**）。
 *
 * 接口 I（`FundMNInverstPosition`）只能按基金代码查，所以反查必须**先枚举候选**：
 *
 * 1. 候选池：接口 E（`fundcode_search.js`，见 `fund-list.ts`）→ 名称含「联接」的基金；
 * 2. 反查：逐只打接口 I，取 `Datas.ETFCODE`（实测结论见 `docs/design/etf-data-sources.md` §8）。
 *
 * 实测（2026-09-22）：2319 只候选 → 2306 只拿到目标 ETF（0 失败）→ 1021 只 ETF，
 * 全部命中接口 B 的目录，覆盖率 61.0%。
 *
 * 与 `holdings.ts` 的分工：这里**只做批量反查的编排**，目标 ETF 的字段解析复用 `parseHoldings`
 * （同一接口、同一字段），不重复实现一遍。
 */

/** 反查时同时在飞的请求数上限（客户端本身也有限流，这里只约束在飞数量） */
export const FEEDER_SCAN_CONCURRENCY = 6;

/** 单只联接基金的目标 ETF（接口 I） */
export interface FeederTarget {
  etfCode: string;
  etfName: string | null;
  /** 持仓报告期（响应顶层的 `Expansion`），如 `2026-06-30`；上游不给时为 null */
  reportDate: string | null;
}

export interface FeederScanResult {
  /** feederCode → 目标 ETF；没查到目标 ETF 的候选**不在**其中 */
  targets: Map<string, FeederTarget>;
  /** 查了但上游没给 `ETFCODE` 的代码（新成立未建仓、或联接的是 LOF 而非 ETF） */
  empty: string[];
  /** 请求失败的代码（网络/解析错误，下次刷新会自动重试） */
  failed: string[];
}

/**
 * 接口 I 的响应 → 目标 ETF。
 *
 * `ETFCODE` 也可能是脏值（非 6 位数字），当作「没查到」而不是把脏代码写进库里。
 */
export function toFeederTarget(data: HoldingsData): FeederTarget | null {
  if (data.etf === null) return null;
  const code = str(data.etf.code);
  if (code === null || !/^\d{6}$/.test(code)) return null;
  return { etfCode: code, etfName: str(data.etf.name), reportDate: str(data.reportDate) };
}

/** 单只反查（走接口 I，与持仓详情共用同一次请求的解析） */
export async function fetchFeederTarget(
  client: HttpClient,
  feederCode: string,
): Promise<FeederTarget | null> {
  const params = new URLSearchParams({
    FCODE: feederCode,
    deviceid: 'funds-helper',
    plat: 'Android',
    product: 'EFund',
    version: '6.2.8',
  });
  const text = await client.getText(`${HOLDINGS_URL}?${params.toString()}`);
  return toFeederTarget(parseHoldings(text));
}

/**
 * 按一批联接基金代码反查它们持有的 ETF。
 *
 * 单只失败**不**中断整轮：`failed` 与 `empty` 分开回给调用方 ——
 * 一次网络抖动不该让 2300 个请求的结果全丢，而「上游没有目标 ETF」与「请求失败」
 * 的重试语义也完全不同（前者下次仍可能为空，后者必须重试）。
 */
export async function fetchFeederTargets(
  client: HttpClient,
  codes: readonly string[],
  options: {
    concurrency?: number;
    /** 单只反查的注入点（测试用；默认走接口 I） */
    fetchOne?: (code: string) => Promise<FeederTarget | null>;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<FeederScanResult> {
  const concurrency = Math.max(1, options.concurrency ?? FEEDER_SCAN_CONCURRENCY);
  const fetchOne = options.fetchOne ?? ((code: string) => fetchFeederTarget(client, code));

  const result: FeederScanResult = { targets: new Map(), empty: [], failed: [] };
  let cursor = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const code = codes[cursor];
      cursor += 1;
      if (code === undefined) return;
      try {
        const target = await fetchOne(code);
        if (target === null) result.empty.push(code);
        else result.targets.set(code, target);
      } catch {
        // 失败原因不在这里展开：调用方拿到的是「哪些代码失败」，
        // 网络错误与解析错误的重试语义相同（都是下次再查一遍），不需要分流
        result.failed.push(code);
      }
      done += 1;
      options.onProgress?.(done, codes.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, codes.length) }, worker));
  return result;
}
