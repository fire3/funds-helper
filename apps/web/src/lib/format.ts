/** 展示层格式化。所有金额/百分比都走这里，避免各页面各写一套 */

/**
 * 涨跌配色：正 = 红、负 = 绿（A 股/公募基金的通行口径，与参考实现 `.pos` / `.neg` 一致）。
 *
 * 返回**完整字面量** class（不能拼接前缀），否则 Tailwind 扫描不到、样式不会生成。
 * 0 / 空值不着色。
 */
export function trendClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return '';
  return value > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400';
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatNumber(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return value.toFixed(digits);
}

export function formatScale(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return `${value.toFixed(2)} 亿`;
}

/**
 * 金额（元）→ 中文量级：`1.09 万亿` / `948.72 亿` / `3.53 亿` / `1200 万`。
 * ETF 的规模与成交额都是「元」为单位的原始值，展示时必须按量级换单位。
 */
export function formatYuan(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)} 万亿`;
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(0)} 万`;
  return value.toFixed(0);
}

const RELATIVE_UNITS: [limit: number, divisor: number, suffix: string][] = [
  [60, 1, '秒'],
  [3600, 60, '分钟'],
  [86_400, 3600, '小时'],
  [Number.POSITIVE_INFINITY, 86_400, '天'],
];

/** 「12 分钟前」这类相对时间，用于数据新鲜度提示 */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '未知';
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '未知';

  const seconds = Math.max(0, (now - timestamp) / 1000);
  for (const [limit, divisor, suffix] of RELATIVE_UNITS) {
    if (seconds < limit) return `${Math.floor(seconds / divisor)} ${suffix}前`;
  }
  return '很久以前';
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 溢价率语义：f402 负值代表溢价，界面统一展示成「溢价 X%」 */
export function formatPremium(premiumRate: number | null | undefined): {
  text: string;
  tone: 'premium' | 'discount';
} {
  if (premiumRate === null || premiumRate === undefined || !Number.isFinite(premiumRate)) {
    return { text: '--', tone: 'discount' };
  }
  return premiumRate >= 0
    ? { text: `溢价 ${premiumRate.toFixed(2)}%`, tone: 'premium' }
    : { text: `折价 ${Math.abs(premiumRate).toFixed(2)}%`, tone: 'discount' };
}
