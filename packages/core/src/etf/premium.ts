import {
  ETF_PREMIUM_LEVELS,
  type EtfPremiumLevel,
  PREMIUM_FLAT_THRESHOLD,
  PREMIUM_HIGH_THRESHOLD,
} from './model.ts';

/**
 * 折溢价的口径统一在这里。
 *
 * 上游 `f402 = (净值 − 价格) / 净值 × 100`（**负值 = 溢价**），
 * 而中文语境里「溢价」必须是正数、且溢价是**风险**（立刻多付钱）。
 * 取反只做一次（这里），前端拿到的 `premiumRate` 永远是「正 = 溢价」。
 */
export function premiumRateFromDiscount(discountRate: number | null): number | null {
  return discountRate === null ? null : -discountRate;
}

export interface EtfPremiumInfo {
  /** 无数据时为 '未知' */
  level: EtfPremiumLevel | '未知';
  /** 可直接渲染的文案：`溢价 0.43%` / `折价 0.06%` / `—` */
  text: string;
  /** 仅在「高溢价」时给出的可执行提示，其余为 null */
  note: string | null;
}

function format(rate: number): string {
  return Math.abs(rate).toFixed(2);
}

export function describePremium(rate: number | null): EtfPremiumInfo {
  if (rate === null || !Number.isFinite(rate)) {
    return { level: '未知', text: '—', note: null };
  }

  const magnitude = Math.abs(rate);
  if (magnitude < PREMIUM_FLAT_THRESHOLD) {
    return { level: ETF_PREMIUM_LEVELS.Flat, text: `平价 ${format(rate)}%`, note: null };
  }

  if (rate > 0) {
    const level =
      magnitude >= PREMIUM_HIGH_THRESHOLD
        ? ETF_PREMIUM_LEVELS.HighPremium
        : ETF_PREMIUM_LEVELS.Premium;
    return {
      level,
      text: `溢价 ${format(rate)}%`,
      note:
        level === ETF_PREMIUM_LEVELS.HighPremium
          ? `场内价高于净值 ${format(rate)}%，此刻买入等于立刻多付这部分；可等折价、或改走场外联接基金`
          : null,
    };
  }

  const level =
    magnitude >= PREMIUM_HIGH_THRESHOLD
      ? ETF_PREMIUM_LEVELS.HighDiscount
      : ETF_PREMIUM_LEVELS.Discount;
  return { level, text: `折价 ${format(rate)}%`, note: null };
}
