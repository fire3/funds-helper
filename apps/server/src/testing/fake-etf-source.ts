import {
  type EtfSpotItem,
  type FeederScanResult,
  type FeederTarget,
  type FundCatalogEntry,
  type FundProfileData,
  fetchFeederTargets,
  fetchPeriodIncrements,
  type HttpClient,
  type PeriodIncreaseData,
  type RawEtfProfile,
  UpstreamError,
} from '@funds-helper/sources';
import type { EtfDataSource } from '../tools/etf/data-source.ts';
import { createFakeQdiiSource } from './fake-qdii-source.ts';

/**
 * 可注入的假 ETF 数据源。
 *
 * 通用区块（净值/收益/规模/持仓/公告）直接复用 QDII 的假数据源 ——
 * ETF 详情抽屉与 QDII/美元份额共用同一个聚合，没有必要写第二份替身。
 *
 * 样本取自真实实测（2026-09-22）：代码 / 名称 / 规模 / 折溢价量级都对得上，
 * 但刻意压缩到 8 只，覆盖「宽基 / 行业主题 / 风格 / 跨境 / 商品 / 货币 / 无目录行」。
 */

export interface FakeEtfSource extends EtfDataSource {
  spot: EtfSpotItem[];
  /** 备用渠道（新浪）的行：主源行的**子集**（没有折溢价/上市日期/量比…） */
  sinaSpot: EtfSpotItem[];
  profiles: RawEtfProfile[];
  detail: FundProfileData | null;
  /** 接口 E 的全量基金表（联接基金候选池从它筛出来） */
  feederCatalog: FundCatalogEntry[];
  /** feederCode → 目标 ETF（接口 I 的替身结果） */
  feederTargets: Map<string, FeederTarget>;
  /** code → 区间涨幅（接口 H 的替身结果；不在表里的代码返回通用样本） */
  periods: Map<string, PeriodIncreaseData>;
  /** 最近一次批量报价收到的代码池（断言服务层确实把目录代码传下去了） */
  lastSpotCodes: string[];
  /** 最近一次反查收到的候选代码（断言增量刷新只补了新的） */
  lastFeederCodes: string[];
  /** 最近一次区间涨幅批量抓取收到的候选代码 */
  lastPeriodCodes: string[];
  /** 让指定接口抛错 */
  failures: Set<string>;
  calls: Record<string, number>;
}

/**
 * 接口 E 的样本：**真实行**（2026-09-22 采集），只保留与本文件 8 只 ETF 相关的联接基金
 * 及其对应的 ETF 行本身。
 *
 * 覆盖三类：有多个份额的（510300 四个）、只有一个份额的（159915）、
 * 以及**目标 ETF 不在行情池里**的 `000942`（广发信息技术联接A → 159939，
 * 反查会落库，但数据集 join 不到任何 ETF —— 不能因此报错）。
 */
export function etfFeederCatalog(): FundCatalogEntry[] {
  const rows: [string, string, string, string][] = [
    ['006131', '华泰柏瑞沪深300ETF联接C', '指数型-股票', 'HUATAIBAIRUIHUSHEN300ETFLIANJIEC'],
    ['022699', '华泰柏瑞沪深300ETF联接I', '指数型-股票', 'HUATAIBAIRUIHUSHEN300ETFLIANJIEI'],
    ['022948', '华泰柏瑞沪深300ETF联接Y', '指数型-股票', 'HUATAIBAIRUIHUSHEN300ETFLIANJIEY'],
    ['460300', '华泰柏瑞沪深300ETF联接A', '指数型-股票', 'HUATAIBAIRUIHUSHEN300ETFLIANJIEA'],
    ['004744', '易方达创业板ETF联接C', '指数型-股票', 'YIFANGDACHUANGYEBANETFLIANJIEC'],
    ['022907', '易方达创业板ETF联接Y', '指数型-股票', 'YIFANGDACHUANGYEBANETFLIANJIEY'],
    ['110026', '易方达创业板ETF联接A', '指数型-股票', 'YIFANGDACHUANGYEBANETFLIANJIEA'],
    [
      '012362',
      '国泰中证全指证券公司ETF联接A',
      '指数型-股票',
      'GUOTAIZHONGZHENGQUANZHIZHENGQUANGONGSIETFLIANJIEA',
    ],
    [
      '012363',
      '国泰中证全指证券公司ETF联接C',
      '指数型-股票',
      'GUOTAIZHONGZHENGQUANZHIZHENGQUANGONGSIETFLIANJIEC',
    ],
    [
      '022509',
      '国泰中证全指证券公司ETF联接E',
      '指数型-股票',
      'GUOTAIZHONGZHENGQUANZHIZHENGQUANGONGSIETFLIANJIEE',
    ],
    ['007937', '华夏饲料豆粕期货ETF联接A', '指数型-其他', 'HUAXIASILIAODOUPOQIHUOETFLIANJIEA'],
    ['007938', '华夏饲料豆粕期货ETF联接C', '指数型-其他', 'HUAXIASILIAODOUPOQIHUOETFLIANJIEC'],
    ['006075', '博时标普500ETF联接C', '指数型-海外股票', 'BOSHIBIAOPU500ETFLIANJIEC'],
    [
      '013425',
      '博时标普500ETF联接美元汇(QDII)A',
      '指数型-海外股票',
      'BOSHIBIAOPU500ETFLIANJIEMEIYUANHUIQDIIA',
    ],
    ['050025', '博时标普500ETF联接A', '指数型-海外股票', 'BOSHIBIAOPU500ETFLIANJIEA'],
    ['007300', '国联安中证半导体ETF联接A', '指数型-股票', 'GUOLIANANZHONGZHENGBANDAOTIETFLIANJIEA'],
    ['007301', '国联安中证半导体ETF联接C', '指数型-股票', 'GUOLIANANZHONGZHENGBANDAOTIETFLIANJIEC'],
    // 名称里没有「ETF」但同样是联接基金（core.isFeederFundName 的核心用例）
    ['000942', '广发信息技术联接A', '指数型-股票', 'GUANGFAXINXIJISHULIANJIEA'],
    // 非联接基金：用来断言候选池确实做了过滤
    ['510300', '沪深300ETF华泰柏瑞', '指数型-股票', 'HUSHEN300ETFHUATAIBAIRUI'],
    ['159915', '创业板ETF易方达', '指数型-股票', 'CHUANGYEBANETFYIFANGDA'],
  ];
  return rows.map(([code, name, fundType, pinyinFull]) => ({
    code,
    name,
    pinyinAbbr: null,
    fundType,
    pinyinFull,
  }));
}

/** feederCode → 目标 ETF（真实映射，2026-09-22 实测） */
export function etfFeederTargets(): Map<string, FeederTarget> {
  const report = '2026-06-30';
  const mapping: [string, string, string][] = [
    ['006131', '510300', '沪深300ETF华泰柏瑞'],
    ['022699', '510300', '沪深300ETF华泰柏瑞'],
    ['022948', '510300', '沪深300ETF华泰柏瑞'],
    ['460300', '510300', '沪深300ETF华泰柏瑞'],
    ['004744', '159915', '创业板ETF易方达'],
    ['022907', '159915', '创业板ETF易方达'],
    ['110026', '159915', '创业板ETF易方达'],
    ['012362', '512880', '证券ETF国泰'],
    ['012363', '512880', '证券ETF国泰'],
    ['022509', '512880', '证券ETF国泰'],
    ['007937', '159985', '豆粕ETF华夏'],
    ['007938', '159985', '豆粕ETF华夏'],
    ['006075', '513500', '标普500ETF博时'],
    ['013425', '513500', '标普500ETF博时'],
    ['050025', '513500', '标普500ETF博时'],
    ['007300', '512480', '半导体ETF国联'],
    ['007301', '512480', '半导体ETF国联'],
    // 目标 ETF 不在行情池里：允许存在，数据集里 join 不到而已
    ['000942', '159939', '信息技术ETF广发'],
  ];
  return new Map(
    mapping.map(([feeder, etfCode, etfName]) => [feeder, { etfCode, etfName, reportDate: report }]),
  );
}

/** 替身不传真实 client（所有请求都走注入的 `fetchOne`）；误用时报错而不是静默返回空 */
const neverClient = {
  getText: async () => {
    throw new Error('替身不应发起真实 HTTP 请求');
  },
} as unknown as HttpClient;

/**
 * 接口 H 的通用样本（真实 510300 响应的形状，数值可区分）：
 * `6Y/1N/3N` + `hs300` 基准 + `TIME` —— 热点研究只消费这几个字段。
 */
function etfPeriodIncreaseSample(overrides: Partial<PeriodIncreaseData> = {}): PeriodIncreaseData {
  return {
    periods: [
      { title: 'Z', ret: '1.50', avg: '1.10', bench: '0.80', rank: '100', total: '5000' },
      { title: '6Y', ret: '6.00', avg: '3.00', bench: '2.00', rank: '200', total: '4900' },
      { title: '1N', ret: '12.00', avg: '8.00', bench: '5.00', rank: '300', total: '4800' },
      { title: '3N', ret: '36.00', avg: '20.00', bench: '15.00', rank: '400', total: '4500' },
      { title: 'JN', ret: '7.00', avg: '4.00', bench: '3.00', rank: '150', total: '4950' },
    ],
    estabDate: '2012-05-04',
    time: '2026-09-22',
    ...overrides,
  };
}

function spotItem(overrides: Partial<EtfSpotItem> = {}): EtfSpotItem {
  return {
    code: '510300',
    name: '沪深300ETF华泰柏瑞',
    market: 1,
    price: 4.613,
    changePct: 0.11,
    changeAmt: 0.005,
    open: 4.636,
    high: 4.658,
    low: 4.612,
    prevClose: 4.608,
    amplitude: 1,
    turnover: 0.27,
    volumeRatio: 0.96,
    volume: 6_445_874,
    amount: 2_987_237_086,
    scale: 109_391_241_858,
    floatScale: 109_391_241_858,
    discountRate: 0.06,
    listingDate: '2012-05-28',
    mainInflow: -22_936_530,
    quoteTs: 1_790_064_693,
    ...overrides,
  };
}

function profileRow(overrides: Partial<RawEtfProfile> = {}): RawEtfProfile {
  return {
    code: '510300',
    name: '沪深300ETF华泰柏瑞',
    secuCode: '510300.SH',
    indexCode: '000300',
    indexName: '沪深300',
    money: false,
    crossBorder: false,
    bond: false,
    commodity: false,
    broad: true,
    industry: false,
    style: false,
    change1w: 1.39,
    change1m: 2.1,
    change3m: 5.2,
    ytdChange: 8.4,
    maxDrawdown1y: -11.17,
    netAssetsYi: 1093.699,
    shares: 23_713_687_700,
    ...overrides,
  };
}

export function etfSpotItems(): EtfSpotItem[] {
  return [
    spotItem(),
    spotItem({
      code: '159915',
      name: '创业板ETF易方达',
      market: 0,
      price: 3.2,
      changePct: 3.52,
      amount: 1_500_000_000,
      scale: 67_147_934_154,
      discountRate: -0.43,
      listingDate: '2011-12-09',
    }),
    spotItem({
      code: '512880',
      name: '证券ETF国泰',
      price: 1.1,
      changePct: -1.2,
      amount: 900_000_000,
      scale: 60_445_587_092,
      discountRate: -1.5,
      listingDate: '2016-08-08',
    }),
    spotItem({
      code: '513100',
      name: '纳指ETF国泰',
      price: 1.985,
      changePct: -4.2,
      amount: 800_000_000,
      scale: 18_955_760_435,
      discountRate: 2,
      listingDate: '2013-05-15',
    }),
    spotItem({
      code: '511990',
      name: '华宝添益ETF',
      price: 100,
      changePct: 0.01,
      amount: 5_000_000_000,
      scale: 96_725_100_000,
      discountRate: -0.02,
      listingDate: '2013-03-07',
    }),
    spotItem({
      code: '159985',
      name: '豆粕ETF华夏',
      market: 0,
      price: 2.231,
      changePct: -0.4,
      amount: 120_000_000,
      scale: 3_525_126_576,
      // 停牌/无折溢价数据：必须是 null 而不是 0
      discountRate: null,
      listingDate: '2019-12-05',
    }),
    // 目录里没有这两行 → 分类走名称回退（一个跨境、一个行业主题）
    spotItem({
      code: '513500',
      name: '标普500ETF博时',
      price: 2.1,
      changePct: 0.5,
      amount: 300_000_000,
      scale: 12_000_000_000,
      discountRate: -0.2,
      listingDate: '2014-01-15',
    }),
    spotItem({
      code: '512480',
      name: '半导体ETF国联',
      price: 1.3,
      changePct: 0.9,
      amount: 200_000_000,
      scale: 8_000_000_000,
      discountRate: -0.05,
      listingDate: '2019-06-12',
    }),
  ];
}

/**
 * 备用渠道（新浪列表）的行：字段是主源行的**子集** ——
 * 没有折溢价 / 上市日期 / 量比 / 主力净流入，也没有行情时间戳（上游只给 HH:MM:SS，没有日期）。
 * 真实响应见 `packages/sources/test/fixtures/sina/etf-spot/list-page.json`。
 */
export function etfSinaSpotItems(base: EtfSpotItem[] = etfSpotItems()): EtfSpotItem[] {
  return base.map((item) => ({
    ...item,
    volumeRatio: null,
    floatScale: null,
    discountRate: null,
    listingDate: null,
    mainInflow: null,
    quoteTs: null,
  }));
}

export function etfProfiles(): RawEtfProfile[] {
  return [
    profileRow(),
    profileRow({
      code: '159915',
      name: '创业板ETF易方达',
      secuCode: '159915.SZ',
      indexCode: '399006',
      indexName: '创业板指',
      change1w: 3.52,
      ytdChange: 12.1,
      maxDrawdown1y: -25.55,
      netAssetsYi: 671.479,
      shares: 19_630_454_936,
    }),
    profileRow({
      code: '512880',
      name: '证券ETF国泰',
      secuCode: '512880.SH',
      indexCode: '399975',
      indexName: '证券公司',
      broad: false,
      industry: true,
      change1w: 1.37,
      maxDrawdown1y: -22.62,
      netAssetsYi: 604.455,
      shares: 56_602_291_500,
    }),
    profileRow({
      code: '513100',
      name: '纳指ETF国泰',
      secuCode: '513100.SH',
      indexCode: 'NDX',
      indexName: '纳斯达克100',
      broad: false,
      crossBorder: true,
      change1w: 0.6,
      maxDrawdown1y: -14.19,
      netAssetsYi: 189.558,
      shares: 9_552_110_600,
    }),
    profileRow({
      code: '511990',
      name: '华宝添益ETF',
      secuCode: '511990.SH',
      indexCode: null,
      indexName: null,
      broad: false,
      money: true,
      change1w: 0.02,
      maxDrawdown1y: 0,
      netAssetsYi: 967.251,
      shares: 967_251_000,
    }),
    profileRow({
      code: '159985',
      name: '豆粕ETF华夏',
      secuCode: '159985.SZ',
      indexCode: 'DCE_M',
      indexName: '大商所豆粕期货价格指数',
      broad: false,
      commodity: true,
      change1w: 0.22,
      maxDrawdown1y: -9.79,
      netAssetsYi: 35.251,
      shares: 1_579_924_066,
    }),
    // 风格维度与宽基叠加（实测有 42 行如此）
    profileRow({
      code: '512890',
      name: '红利低波ETF华泰柏瑞',
      secuCode: '512890.SH',
      indexCode: 'H30269',
      indexName: '红利低波',
      style: true,
      change1w: 0.8,
      maxDrawdown1y: -8.1,
      netAssetsYi: 120.5,
      shares: 10_000_000_000,
    }),
    profileRow({
      code: '513500',
      name: '标普500ETF博时',
      secuCode: '513500.SH',
      indexCode: 'SPX',
      indexName: '标普500',
      broad: false,
      crossBorder: true,
      change1w: 0.5,
      maxDrawdown1y: -9.3,
      netAssetsYi: 120,
      shares: 6_000_000_000,
    }),
    profileRow({
      code: '512480',
      name: '半导体ETF国联',
      secuCode: '512480.SH',
      indexCode: 'H30184',
      indexName: '中证全指半导体',
      broad: false,
      industry: true,
      change1w: 0.9,
      maxDrawdown1y: -18.2,
      netAssetsYi: 80,
      shares: 6_153_846_153,
    }),
    // 目录里有、没有场内行情 → 已成立未上市
    profileRow({
      code: '158000',
      name: '港股通金融ETF鹏华',
      secuCode: '158000.SZ',
      indexCode: 'H11146',
      indexName: '港股通内地金融港元',
      broad: false,
      crossBorder: true,
      change1w: -0.85,
      change1m: 2.73,
      change3m: null,
      ytdChange: null,
      maxDrawdown1y: -4.04,
      netAssetsYi: 0.638,
      shares: 60_925_835,
    }),
  ];
}

/** 把「红利低波」这类风格样本也放进行情里，覆盖「风格优先于宽基」的分类路径 */
export function etfSpotItemsWithStyle(): EtfSpotItem[] {
  return [
    ...etfSpotItems(),
    spotItem({
      code: '512890',
      name: '红利低波ETF华泰柏瑞',
      price: 1.2,
      changePct: 0.8,
      amount: 150_000_000,
      scale: 12_050_000_000,
      discountRate: -0.1,
      listingDate: '2018-12-20',
    }),
  ];
}

export function etfFundProfile(overrides: Partial<FundProfileData> = {}): FundProfileData {
  return {
    code: '510300',
    fullName: '华泰柏瑞沪深300交易型开放式指数证券投资基金',
    shortName: '沪深300ETF华泰柏瑞',
    fundType: '指数型-股票',
    indexCode: '000300',
    indexName: '沪深300指数',
    managementFee: '0.15%',
    custodyFee: '0.05%',
    salesServiceFee: null,
    netAssets: 94_872_183_996.4,
    netAssetsDate: '2026-06-30',
    shareNetAssets: 33_194_696_674.25,
    establishedDate: '2012-05-04',
    company: '华泰柏瑞基金',
    custodian: '工商银行',
    manager: '柳军',
    benchmark: '沪深300指数',
    riskLevel: '5',
    ...overrides,
  };
}

export function createFakeEtfSource(
  options: {
    spot?: EtfSpotItem[];
    sinaSpot?: EtfSpotItem[];
    profiles?: RawEtfProfile[];
    detail?: FundProfileData | null;
    feederCatalog?: FundCatalogEntry[];
    feederTargets?: Map<string, FeederTarget>;
    periods?: Map<string, PeriodIncreaseData>;
  } = {},
): FakeEtfSource {
  // 通用区块（净值/收益/持仓/公告）复用 QDII 的假数据源
  const fund = createFakeQdiiSource({ rows: [] });

  const source: FakeEtfSource = {
    ...fund,
    name: 'fake-etf',
    spot: options.spot ?? etfSpotItems(),
    sinaSpot: options.sinaSpot ?? etfSinaSpotItems(options.spot ?? etfSpotItems()),
    profiles: options.profiles ?? etfProfiles(),
    detail: options.detail === undefined ? etfFundProfile() : options.detail,
    feederCatalog: options.feederCatalog ?? etfFeederCatalog(),
    feederTargets: options.feederTargets ?? etfFeederTargets(),
    periods: options.periods ?? new Map<string, PeriodIncreaseData>(),
    lastSpotCodes: [],
    lastFeederCodes: [],
    lastPeriodCodes: [],
    failures: new Set<string>(),
    calls: {},

    async fetchEtfSpot(): Promise<EtfSpotItem[]> {
      source.calls.spot = (source.calls.spot ?? 0) + 1;
      if (source.failures.has('spot')) throw new UpstreamError('模拟：ETF 行情接口不可用');
      if (source.failures.has('spot:internal')) throw new Error('模拟：底层数据库错误');
      return source.spot;
    },

    /** 真实实现按 100 只/请求分片；替身只保留「按代码池过滤」这一语义 */
    async fetchEtfSpotByCodes(codes: readonly string[]): Promise<EtfSpotItem[]> {
      source.calls.spotByCodes = (source.calls.spotByCodes ?? 0) + 1;
      source.lastSpotCodes = [...codes];
      if (source.failures.has('spotByCodes'))
        throw new UpstreamError('模拟：ETF 批量报价接口不可用');
      if (source.failures.has('spotByCodes:internal')) throw new Error('模拟：底层数据库错误');
      const wanted = new Set(codes);
      return source.spot.filter((item) => wanted.has(item.code));
    },

    async fetchSinaEtfSpot(): Promise<EtfSpotItem[]> {
      source.calls.sinaSpot = (source.calls.sinaSpot ?? 0) + 1;
      if (source.failures.has('sinaSpot')) throw new UpstreamError('模拟：备用行情渠道不可用');
      if (source.failures.has('sinaSpot:internal')) throw new Error('模拟：底层数据库错误');
      return source.sinaSpot;
    },

    async fetchEtfProfiles(): Promise<RawEtfProfile[]> {
      source.calls.profiles = (source.calls.profiles ?? 0) + 1;
      if (source.failures.has('profiles')) throw new UpstreamError('模拟：ETF 目录接口不可用');
      return source.profiles;
    },

    async fetchFundCatalog(): Promise<FundCatalogEntry[]> {
      source.calls.fundCatalog = (source.calls.fundCatalog ?? 0) + 1;
      if (source.failures.has('fundCatalog'))
        throw new UpstreamError('模拟：全量基金表（接口 E）不可用');
      return source.feederCatalog;
    },

    /**
     * 逐只反查的替身：复用**真实编排**（`fetchFeederTargets`），只把单只查询换成查表。
     * 这样并发/空/失败分流的逻辑由 `sources` 的单测保证，这里只需保证数据形状。
     */
    async fetchFeederTargets(
      codes: readonly string[],
      options?: { onProgress?: (done: number, total: number) => void },
    ): Promise<FeederScanResult> {
      source.calls.feeders = (source.calls.feeders ?? 0) + 1;
      source.lastFeederCodes = [...codes];
      if (source.failures.has('feeders')) throw new UpstreamError('模拟：联接基金反查不可用');
      return fetchFeederTargets(neverClient, codes, {
        concurrency: 4,
        fetchOne: async (code) => {
          if (source.failures.has(`feeder:${code}`)) {
            throw new UpstreamError(`模拟：${code} 反查失败`);
          }
          return source.feederTargets.get(code) ?? null;
        },
        ...(options?.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      });
    },

    async fetchFundProfile(code: string): Promise<FundProfileData | null> {
      source.calls.fundProfile = (source.calls.fundProfile ?? 0) + 1;
      if (source.failures.has('fundProfile')) throw new UpstreamError('模拟：基金概况接口不可用');
      if (source.detail === null) return null;
      return { ...source.detail, code };
    },

    /**
     * 区间涨幅批量抓取的替身：复用**真实编排**（`fetchPeriodIncrements`），
     * 单只查询换成查表 —— 并发/失败分流由 sources 的单测保证，这里只保证数据形状。
     */
    async fetchPeriodIncreaseBatch(
      codes: readonly string[],
      options?: { onProgress?: (done: number, total: number) => void },
    ) {
      source.calls.periods = (source.calls.periods ?? 0) + 1;
      source.lastPeriodCodes = [...codes];
      if (source.failures.has('periods')) throw new UpstreamError('模拟：区间涨幅接口不可用');
      return fetchPeriodIncrements(neverClient, codes, {
        concurrency: 4,
        fetchOne: async (code) => {
          if (source.failures.has(`period:${code}`)) {
            throw new UpstreamError(`模拟：${code} 区间涨幅抓取失败`);
          }
          return source.periods.get(code) ?? etfPeriodIncreaseSample();
        },
        ...(options?.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      });
    },
  };

  return source;
}
