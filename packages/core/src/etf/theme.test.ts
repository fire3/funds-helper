import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyEtf } from './classify.ts';
import type { EtfCategory, EtfFlags } from './model.ts';
import { classifyEtfTheme, themeCoverage } from './theme.ts';

describe('classifyEtfTheme —— 热点主题规则表', () => {
  const themeOf = (name: string, indexName: string | null, category: EtfCategory) =>
    classifyEtfTheme(name, indexName, category);

  it('商品/资源具体品种最先匹配（标普油气归油气，不归标普）', () => {
    expect(themeOf('标普油气ETF', '标普石油天然气上游', '跨境')).toBe('原油/油气');
    expect(themeOf('黄金ETF', '黄金现货', '商品')).toBe('黄金');
    expect(themeOf('豆粕ETF华夏', '大商所豆粕期货价格指数', '商品')).toBe('豆粕/农产品');
    expect(themeOf('有色金属ETF', '中证申万有色', '行业主题')).toBe('有色金属/稀土');
  });

  it('跨境区域按具体度排序：纳斯达克100 先于纳斯达克，标普500 先于标普', () => {
    expect(themeOf('纳指ETF国泰', '纳斯达克100', '跨境')).toBe('纳斯达克100');
    expect(themeOf('标普500ETF博时', '标普500', '跨境')).toBe('标普500');
    expect(themeOf('标普ETF', '标普100', '跨境')).toBe('标普');
    expect(themeOf('日经225ETF', '日经225', '跨境')).toBe('日本');
    expect(themeOf('越南ETF', 'VN30', '跨境')).toBe('越南');
  });

  it('港股细分先于「港股」兜底，且 A 股行业规则在跨境规则之后', () => {
    expect(themeOf('恒生科技ETF', '恒生科技', '跨境')).toBe('港股科技');
    expect(themeOf('恒生医药ETF', '恒生医疗保健', '跨境')).toBe('港股医药');
    expect(themeOf('港股通金融ETF', '港股通内地金融', '跨境')).toBe('港股金融/红利');
    expect(themeOf('恒生指数ETF', '恒生指数', '跨境')).toBe('港股');
    // A 股的医药不被跨境规则误伤
    expect(themeOf('医药ETF', '中证医药', '行业主题')).toBe('医药医疗');
  });

  it('境内行业按具体度排序：证券先于金融、创新药先于医药、光伏先于新能源', () => {
    expect(themeOf('证券ETF国泰', '证券公司', '行业主题')).toBe('证券');
    expect(themeOf('金融科技ETF', '金融科技', '行业主题')).toBe('金融');
    expect(themeOf('创新药ETF', '中证创新药', '行业主题')).toBe('创新药');
    expect(themeOf('医疗ETF', '中证医疗', '行业主题')).toBe('医药医疗');
    expect(themeOf('光伏ETF', '中证光伏产业', '行业主题')).toBe('光伏');
    expect(themeOf('新能源ETF', '中证新能源', '行业主题')).toBe('新能源');
    // 「能源」不能吞掉「新能源」
    expect(themeOf('能源ETF', '中证能源', '行业主题')).toBe('能源');
    expect(themeOf('煤炭ETF', '中证煤炭', '行业主题')).toBe('煤炭');
  });

  it('匹配文本 = 简称 + 跟踪指数名（简称看不出方向时靠指数名）', () => {
    expect(themeOf('信息技术ETF广发', '中证全指半导体', '行业主题')).toBe('半导体/芯片');
    // 指数名为空时只看简称
    expect(themeOf('半导体ETF', null, '行业主题')).toBe('半导体/芯片');
  });

  it('宽基细分按指数名识别，没写细分规则的兜底到分类', () => {
    expect(themeOf('沪深300ETF华泰柏瑞', '沪深300', '宽基')).toBe('沪深300');
    expect(themeOf('中证500ETF', '中证500', '宽基')).toBe('中证500');
    expect(themeOf('A500ETF', '中证A500', '宽基')).toBe('中证A500');
    expect(themeOf('科创50ETF', '科创50', '宽基')).toBe('科创');
    // 全指没有细分规则 → 分类兜底（注意「全指消费」这类指数名带行业词的会正确命中行业主题）
    expect(themeOf('中证全指ETF', '中证全指', '宽基')).toBe('宽基');
    expect(themeOf('全指消费ETF', '全指消费', '宽基')).toBe('消费');
    expect(themeOf('华宝添益ETF', null, '货币')).toBe('货币');
    expect(themeOf('国债ETF', '上证国债', '债券')).toBe('债券');
    expect(themeOf('红利低波ETF华泰柏瑞', '红利低波', '风格')).toBe('红利/股息');
  });

  it('新品种不命中任何规则时兜底到分类（而不是空串或抛错）', () => {
    expect(themeOf('某某未来产业ETF', '某某未来产业指数', '行业主题')).toBe('行业主题');
  });
});

describe('themeCoverage —— 真实名单的覆盖率护栏', () => {
  interface NameRow {
    c: string;
    n: string;
    i: string | null;
    /** 标志位位掩码：bit0 money, bit1 crossBorder, bit2 bond, bit3 commodity, bit4 broad, bit5 industry, bit6 style */
    f: number;
  }

  // 1678 只真实 ETF 全名单快照（接口 B fixture，见 name-list.json 的 note）—— 规则表失效时这里先红
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        '../../../sources/test/fixtures/eastmoney/etf-profile/name-list.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { count: number; rows: NameRow[] };

  const rows = fixture.rows.map((row) => {
    const flags: EtfFlags = {
      money: (row.f & 1) !== 0,
      crossBorder: (row.f & 2) !== 0,
      bond: (row.f & 4) !== 0,
      commodity: (row.f & 8) !== 0,
      broad: (row.f & 16) !== 0,
      industry: (row.f & 32) !== 0,
      style: (row.f & 64) !== 0,
    };
    // 标志位全空时与服务端一致：名称回退判定分类
    const noFlags = Object.values(flags).every((flag) => !flag);
    const { category } = noFlags ? { category: classifyByName(row.n) } : classifyEtf(flags);
    return {
      name: row.n,
      indexName: row.i,
      category,
    };
  });

  function classifyByName(name: string): EtfCategory {
    // 与 classify.ts 的名称回退口径一致（theme.test 不反向依赖 classify 的私有关键词表）
    if (/货币|添益|快线/.test(name)) return '货币';
    if (/债/.test(name)) return '债券';
    if (/黄金|豆粕|有色|原油|白银|商品/.test(name)) return '商品';
    if (/跨境|海外|港股|恒生|纳指|纳斯达克|标普|日经|德国|美国|中概|恒指/.test(name)) {
      return '跨境';
    }
    if (
      /沪深300|中证500|中证1000|中证2000|上证50|深证100|创业板|科创50|A500|A50|北证50/.test(name)
    ) {
      return '宽基';
    }
    return '行业主题';
  }

  const coverage = themeCoverage(rows);

  it('名单规模对得上（防止 fixture 路径/结构变化让护栏空跑）', () => {
    expect(coverage.total).toBeGreaterThan(1500);
  });

  it('兜底占比在可控范围（规则表仍然跟得上市场）', () => {
    // 实测口径：绝大多数 ETF 应命中规则表；兜底主要是货币/债券/无细分宽基
    expect(coverage.fallbackRatio).toBeLessThan(0.45);
  });

  it('「行业主题」兜底是重点监控对象（方向单元失灵会先出现在这里）', () => {
    const industryFallback = coverage.themes.get('行业主题') ?? 0;
    expect(industryFallback / coverage.total).toBeLessThan(0.15);
  });

  it('真实关键品种命中预期主题（快照断言）', () => {
    const byName = new Map(rows.map((row) => [row.name, row]));
    const themeOf = (name: string): string | undefined => {
      const row = byName.get(name);
      return row === undefined
        ? undefined
        : classifyEtfTheme(row.name, row.indexName, row.category);
    };

    expect(themeOf('沪深300ETF华泰柏瑞')).toBe('沪深300');
    expect(themeOf('证券ETF国泰')).toBe('证券');
    expect(themeOf('半导体ETF南方')).toBe('半导体/芯片');
    expect(themeOf('纳指ETF国泰')).toBe('纳斯达克100');
    expect(themeOf('标普500ETF博时')).toBe('标普500');
    expect(themeOf('豆粕ETF华夏')).toBe('豆粕/农产品');
    expect(themeOf('华宝添益ETF')).toBe('货币');
    expect(themeOf('红利低波ETF华泰柏瑞')).toBe('红利/股息');
    expect(themeOf('创业板ETF易方达')).toBe('创业板');
  });
});
