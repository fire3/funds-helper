import {
  EMPTY_ETF_FLAGS,
  type EtfCategory,
  type EtfClassification,
  type EtfFlags,
} from './model.ts';

/**
 * ETF 分类判定。
 *
 * 两条路径：
 * 1. **上游标志位优先**（接口 B 的 `IS_*ETF`）：六类互斥 + 风格叠加，实测可靠；
 * 2. **名称回退**（接口 B 不可用时）：只按名称关键词判定，宁可粗一点也不要假精度。
 */

/**
 * 分类优先级：`货币 > 债券 > 商品 > 跨境 > 风格 > 宽基 > 行业主题`。
 *
 * 「风格」排在「宽基」之前是有意的：`红利低波ETF` / `大盘价值ETF` 同时命中
 * `IS_FGETF` 与 `IS_KJETF`（实测 42 行），按「风格」找它们比按「宽基」更符合直觉。
 */
export function classifyEtf(flags: EtfFlags): EtfClassification {
  const category: EtfCategory = flags.money
    ? '货币'
    : flags.bond
      ? '债券'
      : flags.commodity
        ? '商品'
        : flags.crossBorder
          ? '跨境'
          : flags.style
            ? '风格'
            : flags.broad
              ? '宽基'
              : flags.industry
                ? '行业主题'
                : '宽基';
  return { category, source: 'upstream' };
}

/** 全 false 的标志位（接口 B 缺失时用来触发名称回退） */
export function hasNoEtfFlags(flags: EtfFlags): boolean {
  return (Object.keys(EMPTY_ETF_FLAGS) as (keyof EtfFlags)[]).every((key) => !flags[key]);
}

/**
 * 名称回退规则（顺序敏感，先判「资产/地域」再判「宽基/行业主题」）。
 *
 * 与 QDII 的 `classify` 不同，这里**不猜行业主题**：名称里没有宽基关键词就归入
 * 「行业主题」是 ETF 市场的实际分布（行业主题占一半以上），而不是猜测。
 * 但「风格」不参与回退 —— 名称里没有可靠线索。
 */
const CROSS_BORDER_KEYWORDS = [
  '跨境',
  '海外',
  '港股',
  '恒生',
  '纳指',
  '纳斯达克',
  '标普',
  '日经',
  '德国',
  '法国',
  '美国',
  '中概',
  '恒指',
];
const BOND_KEYWORDS = ['债', '国债', '信用债', '可转债'];
const COMMODITY_KEYWORDS = ['黄金', '金ETF', '豆粕', '有色', '能源化工', '原油', '白银', '商品'];
const MONEY_KEYWORDS = ['货币', '添益', '快线', '日日鑫', '保证金'];
const BROAD_KEYWORDS = [
  '沪深300',
  '中证500',
  '中证1000',
  '中证2000',
  '上证50',
  '上证180',
  '深证100',
  '创业板',
  '科创50',
  '科创创业',
  '中证A50',
  '中证A500',
  'A500',
  'A50',
  '北证50',
  '中证A股',
  '全指',
  '深证50',
  '创业200',
  '富时中国',
];

function includesAny(name: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => name.includes(keyword));
}

export function classifyEtfByName(name: string): EtfClassification {
  const category: EtfCategory = includesAny(name, MONEY_KEYWORDS)
    ? '货币'
    : includesAny(name, BOND_KEYWORDS)
      ? '债券'
      : includesAny(name, COMMODITY_KEYWORDS)
        ? '商品'
        : includesAny(name, CROSS_BORDER_KEYWORDS)
          ? '跨境'
          : includesAny(name, BROAD_KEYWORDS)
            ? '宽基'
            : '行业主题';
  return { category, source: 'name' };
}

/** 标志位全空 → 名称回退；否则按标志位分类 */
export function classifyEtfOrFallback(name: string, flags: EtfFlags): EtfClassification {
  return hasNoEtfFlags(flags) ? classifyEtfByName(name) : classifyEtf(flags);
}
