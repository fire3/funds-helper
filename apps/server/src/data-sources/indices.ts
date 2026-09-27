import type { IndexDefinition } from '@funds-helper/core';
import {
  fetchGlobalClist,
  fetchGlobalIndexKline,
  fetchSinaGlobalDaily,
  fetchTencentDailyBars,
  fetchYahooDailyBars,
  type HttpClient,
  type RawIndexBar,
  UpstreamError,
} from '@funds-helper/sources';

/**
 * 国际指数数据能力（**四源编排 + 批量实时补齐**）。
 *
 * 优先级来自调研结论（`global-index-data-sources.md` §11/§13/§14）：
 * - **Yahoo 主源**：唯一能覆盖全部 28 个指数的源，历史最深（标普自 1970）；
 * - **东财 K 线备源**：国内直连（http 端点），缺 4 个指数（注册表 `em: null`）；
 * - **腾讯应急源**：实测只覆盖美/港 5 个（`tencent` 非 null），K 线上限 1600 行；
 *   但国内直连时最稳 —— 2026-09-26 实测「Yahoo 429 + 东财 503」双故障窗口里
 *   腾讯仍然 200，5 个头部指数靠它没断，这正是「应急」两字的含义；
 * - **新浪 gi 日线第四源**（2026-09-27 实装，akshare 线索）：只覆盖欧亚/美洲/大洋洲
 *   （`sina` 非 null，与腾讯恰好互补），深度上限 1000 行（约 4 年）；
 *   实战首日即命中：当日东财 push2his 整体故障、Yahoo 直连不通，日欧指数靠它未断。
 *
 * 另有 `fetchLiveQuotes`（东财 clist 批量实时）：**不写日线**，只供概览给
 * “日线全链路失败/从未入库”的指数补一条报价（见 service.buildOverview）。
 *
 * 依次降级，全部失败 → 聚合成一个 UpstreamError 抛出，
 * 由 service 决定是否降级到本地快照还是报 503。
 *
 * 编排放在 server 而不是 `packages/sources`：sources 只负责
 * 「一个上游 → 结构化对象」，谁主谁备是用例层的决策。
 */
export interface IndexBarFetch {
  /** 本次实际使用的上游（'yahoo' | 'eastmoney' | 'tencent'），随行落库 */
  source: string;
  bars: RawIndexBar[];
  skippedRows: number;
  /** 原生计价币种（Yahoo meta 给；东财/腾讯没有，回退注册表值由 service 处理） */
  currency: string | null;
}

export interface IndicesFetchOptions {
  /** 只要该日期之后的 K 线（增量抓取）；不传 = 全量回填 */
  since?: string | null;
  /** 注入当前时间（测试） */
  now?: number;
}

/** 批量实时补齐的单条报价（东财 clist 返回，按注册表对表后带上内部 key） */
export interface IndexLiveQuote {
  /** 注册表内部键 */
  key: string;
  /** 报价来源（真实实现 = 'eastmoney'，测试替身自定） */
  source: string;
  price: number;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
}

export interface IndicesDataSource {
  readonly name: string;
  fetchBars(def: IndexDefinition, options?: IndicesFetchOptions): Promise<IndexBarFetch>;
  /**
   * 批量实时报价（best-effort）：给传入的、库里缺失的指数补报价；
   * 上游不可用时抛错，由 service 决定忽略（概览照常返回库里数据）。
   * 注：无东财代码的指数（`em: null`）不会出现在结果里 —— 它们仍然只能靠日线链路。
   */
  fetchLiveQuotes(defs: readonly IndexDefinition[]): Promise<IndexLiveQuote[]>;
}

export function createIndicesDataSource(http: HttpClient): IndicesDataSource {
  return {
    name: 'yahoo+eastmoney+tencent+sina',

    async fetchBars(def, options = {}): Promise<IndexBarFetch> {
      const failures: string[] = [];

      // 主源：Yahoo
      try {
        const series = await fetchYahooDailyBars(http, def.yahoo, {
          since: options.since ?? null,
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        return {
          source: 'yahoo',
          bars: series.bars,
          skippedRows: series.skippedRows,
          currency: series.currency,
        };
      } catch (error) {
        failures.push(`yahoo: ${error instanceof Error ? error.message : String(error)}`);
      }

      // 备源：东财（注册表标记无此指数时直接跳过）
      if (def.em !== null) {
        try {
          const series = await fetchGlobalIndexKline(http, def.em, {
            since: options.since ?? null,
          });
          return {
            source: 'eastmoney',
            bars: series.bars,
            skippedRows: series.skippedRows,
            // 东财响应没有币种字段，用注册表的原生币种
            currency: def.currency,
          };
        } catch (error) {
          failures.push(`eastmoney: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        failures.push(`eastmoney: 东财没有 ${def.key} 的指数（注册表 em=null）`);
      }

      // 应急源：腾讯（只覆盖美/港 5 个；有 since 时只要最近 40 行，增量语义相同）
      if (def.tencent !== null) {
        try {
          const series = await fetchTencentDailyBars(http, def.tencent, {
            // exactOptionalPropertyTypes：不能把 undefined 传给可选字段，缺省时不写这个 key
            ...(options.since == null ? {} : { count: 40 }),
          });
          return {
            source: 'tencent',
            bars: series.bars,
            skippedRows: series.skippedRows,
            currency: def.currency,
          };
        } catch (error) {
          failures.push(`tencent: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        failures.push(`tencent: 腾讯没有 ${def.key} 的指数（注册表 tencent=null）`);
      }

      // 第四源：新浪 gi 日线（只覆盖欧亚/美洲/大洋洲；与腾讯恰好互补）
      if (def.sina !== null) {
        try {
          const series = await fetchSinaGlobalDaily(http, def.sina, {
            since: options.since ?? null,
          });
          return {
            source: 'sina',
            bars: series.bars,
            skippedRows: series.skippedRows,
            // 新浪响应没有币种字段，用注册表的原生币种
            currency: def.currency,
          };
        } catch (error) {
          failures.push(`sina: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        failures.push(`sina: 新浪没有 ${def.key} 的指数（注册表 sina=null）`);
      }

      throw new UpstreamError(`${def.key}（${def.name}）四个上游都失败：${failures.join('；')}`);
    },

    async fetchLiveQuotes(defs): Promise<IndexLiveQuote[]> {
      const targets = defs.filter((def): def is IndexDefinition => def.em !== null);
      if (targets.length === 0) return [];
      const bySecid = new Map(targets.map((def) => [def.em as string, def]));

      // 解析/传输错误原样抛给 service —— 它是 best-effort 兜底，由调用方吞掉并记日志
      const result = await fetchGlobalClist(http, [...bySecid.keys()]);
      const quotes: IndexLiveQuote[] = [];
      for (const quote of result.quotes) {
        const def = bySecid.get(quote.secid);
        if (def === undefined) continue;
        const change =
          quote.change ?? (quote.prevClose !== null ? quote.price - quote.prevClose : null);
        const changePct =
          quote.changePct ??
          (change !== null && quote.prevClose !== null && quote.prevClose !== 0
            ? (change / quote.prevClose) * 100
            : null);
        quotes.push({
          key: def.key,
          source: 'eastmoney',
          price: quote.price,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          prevClose: quote.prevClose,
          change,
          changePct,
        });
      }
      return quotes;
    },
  };
}
