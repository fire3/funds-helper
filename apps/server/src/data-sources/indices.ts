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
 * 优先级：**稳定国内源在前，Yahoo/东财退居兜底**（2026-09-27 调整，用户反馈
 * 「东财与 Yahoo 都不太稳定，主源不要这两个」）。实测当日：新浪 gi 200、
 * 腾讯 200，而东财 push2his 503、Yahoo 直连 429 —— 与前两天的双故障窗口一致。
 *
 * - **主源①：新浪 gi 日线**（国内直连最稳）：覆盖欧亚/美洲/大洋洲 19 个指数
 *   （`sina` 非 null），OHLC 齐全，深度上限 1000 行（约 4 年，增量足够）；
 * - **主源②：腾讯**（国内直连）：恰好覆盖美/港 5 个指数（`tencent` 非 null，
 *   与新浪**互补而非重叠**），K 线上限 1600 行；已知怪癖：`usNDX` 只回 1 根；
 * - **备源：东财 K 线**：覆盖 24/28（缺纳指100/罗素/VIX/恒生科技），国内直连
 *   但端点常 503（http 在前、https 兜底）；
 * - **最后兜底：Yahoo**：唯一覆盖全部 28 个、历史最深（标普自 1970），
 *   但直连常 429，仅在上述三源都拿不到时使用。
 *
 * 降级链**逐指数按注册表取实际拥有该指数代码的源**，不是固定四跳：美股/恒指系
 * 只走腾讯→东财→Yahoo，欧亚/美洲只走新浪→东财→Yahoo。因此罗素 2000 / VIX /
 * 恒生科技（注册表 `sina`/`tencent` 均为 null、`em` 也缺）**仍只能**落到
 * Yahoo；恒生国企则只有东财（`em`）与 Yahoo。**其余 24 个指数都能由稳定源长期供数。**
 *
 * ⚠️ 历史深度：新浪/腾讯有行数上限（约 4 / 6.5 年）。**库中已有历史不受影响**
 * （增量 upsert 只追加新行）；但首次回填（库里没有该指数）时，稳定源给不了
 * Yahoo/东财那样的数十年深度 —— 需要完整历史时把这两个源临时恢复为优先即可。
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
  /** 本次实际使用的上游（'sina' | 'tencent' | 'eastmoney' | 'yahoo'），随行落库 */
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
    name: 'sina+tencent+eastmoney+yahoo',

    async fetchBars(def, options = {}): Promise<IndexBarFetch> {
      const failures: string[] = [];

      // 主源①：新浪 gi 日线（国内直连最稳；只覆盖欧亚/美洲/大洋洲）
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

      // 主源②：腾讯（国内直连；与新浪恰好互补 —— 只覆盖美/港 5 个）
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

      // 最后兜底：Yahoo（唯一覆盖全部 28 个、历史最深，但直连常 429）
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
