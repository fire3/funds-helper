import { ETF_CATEGORIES } from './model.ts';

/** ETF 列表排序（纯函数，前端直接复用；空值恒排最后） */

export const ETF_SORT_KEYS = [
  'scale',
  'amount',
  'premium',
  'discount',
  'changePct',
  'turnover',
  'listingDate',
  'category',
  'code',
] as const;
export type EtfSortKey = (typeof ETF_SORT_KEYS)[number];

export const ETF_SORT_LABELS: Record<EtfSortKey, string> = {
  scale: '规模从大到小',
  amount: '成交额从大到小',
  premium: '溢价最高',
  discount: '折价最深',
  changePct: '涨幅从高到低',
  turnover: '换手率从高到低',
  listingDate: '最新上市',
  category: '按分类',
  code: '按代码',
};

export const ETF_DEFAULT_SORT: EtfSortKey = 'scale';

/** 排序只需这些字段，DTO 结构兼容即可复用 */
export interface EtfSortable {
  code: string;
  name: string;
  category: string;
  market: string;
  scale: number | null;
  amount: number | null;
  premiumRate: number | null;
  changePct: number | null;
  turnover: number | null;
  listingDate: string | null;
}

const CATEGORY_ORDER = new Map<string, number>(
  ETF_CATEGORIES.map((category, index) => [category, index]),
);

function byCode(a: EtfSortable, b: EtfSortable): number {
  return a.code.localeCompare(b.code);
}

/** 数值降序，null 恒排最后 */
function desc(key: 'scale' | 'amount' | 'premiumRate' | 'changePct' | 'turnover') {
  return (a: EtfSortable, b: EtfSortable): number => {
    const left = a[key];
    const right = b[key];
    if (left === null && right === null) return byCode(a, b);
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left || byCode(a, b);
  };
}

/** 数值升序，null 恒排最后 */
const asc =
  (key: 'premiumRate') =>
  (a: EtfSortable, b: EtfSortable): number => {
    const left = a[key];
    const right = b[key];
    if (left === null && right === null) return byCode(a, b);
    if (left === null) return 1;
    if (right === null) return -1;
    return left - right || byCode(a, b);
  };

const COMPARATORS: Record<EtfSortKey, (a: EtfSortable, b: EtfSortable) => number> = {
  scale: desc('scale'),
  amount: desc('amount'),
  premium: desc('premiumRate'),
  discount: asc('premiumRate'),
  changePct: desc('changePct'),
  turnover: desc('turnover'),
  listingDate: (a, b) => {
    if (a.listingDate === null && b.listingDate === null) return byCode(a, b);
    if (a.listingDate === null) return 1;
    if (b.listingDate === null) return -1;
    return b.listingDate.localeCompare(a.listingDate) || byCode(a, b);
  },
  category: (a, b) =>
    (CATEGORY_ORDER.get(a.category) ?? ETF_CATEGORIES.length) -
      (CATEGORY_ORDER.get(b.category) ?? ETF_CATEGORIES.length) || desc('scale')(a, b),
  code: byCode,
};

export function sortEtfs<T extends EtfSortable>(records: readonly T[], key: EtfSortKey): T[] {
  return [...records].sort(COMPARATORS[key]);
}
