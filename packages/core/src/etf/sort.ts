import { ETF_CATEGORIES } from './model.ts';

/**
 * ETF 列表排序（纯函数，前端直接复用；空值恒排最后）。
 *
 * 排序键与列表表格的**列一一对应**（见 `apps/web/src/tools/etf/FundTable.tsx`）：
 * 点表头 = 选键 + 切方向，所以键只描述「按哪一列」，升/降由 `EtfSortDir` 单独表达，
 * 二者都写进 URL（`?sort=&dir=`），链接分享后排序结果一致。
 *
 * `premium` / `discount` 是同一列（折溢价）的两个**预设方向**，保留给榜单等
 * 「不需要方向状态」的调用方（`panels.tsx` 的溢价最高 / 折价最深）。
 */
export const ETF_SORT_KEYS = [
  'code',
  'name',
  'category',
  'index',
  'feeder',
  'price',
  'changePct',
  'premium',
  'discount',
  'amount',
  'turnover',
  'scale',
  'ret6m',
  'ret1y',
  'ret3y',
  'listingDate',
] as const;
export type EtfSortKey = (typeof ETF_SORT_KEYS)[number];

export type EtfSortDir = 'asc' | 'desc';

/** 中文列名（方向中性：方向由 `EtfSortDir` / 表头箭头表达） */
export const ETF_SORT_LABELS: Record<EtfSortKey, string> = {
  code: '代码',
  name: '简称',
  category: '分类',
  index: '跟踪指数',
  feeder: '场外联接',
  price: '最新价',
  changePct: '涨跌幅',
  premium: '折溢价',
  discount: '折溢价',
  amount: '成交额',
  turnover: '换手',
  scale: '规模',
  ret6m: '近6月',
  ret1y: '近1年',
  ret3y: '近3年',
  listingDate: '上市日',
};

/**
 * 每个键的**自然方向** —— 第一次点到该列时用的方向：
 * 名称 / 代码 / 分类 / 跟踪指数正序，数值从大到小，上市日最新在前。
 */
export const ETF_SORT_NATURAL_DIR: Record<EtfSortKey, EtfSortDir> = {
  code: 'asc',
  name: 'asc',
  category: 'asc',
  index: 'asc',
  feeder: 'desc',
  price: 'desc',
  changePct: 'desc',
  premium: 'desc',
  discount: 'asc',
  amount: 'desc',
  turnover: 'desc',
  scale: 'desc',
  ret6m: 'desc',
  ret1y: 'desc',
  ret3y: 'desc',
  listingDate: 'desc',
};

export const ETF_DEFAULT_SORT: EtfSortKey = 'scale';

/** 排序只需这些字段，DTO 结构兼容即可复用 */
export interface EtfSortable {
  code: string;
  name: string;
  category: string;
  market: string;
  indexName: string | null;
  price: number | null;
  /** 只用条数（场外联接是独立反查快照，没查过 = 空数组） */
  feederFunds: readonly unknown[];
  scale: number | null;
  amount: number | null;
  premiumRate: number | null;
  changePct: number | null;
  ret6m: number | null;
  ret1y: number | null;
  ret3y: number | null;
  turnover: number | null;
  listingDate: string | null;
}

const CATEGORY_ORDER = new Map<string, number>(
  ETF_CATEGORIES.map((category, index) => [category, index]),
);

type SortKind = 'number' | 'text' | 'string';

interface SortSpec {
  /** 取排序值；`null` = 没数据（**两个方向都恒排最后**，不冒充 0 参与比较） */
  value: (row: EtfSortable) => number | string | null;
  kind: SortKind;
}

const SPECS: Record<EtfSortKey, SortSpec> = {
  code: { value: (row) => row.code, kind: 'string' },
  name: { value: (row) => row.name, kind: 'text' },
  // 分类按 ETF_CATEGORIES 的固有顺序（正序 = 宽基在前），映射成序号参与数值比较
  category: {
    value: (row) => CATEGORY_ORDER.get(row.category) ?? ETF_CATEGORIES.length,
    kind: 'number',
  },
  index: { value: (row) => row.indexName, kind: 'text' },
  feeder: { value: (row) => row.feederFunds.length, kind: 'number' },
  price: { value: (row) => row.price, kind: 'number' },
  changePct: { value: (row) => row.changePct, kind: 'number' },
  premium: { value: (row) => row.premiumRate, kind: 'number' },
  discount: { value: (row) => row.premiumRate, kind: 'number' },
  amount: { value: (row) => row.amount, kind: 'number' },
  turnover: { value: (row) => row.turnover, kind: 'number' },
  scale: { value: (row) => row.scale, kind: 'number' },
  ret6m: { value: (row) => row.ret6m, kind: 'number' },
  ret1y: { value: (row) => row.ret1y, kind: 'number' },
  ret3y: { value: (row) => row.ret3y, kind: 'number' },
  listingDate: { value: (row) => row.listingDate, kind: 'string' },
};

function byCode(a: EtfSortable, b: EtfSortable): number {
  return a.code.localeCompare(b.code);
}

function byScale(dir: EtfSortDir, a: EtfSortable, b: EtfSortable): number {
  const left = a.scale;
  const right = b.scale;
  if (left === null && right === null) return byCode(a, b);
  if (left === null) return 1;
  if (right === null) return -1;
  const diff = dir === 'asc' ? right - left : left - right;
  return diff || byCode(a, b);
}

/**
 * 并列时的兜底：保证同一批数据每次排序结果一致（稳定可复现）。
 * 分类列在同分类内按规模排（正序时从大到小，与既有口径一致）。
 */
function tieBreak(key: EtfSortKey, dir: EtfSortDir, a: EtfSortable, b: EtfSortable): number {
  if (key === 'category') return byScale(dir === 'asc' ? 'desc' : 'asc', a, b);
  return byCode(a, b);
}

function compareText(left: string, right: string, dir: EtfSortDir): number {
  const diff = left.localeCompare(right, 'zh-CN');
  return dir === 'asc' ? diff : -diff;
}

function compareString(left: string, right: string, dir: EtfSortDir): number {
  const diff = left < right ? -1 : left > right ? 1 : 0;
  return dir === 'asc' ? diff : -diff;
}

function comparator(key: EtfSortKey, dir: EtfSortDir) {
  const spec = SPECS[key];
  return (a: EtfSortable, b: EtfSortable): number => {
    const left = spec.value(a);
    const right = spec.value(b);
    if (left === null && right === null) return tieBreak(key, dir, a, b);
    // 空值恒排最后：升序时也不能让「没数据」冒到最前面
    if (left === null) return 1;
    if (right === null) return -1;

    let diff: number;
    if (spec.kind === 'number') {
      const l = left as number;
      const r = right as number;
      diff = dir === 'asc' ? l - r : r - l;
    } else if (spec.kind === 'text') {
      diff = compareText(left as string, right as string, dir);
    } else {
      diff = compareString(left as string, right as string, dir);
    }
    return diff === 0 ? tieBreak(key, dir, a, b) : diff;
  };
}

/**
 * @param dir 不传 = 该键的自然方向（点表头第一次点进去的方向），
 *   因此两参数调用与历史行为逐字一致。
 */
export function sortEtfs<T extends EtfSortable>(
  records: readonly T[],
  key: EtfSortKey,
  dir: EtfSortDir = ETF_SORT_NATURAL_DIR[key],
): T[] {
  return [...records].sort(comparator(key, dir));
}
