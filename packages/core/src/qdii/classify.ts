/**
 * QDII 双维度归类（地区/市场 × 主题）。
 *
 * 为什么是两个维度：`景顺长城全球半导体芯片`、`易方达标普生物科技` 这类基金同时带
 * 「地区」与「主题」两个属性。单层分类必须二选一，会丢掉一半信息 ——
 * 放进「半导体」就丢了美国属性，放进「美国」就丢了半导体属性。
 * 两个维度各自独立筛选，取交集即得精确结果。
 *
 * 规则基于 **735 只真实 QDII 基金名称** 的实测归纳（2026-09-14）。
 * 规则是**有序表，第一个匹配生效** —— 顺序即优先级，越具体的指数越靠前。
 */

type Rule = readonly [label: string, pattern: RegExp];

export const FALLBACK_REGION = '全球';
export const FALLBACK_THEME = '宽基指数';

/**
 * 地区/市场（24 类）。
 * 顺序敏感：`纳斯达克100` 必须先于 `纳斯达克`，`恒生科技` 必须先于 `恒生指数/港股`；
 * 兜底规则必须在最后。
 */
export const REGION_RULES: readonly Rule[] = [
  ['纳斯达克100', /纳斯达克100|纳指100/],
  ['纳斯达克', /纳斯达克|纳指/],
  ['标普500', /标普500/],
  ['美国', /标普|道琼斯|美国|罗素/],
  ['日本', /日经|日本|东证/],
  ['德国', /德国|DAX/],
  ['法国', /法国|CAC/],
  ['欧洲', /欧洲|欧元区|英国|富时/],
  ['越南', /越南/],
  ['印度', /印度/],
  ['巴西', /巴西|拉美/],
  ['沙特', /沙特|中东/],
  ['中韩', /中韩|韩国/],
  ['中概互联', /中概|海外互联网|中国互联网|海外中国|中国海外|港美|中美/],
  ['恒生科技', /恒生科技|香港科技|港股科技/],
  ['恒生互联网', /恒生互联网/],
  ['恒生医药', /恒生医药|恒生医疗|恒生生物|港股创新药|恒生创新药/],
  ['恒生消费', /恒生消费/],
  ['恒生国企/H股', /恒生国企|恒生中国企业|H股|港股国企|恒生央企|恒生红利|港股通红利|港股通金融/],
  ['恒生指数/港股', /恒生|香港|港股|大中华/],
  ['亚太', /亚太|亚洲|东南亚/],
  ['新兴市场', /新兴市场/],
  ['中国', /中国|境内/],
  [FALLBACK_REGION, /./],
];

/**
 * 主题（14 类）。
 *
 * 注意：QDII ETF 简称常把**公司名放在主题之后**（`恒生科技富国`、`纳指嘉实`、
 * `标普油气富时`），因此 `富国`/`嘉实`/`景顺` 等公司名不能作为分类依据，
 * 主题必须靠**指数名**识别。
 */
export const THEME_RULES: readonly Rule[] = [
  ['半导体', /半导体|芯片/],
  ['医药生物', /生物科技|生物医药|医药|医疗|健康|创新药/],
  ['科技互联网', /信息科技|科技|互联网|移动互联|软件|数字/],
  ['消费', /消费/],
  ['能源', /石油|油气|能源|天然气|原油|资源/],
  ['贵金属/商品', /黄金|贵金属|商品|抗通胀|通胀/],
  ['房地产/REITs', /房地产|REITs|不动产|房托|REIT/],
  ['债券', /债|票息|高收益|收益债券/],
  ['汽车', /汽车/],
  ['教育', /教育/],
  ['金融', /金融|银行|券商|保险/],
  ['红利/国企', /红利|央企|国企|价值|股息/],
  [
    '综合配置',
    /配置|精选|成长|新经济|优质|稳健|多元|中小盘|龙头|领导企业|发现|产业升级|新时代|策略/,
  ],
  [FALLBACK_THEME, /./],
];

/** 筛选栏的展示顺序（其余按数量降序追加） */
export const FEATURED_REGIONS: readonly string[] = [
  '纳斯达克100',
  '纳斯达克',
  '标普500',
  '美国',
  '日本',
  '德国',
  '恒生科技',
  '恒生互联网',
  '中概互联',
  '恒生指数/港股',
  '恒生国企/H股',
  '恒生医药',
  '恒生消费',
  '亚太',
  '新兴市场',
  '越南',
  '印度',
  '沙特',
  '欧洲',
  '中韩',
  '中国',
  FALLBACK_REGION,
];

export const FEATURED_THEMES: readonly string[] = [
  '半导体',
  '医药生物',
  '科技互联网',
  '消费',
  '能源',
  '贵金属/商品',
  '房地产/REITs',
  '债券',
  '金融',
  '红利/国企',
  '汽车',
  '教育',
  '综合配置',
  FALLBACK_THEME,
];

function firstMatch(rules: readonly Rule[], name: string, fallback: string): string {
  for (const [label, pattern] of rules) {
    if (pattern.test(name)) return label;
  }
  return fallback;
}

export function classifyRegion(name: string): string {
  return firstMatch(REGION_RULES, name, FALLBACK_REGION);
}

export function classifyTheme(name: string): string {
  return firstMatch(THEME_RULES, name, FALLBACK_THEME);
}

export function classify(name: string): { region: string; theme: string } {
  return { region: classifyRegion(name), theme: classifyTheme(name) };
}

export interface CoverageResult {
  total: number;
  regions: Map<string, number>;
  themes: Map<string, number>;
  /** 落入兜底类的比例，用于「规则是否失效」的回归护栏 */
  fallbackRegionRatio: number;
  fallbackThemeRatio: number;
}

/** 统计分类覆盖情况，用于回归检查规则是否失效 */
export function coverage(names: readonly string[]): CoverageResult {
  const regions = new Map<string, number>();
  const themes = new Map<string, number>();
  let fallbackRegion = 0;
  let fallbackTheme = 0;

  for (const name of names) {
    const { region, theme } = classify(name);
    regions.set(region, (regions.get(region) ?? 0) + 1);
    themes.set(theme, (themes.get(theme) ?? 0) + 1);
    if (region === FALLBACK_REGION) fallbackRegion += 1;
    if (theme === FALLBACK_THEME) fallbackTheme += 1;
  }

  const total = names.length;
  return {
    total,
    regions,
    themes,
    fallbackRegionRatio: total === 0 ? 0 : fallbackRegion / total,
    fallbackThemeRatio: total === 0 ? 0 : fallbackTheme / total,
  };
}

/** 分类计数，featured 中的按预设顺序置前，其余按数量降序 */
export function orderedCounts(
  records: readonly { region: string; theme: string }[],
  key: 'region' | 'theme',
  featured: readonly string[],
): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const value = record[key];
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const ordered: string[] = featured.filter((name) => counts.has(name));
  const rest = [...counts.entries()]
    .filter(([name]) => !ordered.includes(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));

  return [
    ...ordered.map((name) => ({ name, count: counts.get(name) ?? 0 })),
    ...rest.map(([name, count]) => ({ name, count })),
  ];
}
