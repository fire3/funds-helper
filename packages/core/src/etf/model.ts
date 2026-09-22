/**
 * ETF 工具的领域模型（纯类型与字面量）。
 *
 * 取值字面量必须与 `@funds-helper/shared` 的传输契约保持一致 ——
 * `apps/server/src/contract.test.ts` 会逐项比对，防止两边漂移。
 */

/** ETF 分类。顺序 = 展示顺序（也是分类分布面板的顺序） */
export const ETF_CATEGORIES = ['宽基', '行业主题', '风格', '跨境', '债券', '商品', '货币'] as const;
export type EtfCategory = (typeof ETF_CATEGORIES)[number];

/** 上市交易所（上游 `f13`：1 = 沪市，0 = 深市） */
export const ETF_MARKETS = { Sh: '沪市', Sz: '深市' } as const;
export type EtfMarket = (typeof ETF_MARKETS)[keyof typeof ETF_MARKETS];

/**
 * 折溢价档位。
 *
 * ETF 的折溢价是**相对净值的偏离**，不是涨跌 —— 所以用中性色展示，
 * 只有「高溢价」才需要风险提示（溢价买入等于立刻多付）。
 */
export const ETF_PREMIUM_LEVELS = {
  HighPremium: '高溢价',
  Premium: '溢价',
  Flat: '平价',
  Discount: '折价',
  HighDiscount: '高折价',
} as const;
export type EtfPremiumLevel = (typeof ETF_PREMIUM_LEVELS)[keyof typeof ETF_PREMIUM_LEVELS];

/** |溢价率| < 0.1% 视为平价（买卖价差与净值精度都在这个量级） */
export const PREMIUM_FLAT_THRESHOLD = 0.1;
/** |溢价率| ≥ 1% 视为「高」—— 跨境 ETF 盘中常见，值得单独提示 */
export const PREMIUM_HIGH_THRESHOLD = 1;

/**
 * 上游目录（接口 B）的 ETF 类型标志位。
 *
 * 语义来自实测推断（`docs/design/etf-data-sources.md` §2.2）：
 * 前六个互斥（构成完整划分），`style`（风格）是与它们叠加的维度。
 */
export interface EtfFlags {
  /** IS_HBETF —— 货币 */
  money: boolean;
  /** IS_WPETF —— 跨境 */
  crossBorder: boolean;
  /** IS_ZQETF —— 债券 */
  bond: boolean;
  /** IS_SPETF —— 商品 */
  commodity: boolean;
  /** IS_KJETF —— 宽基 */
  broad: boolean;
  /** IS_HYETF —— 行业主题 */
  industry: boolean;
  /** IS_FGETF —— 风格（可与宽基/行业主题叠加） */
  style: boolean;
}

export const EMPTY_ETF_FLAGS: EtfFlags = {
  money: false,
  crossBorder: false,
  bond: false,
  commodity: false,
  broad: false,
  industry: false,
  style: false,
};

/** 分类结果的来源：上游标志位 / 名称回退 */
export type EtfCategorySource = 'upstream' | 'name';

export interface EtfClassification {
  category: EtfCategory;
  source: EtfCategorySource;
}

/**
 * 聚合统计所需的最小字段集。
 *
 * 刻意不依赖 `@funds-helper/shared` 的 DTO：`core` 不依赖传输层，
 * 服务端直接传 DTO（结构兼容）即可，测试也能用最小对象。
 */
export interface EtfStatRecord {
  code: string;
  name: string;
  category: EtfCategory;
  market: EtfMarket;
  scale: number | null;
  amount: number | null;
  premiumRate: number | null;
  changePct: number | null;
}
