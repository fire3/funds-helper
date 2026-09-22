/**
 * 「全市场场内 ETF 行情」的**跨渠道归一化结构**。
 *
 * 默认源（新浪列表，见 `sina/etf-spot.ts`）只填其中一部分；可选源（东方财富 `clist`，
 * 见 `eastmoney/etf-spot.ts`）字段最全 —— 因此除代码/名称/交易所外**全部可空**。
 * 哪个渠道缺哪些字段由各 `fetchX` 的文档写明，**降级语义（要不要标注、要不要停用某个筛选）
 * 由服务层决定**，IO 层不做业务判断。
 */
export interface EtfSpotItem {
  code: string;
  name: string | null;
  /** 1 = 沪市，0 = 深市 */
  market: number | null;
  price: number | null;
  changePct: number | null;
  changeAmt: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  /** 振幅 %（可由（高−低）/昨收推导的渠道会补上） */
  amplitude: number | null;
  /** 换手率 % */
  turnover: number | null;
  volumeRatio: number | null;
  /** 成交量（手） */
  volume: number | null;
  /** 成交额（元） */
  amount: number | null;
  /** 场内规模（元） */
  scale: number | null;
  floatScale: number | null;
  /** 折溢价率的**上游原值**（东财 `f402`）：负值 = 溢价；没有该字段的渠道为 null */
  discountRate: number | null;
  /** 上市日期（YYYY-MM-DD） */
  listingDate: string | null;
  mainInflow: number | null;
  /** 行情时间戳（秒）；渠道不提供时为 null */
  quoteTs: number | null;
}

/** 行情渠道标识（落库 + 下发给前端；顺序与 shared 的 `ETF_SPOT_SOURCES` 一致） */
export const ETF_SPOT_SOURCE_IDS = ['sina', 'eastmoney'] as const;
export type EtfSpotSourceId = (typeof ETF_SPOT_SOURCE_IDS)[number];
