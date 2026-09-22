import {
  ETF_CATEGORIES,
  ETF_MARKETS,
  ETF_PREMIUM_LEVELS,
  type EtfCategory,
  type EtfMarket,
  type EtfPremiumLevel,
  type EtfStatRecord,
} from './model.ts';
import { describePremium } from './premium.ts';

/**
 * 汇总统计（纯函数）。
 *
 * 「汇总展示」是本工具的主命题，因此聚合放在 `core` 而不是服务层：
 * 服务端只负责取数与拼接，口径与文案都在这里，服务端测试与前端面板可以断言同一份结果。
 */

export interface EtfCategoryStat {
  category: EtfCategory;
  count: number;
  /** 规模合计（元）；缺失规模按 0 计 */
  scale: number;
  amount: number;
}

export interface EtfMarketStat {
  market: EtfMarket;
  count: number;
  scale: number;
}

export interface EtfPremiumExtreme {
  code: string;
  name: string;
  rate: number;
}

export interface EtfPremiumStats {
  /** 五档计数（平价 / 溢价 / 高溢价 …），口径与列表徽标完全一致 */
  counts: Record<EtfPremiumLevel, number>;
  /** 无折溢价数据的数量（停牌、未上市） */
  unknown: number;
  maxPremium: EtfPremiumExtreme | null;
  maxDiscount: EtfPremiumExtreme | null;
}

export interface EtfNameValue {
  code: string;
  name: string;
  value: number;
}

export interface EtfExtremes {
  largest: EtfNameValue | null;
  mostActive: EtfNameValue | null;
  bestChange: EtfNameValue | null;
  worstChange: EtfNameValue | null;
}

/** 覆盖率：目录里有、但没有场内行情的新基金数量 */
export interface EtfCoverage {
  spot: number;
  profile: number;
  unlisted: number;
}

export interface EtfStats {
  total: number;
  totalScale: number;
  totalAmount: number;
  byCategory: EtfCategoryStat[];
  byMarket: EtfMarketStat[];
  premium: EtfPremiumStats;
  extremes: EtfExtremes;
  coverage: EtfCoverage;
}

function emptyPremiumCounts(): Record<EtfPremiumLevel, number> {
  return {
    [ETF_PREMIUM_LEVELS.HighPremium]: 0,
    [ETF_PREMIUM_LEVELS.Premium]: 0,
    [ETF_PREMIUM_LEVELS.Flat]: 0,
    [ETF_PREMIUM_LEVELS.Discount]: 0,
    [ETF_PREMIUM_LEVELS.HighDiscount]: 0,
  };
}

/** 找极值：`better` 返回 true 表示候选优于当前最佳；null 值不参与 */
function pick<T extends EtfStatRecord>(
  records: readonly T[],
  value: (record: T) => number | null,
  better: (candidate: number, best: number) => boolean,
): EtfNameValue | null {
  let best: { code: string; name: string; value: number } | null = null;
  for (const record of records) {
    const candidate = value(record);
    if (candidate === null || !Number.isFinite(candidate)) continue;
    if (best === null || better(candidate, best.value)) {
      best = { code: record.code, name: record.name, value: candidate };
    }
  }
  return best;
}

export function aggregateEtfStats(
  records: readonly EtfStatRecord[],
  coverage: EtfCoverage,
): EtfStats {
  const categoryMap = new Map<EtfCategory, EtfCategoryStat>(
    ETF_CATEGORIES.map((category) => [category, { category, count: 0, scale: 0, amount: 0 }]),
  );
  const marketMap = new Map<EtfMarket, EtfMarketStat>(
    Object.values(ETF_MARKETS).map((market) => [market, { market, count: 0, scale: 0 }]),
  );
  const premium = emptyPremiumCounts();

  let totalScale = 0;
  let totalAmount = 0;
  let premiumUnknown = 0;

  for (const record of records) {
    const scale = record.scale ?? 0;
    const amount = record.amount ?? 0;
    totalScale += scale;
    totalAmount += amount;

    const category = categoryMap.get(record.category);
    if (category) {
      category.count += 1;
      category.scale += scale;
      category.amount += amount;
    }

    const market = marketMap.get(record.market);
    if (market) {
      market.count += 1;
      market.scale += scale;
    }

    // 与列表徽标同源：用 describePremium 判档，避免「徽标说溢价、统计说高溢价」
    const info = describePremium(record.premiumRate);
    if (info.level === '未知') premiumUnknown += 1;
    else premium[info.level] += 1;
  }

  const pickPremium = (
    better: (candidate: number, best: number) => boolean,
  ): EtfPremiumExtreme | null => {
    const best = pick(records, (record) => record.premiumRate, better);
    return best === null ? null : { code: best.code, name: best.name, rate: best.value };
  };
  const maxPremium = pickPremium((candidate, best) => candidate > best);
  const maxDiscount = pickPremium((candidate, best) => candidate < best);

  return {
    total: records.length,
    totalScale,
    totalAmount,
    // 只保留有数据的分类（空分类进面板只会是噪声）
    byCategory: [...categoryMap.values()].filter((item) => item.count > 0),
    byMarket: [...marketMap.values()].filter((item) => item.count > 0),
    premium: {
      counts: premium,
      unknown: premiumUnknown,
      // 「最大溢价」为正才算溢价；全部折价时该榜单为空
      maxPremium: maxPremium !== null && maxPremium.rate > 0 ? maxPremium : null,
      maxDiscount: maxDiscount !== null && maxDiscount.rate < 0 ? maxDiscount : null,
    },
    extremes: {
      largest: pick(
        records,
        (record) => record.scale,
        (candidate, best) => candidate > best,
      ),
      mostActive: pick(
        records,
        (record) => record.amount,
        (candidate, best) => candidate > best,
      ),
      bestChange: pick(
        records,
        (record) => record.changePct,
        (candidate, best) => candidate > best,
      ),
      worstChange: pick(
        records,
        (record) => record.changePct,
        (candidate, best) => candidate < best,
      ),
    },
    coverage,
  };
}
