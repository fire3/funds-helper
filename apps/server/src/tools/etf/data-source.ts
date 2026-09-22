import { type EtfSpotItem, fetchSinaEtfSpot, type HttpClient } from '@funds-helper/sources';
import {
  createEastmoneyDataSource,
  type EastmoneyFundDataSource,
} from '../../data-sources/eastmoney.ts';

/**
 * ETF 工具的数据源 = 东财能力集合（目录/详情/可选行情）+ **新浪行情源**。
 *
 * 新浪刻意挂在这里而不是塞进 `data-sources/eastmoney.ts`：
 * 「新浪」不是东财能力，其它工具也不该看见它 —— 只有 ETF 工具需要
 * 「行情渠道可换」这条链路（见 `docs/design/etf-tool.md` §4）。
 */
export interface EtfDataSource extends EastmoneyFundDataSource {
  /** 全市场行情（新浪 ETF 列表，自带代码池）：默认源；东财开启时作为降级目标 */
  fetchSinaEtfSpot(): Promise<EtfSpotItem[]>;
}

export function createEtfDataSource(http: HttpClient): EtfDataSource {
  return {
    ...createEastmoneyDataSource(http),
    fetchSinaEtfSpot: () => fetchSinaEtfSpot(http),
  };
}
