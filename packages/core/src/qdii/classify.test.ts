import { describe, expect, it } from 'vitest';
import {
  classify,
  classifyRegion,
  classifyTheme,
  coverage,
  FALLBACK_REGION,
  FALLBACK_THEME,
  orderedCounts,
  REGION_RULES,
  THEME_RULES,
} from './classify.ts';

describe('规则表结构', () => {
  it('兜底规则必须在最后，保证没有基金落空', () => {
    expect(REGION_RULES.at(-1)?.[0]).toBe(FALLBACK_REGION);
    expect(THEME_RULES.at(-1)?.[0]).toBe(FALLBACK_THEME);
  });

  it('标签不重复', () => {
    const regionLabels = REGION_RULES.map(([label]) => label);
    const themeLabels = THEME_RULES.map(([label]) => label);
    expect(new Set(regionLabels).size).toBe(regionLabels.length);
    expect(new Set(themeLabels).size).toBe(themeLabels.length);
  });
});

describe('地区维度 —— 规则顺序即优先级', () => {
  it('纳斯达克100 优先于纳斯达克（顺序写反会让纳指100 全部掉进宽泛桶）', () => {
    expect(classifyRegion('广发纳斯达克100ETF联接人民币(QDII)A')).toBe('纳斯达克100');
    expect(classifyRegion('华安纳斯达克100指数(QDII)')).toBe('纳斯达克100');
    expect(classifyRegion('纳指ETF国泰')).toBe('纳斯达克');
    expect(classifyRegion('华夏纳斯达克ETF')).toBe('纳斯达克');
  });

  it('标普500 必须与其它标普指数区分', () => {
    expect(classifyRegion('博时标普500ETF联接A')).toBe('标普500');
    expect(classifyRegion('易方达标普生物科技')).toBe('美国'); // 不是标普500
    expect(classifyRegion('标普油气ETF嘉实')).toBe('美国');
    expect(classifyRegion('标普消费ETF景顺')).toBe('美国');
  });

  it('恒生系列细分优先于泛港股', () => {
    expect(classifyRegion('恒生科技ETF富国')).toBe('恒生科技');
    expect(classifyRegion('恒生互联网科技业ETF')).toBe('恒生互联网');
    expect(classifyRegion('华夏恒生医药ETF')).toBe('恒生医药');
    expect(classifyRegion('恒生ETF易方达')).toBe('恒生指数/港股');
    expect(classifyRegion('恒生中国企业ETF')).toBe('恒生国企/H股');
  });

  it('公司名放在主题之后也不影响识别（QDII ETF 的命名习惯）', () => {
    expect(classifyRegion('恒生科技富国')).toBe('恒生科技');
    expect(classifyRegion('纳指嘉实')).toBe('纳斯达克');
    expect(classifyRegion('标普油气富时')).toBe('美国');
  });

  it('无单一市场限定的落兜底类', () => {
    expect(classifyRegion('某全球精选股票(QDII)')).toBe(FALLBACK_REGION);
  });
});

describe('主题维度', () => {
  it('半导体 / 芯片', () => {
    expect(classifyTheme('景顺长城全球半导体芯片股票')).toBe('半导体');
    expect(classifyTheme('华泰柏瑞中韩半导体ETF')).toBe('半导体');
  });

  it('医药生物', () => {
    expect(classifyTheme('易方达标普生物科技')).toBe('医药生物');
    expect(classifyTheme('华夏恒生医药ETF')).toBe('医药生物');
  });

  it('纯宽基落兜底类', () => {
    expect(classifyTheme('博时标普500ETF联接A')).toBe(FALLBACK_THEME);
    expect(classifyTheme('广发纳斯达克100ETF联接人民币(QDII)A')).toBe(FALLBACK_THEME);
  });
});

describe('双维度分离 —— 同一只基金各取所需', () => {
  it('广发道琼斯石油指数：地区判美国、主题判能源', () => {
    expect(classify('广发道琼斯石油指数')).toEqual({ region: '美国', theme: '能源' });
  });

  it('景顺长城全球半导体芯片：地区兜底、主题半导体', () => {
    expect(classify('景顺长城全球半导体芯片股票')).toEqual({
      region: FALLBACK_REGION,
      theme: '半导体',
    });
  });

  it('易方达标普生物科技：地区美国、主题医药生物（单层分类必然丢一半信息）', () => {
    expect(classify('易方达标普生物科技')).toEqual({ region: '美国', theme: '医药生物' });
  });
});

describe('coverage —— 规则失效的回归护栏', () => {
  it('统计总数与兜底比例', () => {
    const names = [
      '广发纳斯达克100ETF联接人民币(QDII)A',
      '易方达标普生物科技',
      '某全球精选股票(QDII)',
    ];
    const result = coverage(names);
    expect(result.total).toBe(3);
    expect(result.regions.get('纳斯达克100')).toBe(1);
    expect(result.regions.get('美国')).toBe(1);
    expect(result.fallbackRegionRatio).toBeCloseTo(1 / 3, 5);
  });

  it('空输入不除零', () => {
    const result = coverage([]);
    expect(result.fallbackRegionRatio).toBe(0);
    expect(result.fallbackThemeRatio).toBe(0);
  });
});

describe('orderedCounts', () => {
  it('featured 顺序置前，其余按数量降序', () => {
    const records = [
      { region: '美国', theme: '半导体' },
      { region: '美国', theme: '医药生物' },
      { region: '纳斯达克100', theme: '半导体' },
      { region: '印度', theme: '消费' },
      { region: '印度', theme: '消费' },
    ];
    const result = orderedCounts(records, 'region', ['纳斯达克100', '美国']);
    expect(result).toEqual([
      { name: '纳斯达克100', count: 1 },
      { name: '美国', count: 2 },
      { name: '印度', count: 2 },
    ]);
  });
});
