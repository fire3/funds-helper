import {
  type EtfSpotItem,
  type FundDetailData,
  type FundProfileData,
  fetchEtfProfiles,
  fetchEtfSpot,
  fetchFundDetail,
  fetchFundProfile,
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
  type RawEtfProfile,
  type RawNotice,
} from '@funds-helper/sources';

/**
 * 东方财富基金数据能力集合（**与具体工具无关**）。
 *
 * 收敛成接口是为了让测试可以注入替身 —— 服务端集成测试的降级路径
 * （上游故障时返回陈旧快照）靠的就是替换这一层。
 * QDII / 美元份额 / ETF 三个工具共用同一份数据源，避免各自维护一份上游口径。
 */
export interface EastmoneyFundDataSource {
  readonly name: string;
  fetchSnapshot(): Promise<PurchaseSnapshot>;
  fetchFundDetail(code: string): Promise<FundDetailData>;
  fetchNotices(code: string, size?: number): Promise<RawNotice[]>;
  fetchPingzhong(code: string): Promise<Record<string, unknown>>;
  fetchPeriodIncrease(code: string): Promise<PeriodIncreaseData>;
  fetchHoldings(code: string): Promise<HoldingsData>;
  fetchQuotes(codes: readonly string[]): Promise<QuoteItem[]>;
  /** ETF 全市场场内行情（接口 A，内部翻页） */
  fetchEtfSpot(): Promise<EtfSpotItem[]>;
  /** ETF 目录：跟踪指数 + 分类标志位（接口 B） */
  fetchEtfProfiles(): Promise<RawEtfProfile[]>;
  /** 单只基金的静态档案：费率 / 规模 / 管理人（接口 C）；无档案时返回 null */
  fetchFundProfile(code: string): Promise<FundProfileData | null>;
}

export function createEastmoneyDataSource(http: HttpClient): EastmoneyFundDataSource {
  return {
    name: 'eastmoney',
    fetchSnapshot: () => fetchPurchaseSnapshot(http),
    fetchFundDetail: (code) => fetchFundDetail(http, code),
    fetchNotices: (code, size) => fetchLimitNotices(http, code, size),
    fetchPingzhong: (code) => fetchPingzhong(http, code),
    fetchPeriodIncrease: (code) => fetchPeriodIncrease(http, code),
    fetchHoldings: (code) => fetchHoldings(http, code),
    fetchQuotes: (codes) => fetchQuotes(http, codes),
    fetchEtfSpot: () => fetchEtfSpot(http),
    fetchEtfProfiles: () => fetchEtfProfiles(http),
    fetchFundProfile: (code) => fetchFundProfile(http, code),
  };
}
