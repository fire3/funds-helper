import {
  type EtfSpotItem,
  type FeederScanResult,
  type FundCatalogEntry,
  fetchFeederTargets,
  fetchFundCatalog,
  fetchSinaEtfSpot,
  HttpClient,
} from '@funds-helper/sources';
import {
  createEastmoneyDataSource,
  type EastmoneyFundDataSource,
} from '../../data-sources/eastmoney.ts';

/**
 * ETF 工具的数据源 = 东财能力集合（目录/详情/可选行情）+ **新浪行情源** + **联接基金反查**。
 *
 * 新浪刻意挂在这里而不是塞进 `data-sources/eastmoney.ts`：
 * 「新浪」不是东财能力，其它工具也不该看见它 —— 只有 ETF 工具需要
 * 「行情渠道可换」这条链路（见 `docs/design/etf-tool.md` §4）。
 */
export interface EtfDataSource extends EastmoneyFundDataSource {
  /** 全市场行情（新浪 ETF 列表，自带代码池）：默认源；东财开启时作为降级目标 */
  fetchSinaEtfSpot(): Promise<EtfSpotItem[]>;
  /** 联接基金候选池 = 接口 E 的全量基金表（一次请求；解析与搜索联想共用 `fund-list.ts`） */
  fetchFundCatalog(): Promise<FundCatalogEntry[]>;
  /** 逐只反查目标 ETF（接口 I；走专用通道，见下） */
  fetchFeederTargets(
    codes: readonly string[],
    options?: { onProgress?: (done: number, total: number) => void },
  ): Promise<FeederScanResult>;
}

/**
 * 反查专用通道的参数。
 *
 * 这是本项目**唯一**一处不共用 `ctx.http` 节流的链路：全量反查要打 2319 个请求，
 * 共用的 2 并发 / 300ms 会把同样的量拖到 **12 分钟**，而实测该接口在
 * 20 并发下 3.7 秒跑完 2319 个请求、零限流。
 * 6 并发 / 100ms（= 10 req/s，比共用通道快 3 倍）留了充足余量：
 * 实测 300 个请求全部成功、匀速 100ms/个，全量 ≈ **4 分钟**
 * （见 `docs/design/etf-tool.md` §11.4、`etf-data-sources.md` §8）。
 *
 * 只在**一次性、可离线、不在用户请求路径上**的扫描里使用；增量刷新只有几十个请求，
 * 走同一条通道也只是几秒钟的事，因此不再按批量大小分流。
 */
const FEEDER_HTTP_OPTIONS = {
  concurrency: 6,
  minIntervalMs: 100,
  timeoutMs: 20_000,
  maxRetries: 1,
} as const;

export function createEtfDataSource(http: HttpClient): EtfDataSource {
  const feederHttp = new HttpClient(FEEDER_HTTP_OPTIONS);

  return {
    ...createEastmoneyDataSource(http),
    fetchSinaEtfSpot: () => fetchSinaEtfSpot(http),
    fetchFundCatalog: () => fetchFundCatalog(http),
    fetchFeederTargets: (codes, options) =>
      fetchFeederTargets(feederHttp, codes, {
        concurrency: FEEDER_HTTP_OPTIONS.concurrency,
        ...(options?.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      }),
  };
}
