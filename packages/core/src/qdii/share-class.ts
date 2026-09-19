/**
 * 份额类别识别（A/C 选择用）。
 *
 * 同一只基金常有多个份额类别（人民币 A / 人民币 C / 美元 A …），
 * 代码与限额都不同。识别「同一基金的其它份额」靠把简称归一化成一个「家族键」：
 * 剥离括号内的限定词与结尾的类别字母。
 *
 *   `广发纳斯达克100ETF联接人民币(QDII)A` → `广发纳斯达克100ETF联接人民币`
 *   `广发纳斯达克100ETF联接人民币(QDII)C` → `广发纳斯达克100ETF联接人民币`
 *   `广发纳斯达克100ETF联接美元(QDII)A`   → `广发纳斯达克100ETF联接美元`
 *
 * 注意这是启发式规则：刻意保守，宁可少合并也不要把不同基金错并成一家。
 */

const QUALIFIER_TOKEN = 'QDII|LOF|FOF|REITs?|ETF|美元现汇|美元现钞|人民币|港币|港元|美元|[A-Z]';

/** 括号限定词，支持 `(QDII)`、`(人民币)`、`(QDII-LOF)` 这类复合写法 */
const PAREN_QUALIFIER = new RegExp(
  `[（(](?:${QUALIFIER_TOKEN})(?:[-–—·]?(?:${QUALIFIER_TOKEN}))*[)）]`,
  'g',
);

/**
 * 币种限定词。
 * 同一基金的美元/人民币份额属于**同一个份额家族** —— 用户选择 A/C 时需要
 * 把它们并列比较（渠道不售的美元份额由调用方排序时后置）。
 */
const CURRENCY_WORDS = /美元现汇|美元现钞|人民币|港币|港元|美元|现汇|现钞|美汇|美钞/g;

export function shareClassKey(name: string): string {
  return name
    .replace(PAREN_QUALIFIER, '')
    .replace(/[A-Z]$/, '')
    .replace(CURRENCY_WORDS, '')
    .replace(/[\s\-—－(（)）]/g, '')
    .trim();
}

/** 取名称结尾的份额类别字母（A/C/D/E/I/O…），无则 null */
export function shareClassLetter(name: string): string | null {
  const match = /([A-Z])$/.exec(name.trim());
  return match?.[1] ?? null;
}

export interface ShareClassLike {
  name: string;
}

/**
 * 找出与目标基金同属一个「份额家族」的其它记录。
 * 返回时把**同类（同币种）**的排在前面 —— 那才是用户真正会去比较的对象。
 */
export function findSiblingShareClasses<T extends ShareClassLike>(
  target: T,
  all: readonly T[],
  currencyOf: (item: T) => string,
  limit = 6,
): T[] {
  const key = shareClassKey(target.name);
  const targetCurrency = currencyOf(target);
  const siblings = all.filter((item) => item !== target && shareClassKey(item.name) === key);

  siblings.sort((a, b) => {
    const aSame = currencyOf(a) === targetCurrency ? 0 : 1;
    const bSame = currencyOf(b) === targetCurrency ? 0 : 1;
    return aSame - bSame;
  });

  return siblings.slice(0, limit);
}
