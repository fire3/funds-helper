import {
  type FundDetailData,
  fetchFundDetail,
  fetchHoldings,
  fetchLimitNotices,
  fetchPeriodIncrease,
  fetchPingzhong,
  fetchPurchaseSnapshot,
  fetchQuotes,
  type HoldingsData,
  type HttpClient,
  type PeriodIncreaseData,
  type PurchaseSnapshot,
  type QuoteItem,
  type RawNotice,
} from '@funds-helper/sources';

/**
 * QDII 工具所需的数据源能力集合。
 *
 * 收敛成接口是为了让测试可以注入替身 —— 服务端集成测试的降级路径
 * （上游故障时返回陈旧快照）靠的就是替换这一层。
 */
export interface QdiiDataSource {
  readonly name: string;
  fetchSnapshot(): Promise<PurchaseSnapshot>;
  fetchFundDetail(code: string): Promise<FundDetailData>;
  fetchNotices(code: string, size?: number): Promise<RawNotice[]>;
  fetchPingzhong(code: string): Promise<Record<string, unknown>>;
  fetchPeriodIncrease(code: string): Promise<PeriodIncreaseData>;
  fetchHoldings(code: string): Promise<HoldingsData>;
  fetchQuotes(codes: readonly string[]): Promise<QuoteItem[]>;
}

export function createEastmoneyDataSource(http: HttpClient): QdiiDataSource {
  return {
    name: 'eastmoney',
    fetchSnapshot: () => fetchPurchaseSnapshot(http),
    fetchFundDetail: (code) => fetchFundDetail(http, code),
    fetchNotices: (code, size) => fetchLimitNotices(http, code, size),
    fetchPingzhong: (code) => fetchPingzhong(http, code),
    fetchPeriodIncrease: (code) => fetchPeriodIncrease(http, code),
    fetchHoldings: (code) => fetchHoldings(http, code),
    fetchQuotes: (codes) => fetchQuotes(http, codes),
  };
}
