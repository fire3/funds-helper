import {
  type FxDailySeries,
  fetchFxDailyKline,
  type HttpClient,
  USD_CNY_SYMBOL,
} from '@funds-helper/sources';

/**
 * 新浪财经外汇数据能力。
 *
 * 与天天基金的数据源分开：它是另一个上游（host、编码、响应形态都不同），
 * 也没有任何可复用之处，合并只会让两边的口径互相牵制。
 */
export interface SinaFxDataSource {
  readonly name: string;
  /** 上游标的标识，随响应下发便于排障 */
  readonly symbol: string;
  fetchDailySeries(): Promise<FxDailySeries>;
}

export function createSinaFxDataSource(http: HttpClient): SinaFxDataSource {
  return {
    name: 'sina',
    symbol: USD_CNY_SYMBOL,
    fetchDailySeries: () => fetchFxDailyKline(http),
  };
}
