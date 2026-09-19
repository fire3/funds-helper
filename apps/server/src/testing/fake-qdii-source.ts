import {
  type FundDetailData,
  type HoldingsData,
  type PeriodIncreaseData,
  type PurchaseSnapshot,
  type PurchaseSnapshotRow,
  type QuoteItem,
  type RawNotice,
  UpstreamError,
} from '@funds-helper/sources';
import type { QdiiDataSource } from '../tools/qdii/data-source.ts';

/**
 * 可注入的假数据源。
 *
 * 服务端集成测试的关键路径（上游故障时的降级、部分区块失败）都靠它 —
 * 真实上游不可控，不能拿来做测试断言。
 */
export interface FakeQdiiSource extends QdiiDataSource {
  /** 可随时替换，用于模拟「第二天数据变了」 */
  rows: PurchaseSnapshotRow[];
  showday: string[];
  /** 让指定接口抛错 */
  failures: Set<string>;
  calls: Record<string, number>;
}

function row(overrides: Partial<PurchaseSnapshotRow> = {}): PurchaseSnapshotRow {
  return {
    code: '270042',
    name: '广发纳斯达克100ETF联接人民币(QDII)A',
    fundType: '指数型-海外股票',
    nav: '8.1177',
    navDate: '09-11',
    purchaseStatus: '限大额',
    redeemStatus: '开放赎回',
    nextOpenDate: null,
    minPurchase: '2.0',
    dailyLimit: '2.0',
    fee: '0.13%',
    ...overrides,
  };
}

/** 覆盖各状态的默认数据集（数字取自真实实测样本） */
export function defaultRows(): PurchaseSnapshotRow[] {
  return [
    row(),
    row({
      code: '006479',
      name: '广发纳斯达克100ETF联接人民币(QDII)C',
      dailyLimit: '2.0',
      minPurchase: '2.0',
      fee: '0.00%',
    }),
    row({
      code: '000834',
      name: '大成纳斯达克100ETF联接(QDII)A',
      nav: '6.2705',
      dailyLimit: '10.0',
      minPurchase: '10.0',
      fee: '0.12%',
    }),
    row({
      code: '050025',
      name: '博时标普500ETF联接A',
      nav: '5.5759',
      purchaseStatus: '暂停申购',
      dailyLimit: '100.0',
    }),
    row({
      code: '015641',
      name: '华夏全球股票(QDII)(人民币)',
      nav: '1.1000',
      purchaseStatus: '开放申购',
      dailyLimit: '100000000000',
    }),
    row({
      code: '513100',
      name: '纳指ETF国泰',
      fundType: '指数型-海外股票',
      nav: '1.9831',
      purchaseStatus: '场内交易',
      redeemStatus: '场内交易',
      dailyLimit: '0',
      minPurchase: '0',
      fee: null,
    }),
    // 非 QDII，必须被过滤掉
    row({ code: '000001', name: '华夏成长混合', fundType: '混合型-灵活' }),
  ];
}

/**
 * 美元份额工具的假数据集：4 只美元份额 + 1 只人民币同类份额（供份额对照测试）
 * + 1 只非美元基金（必须被过滤）。
 */
export function usdRows(): PurchaseSnapshotRow[] {
  return [
    row({
      code: '011000',
      name: '嘉实美国成长股票美元现汇',
      fundType: 'QDII-普通股票',
      purchaseStatus: '限大额',
      dailyLimit: '0',
      minPurchase: '10.0',
    }),
    // 同基金的人民币份额：应作为 011000 的对照，自身不应出现在美元列表里
    row({
      code: '011001',
      name: '嘉实美国成长股票人民币',
      fundType: 'QDII-普通股票',
      purchaseStatus: '限大额',
      dailyLimit: '100.0',
      minPurchase: '10.0',
    }),
    row({
      code: '011002',
      name: '广发纳斯达克100ETF联接美元(QDII)A',
      fundType: '指数型-海外股票',
      purchaseStatus: '开放申购',
      dailyLimit: '100000000000',
      minPurchase: '100.0',
    }),
    row({
      code: '011003',
      name: '华夏恒生ETF联接美钞',
      fundType: '指数型-海外股票',
      purchaseStatus: '暂停申购',
      dailyLimit: '0',
      minPurchase: '10.0',
    }),
    row({
      code: '011004',
      name: '博时标普500ETF联接美元现汇',
      fundType: '指数型-海外股票',
      purchaseStatus: '限大额',
      dailyLimit: '5000',
      minPurchase: '10.0',
    }),
    // 非美元份额，必须被过滤掉
    row({ code: '000001', name: '华夏成长混合', fundType: '混合型-灵活' }),
  ];
}

export function createFakeQdiiSource(
  options: { rows?: PurchaseSnapshotRow[] } = {},
): FakeQdiiSource {
  const source: FakeQdiiSource = {
    name: 'fake',
    rows: options.rows ?? defaultRows(),
    showday: ['2026-09-14', '2026-09-11'],
    failures: new Set<string>(),
    calls: {},

    async fetchSnapshot(): Promise<PurchaseSnapshot> {
      source.calls.snapshot = (source.calls.snapshot ?? 0) + 1;
      if (source.failures.has('snapshot')) throw new UpstreamError('模拟：申购状态接口不可用');
      // 模拟「非上游」的内部错误（如数据库 schema 漂移）：用于验证它不会被伪装成 503
      if (source.failures.has('snapshot:internal')) throw new Error('模拟：底层数据库错误');
      return {
        rows: source.rows,
        meta: {
          record: source.rows.length,
          pages: '1',
          curpage: '1',
          showday: source.showday,
          skippedRows: 0,
        },
      };
    },

    async fetchFundDetail(code: string): Promise<FundDetailData> {
      source.calls.detail = (source.calls.detail ?? 0) + 1;
      if (source.failures.has('detail')) throw new UpstreamError('模拟：详情接口不可用');
      return {
        code,
        name: '广发纳斯达克100ETF联接人民币(QDII)A',
        fundType: '指数型-海外股票',
        purchaseStatus: '限大额',
        redeemStatus: '开放赎回',
        minPurchase: '2',
        maxPurchase: '2',
        nav: '8.1177',
        navDate: '2026-09-11',
        nextOpenDate: null,
        sourceRate: '1.30%',
        rate: '0.13%',
        company: '广发基金',
        manager: '刘杰',
        riskLevel: '4',
      };
    },

    async fetchNotices(code: string): Promise<RawNotice[]> {
      source.calls.notices = (source.calls.notices ?? 0) + 1;
      if (source.failures.has('notices')) throw new UpstreamError('模拟：公告接口不可用');
      return [
        {
          id: `AN-${code}-1`,
          title: '关于调整大额申购业务限额的公告',
          publishDate: '2026-09-10',
          category: '5',
        },
      ];
    },

    async fetchPingzhong(): Promise<Record<string, unknown>> {
      source.calls.pingzhong = (source.calls.pingzhong ?? 0) + 1;
      if (source.failures.has('pingzhong')) throw new UpstreamError('模拟：净值数据不可用');
      return {
        Data_netWorthTrend: [
          { x: 1344960000000, y: 1.0, equityReturn: 0 },
          { x: Date.UTC(2026, 8, 1), y: 100, equityReturn: 1 },
          { x: Date.UTC(2026, 8, 10), y: 120, equityReturn: 2 },
          { x: Date.UTC(2026, 8, 20), y: 90, equityReturn: -3 },
          { x: Date.UTC(2026, 8, 30), y: 110, equityReturn: 1 },
        ],
        Data_fluctuationScale: {
          categories: ['2025-06-30', '2026-06-30'],
          series: [
            { y: 93.14, mom: '3.26%' },
            { y: 122.23, mom: '25.81%' },
          ],
        },
        Data_assetAllocation: {
          series: [
            { name: '股票占净比', data: [88.5, 0] },
            { name: '现金占净比', data: [9.04, 9.04] },
            { name: '净资产', type: 'line', data: [208.63, 208.63] },
          ],
          categories: ['2026-03-31', '2026-06-30'],
        },
        Data_holderStructure: {
          series: [
            { name: '机构持有比例', data: [0.66, 0.12] },
            { name: '个人持有比例', data: [99.34, 99.88] },
          ],
          categories: ['2025-12-31', '2026-06-30'],
        },
      };
    },

    async fetchPeriodIncrease(): Promise<PeriodIncreaseData> {
      source.calls.period = (source.calls.period ?? 0) + 1;
      if (source.failures.has('period')) throw new UpstreamError('模拟：阶段涨幅不可用');
      return {
        periods: [
          { title: 'Z', ret: '-0.69', avg: '-2.53', bench: '-2.08', rank: '105', total: '362' },
          { title: '1N', ret: '15.00', avg: '-0.56', bench: '-0.93', rank: '118', total: '349' },
          { title: 'LN', ret: '885.36', avg: null, bench: null, rank: null, total: null },
        ],
        estabDate: '2012-08-15',
        time: '2026-09-11',
      };
    },

    async fetchHoldings(): Promise<HoldingsData> {
      source.calls.holdings = (source.calls.holdings ?? 0) + 1;
      if (source.failures.has('holdings')) throw new UpstreamError('模拟：持仓数据不可用');
      return {
        stocks: [],
        bonds: [],
        etf: { code: '159941', name: '纳指ETF广发' },
        reportDate: '2026-06-30',
      };
    },

    async fetchQuotes(codes: readonly string[]): Promise<QuoteItem[]> {
      source.calls.quotes = (source.calls.quotes ?? 0) + 1;
      if (source.failures.has('quotes')) throw new UpstreamError('模拟：行情接口不可用');
      return codes.map((code, index) => ({
        code,
        name: `行情-${code}`,
        price: 2.5 + index,
        prevClose: 2.4,
        discountRate: -8.24 + index,
        market: code.startsWith('5') ? 1 : 0,
      }));
    },
  };

  return source;
}
