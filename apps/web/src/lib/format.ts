/** 展示层格式化。所有金额/百分比都走这里，避免各页面各写一套 */

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
