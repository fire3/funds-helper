import { describe, expect, it } from 'vitest';
import { FX_INTERVAL_KEYS, FX_RANGE_KEYS } from '../fx/index.ts';
import {
  getIndexDefinition,
  groupRegistryByRegion,
  INDEX_CROSS_SOURCE_DRIFT,
  INDEX_DEFAULT_CODE,
  INDEX_DEFAULT_RANGE,
  INDEX_INTERVAL_KEYS,
  INDEX_INTERVAL_LABELS,
  INDEX_MAX_CHART_POINTS,
  INDEX_RANGE_KEYS,
  INDEX_RANGE_LABELS,
  INDEX_REGION_KEYS,
  INDEX_REGION_LABELS,
  INDEX_REGISTRY,
} from './index.ts';

/**
 * 注册表是本工具最核心的资产（静态符号映射表），这些断言是**调研结论的护栏**：
 * 任何一条被打破，都说明有人在没有对照 `global-index-data-sources.md` 覆盖矩阵的情况下改了表。
 */
describe('INDEX_REGISTRY —— 国际指数符号映射表', () => {
  it('key 全表唯一且都是大写字母/数字，可安全用作 URL 参数与主键', () => {
    const keys = INDEX_REGISTRY.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[A-Z0-9]+$/);
    expect(INDEX_REGISTRY.length).toBeGreaterThanOrEqual(20);
  });

  it('每个指数都有中文名、合法地区、原生币种与交易所时区', () => {
    for (const entry of INDEX_REGISTRY) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(INDEX_REGION_KEYS).toContain(entry.region);
      expect(entry.currency).toMatch(/^[A-Z]{3}$/);
      expect(entry.timeZone).toContain('/');
    }
  });

  it('Yahoo（主源）覆盖全部指数 —— 这是「只靠 Yahoo 也能撑起全表」的依据', () => {
    for (const entry of INDEX_REGISTRY) expect(entry.yahoo.length).toBeGreaterThan(0);
  });

  it('东财恰好缺 4 个指数（2026-09-27 clist 实测勘误：纳指100/罗素/VIX/恒生科技）', () => {
    const missing = INDEX_REGISTRY.filter((entry) => entry.em === null).map((entry) => entry.key);
    // ⚠ 旧结论里的 HSCE/TSX 是代码猜错（100.HSCE/100.GSPTSE 不存在）：
    // 正确代码 100.HSCEI/100.TSX 已由 akshare cons 表发现、clist 单请求实测返回
    expect(missing.sort()).toEqual(['HSTECH', 'NDX', 'RUT', 'VIX']);
    expect(getIndexDefinition('HSCE')?.em).toBe('100.HSCEI');
    expect(getIndexDefinition('TSX')?.em).toBe('100.TSX');
    // 其余必须都有东财代码，且统一在 market=100
    for (const entry of INDEX_REGISTRY) {
      if (entry.em !== null) expect(entry.em).toMatch(/^100\.[A-Z0-9]+$/);
    }
  });

  it('新浪 gi 日线恰好缺美股与恒指系 9 个（2026-09-27 实测 not found）', () => {
    const missing = INDEX_REGISTRY.filter((entry) => entry.sina === null).map((entry) => entry.key);
    expect(missing.sort()).toEqual([
      'DJI',
      'HSCE',
      'HSI',
      'HSTECH',
      'IXIC',
      'NDX',
      'RUT',
      'SPX',
      'VIX',
    ]);
    // 新浪符号是自家体系（UKX/NKY/TWJQ…），与 Yahoo/东财都不同
    for (const entry of INDEX_REGISTRY) {
      if (entry.sina !== null) expect(entry.sina).toMatch(/^[A-Z0-9]+$/);
    }
    // 关键映射抽查（错一个就会静默缺数据）
    expect(getIndexDefinition('FTSE')?.sina).toBe('UKX');
    expect(getIndexDefinition('N225')?.sina).toBe('NKY');
    expect(getIndexDefinition('JKSE')?.sina).toBe('JCI');
    expect(getIndexDefinition('SMI')?.sina).toBe('SWI20');
    expect(getIndexDefinition('NZ50')?.sina).toBe('NZ250');
  });

  it('每个字段都齐全（sina 是 2026-09-27 新增的第四源字段，漏了会 TypeError）', () => {
    for (const entry of INDEX_REGISTRY) {
      expect(typeof entry.sina === 'string' || entry.sina === null).toBe(true);
    }
    // 2026-09-27 扩充后：22 → 28（新增斯托克50/瑞士SMI/意大利MIB/西班牙IBEX/荷兰AEX/新西兰NZX50）
    expect(INDEX_REGISTRY.length).toBeGreaterThanOrEqual(28);
    expect(
      INDEX_REGISTRY.filter((entry) => entry.region === 'europe').length,
    ).toBeGreaterThanOrEqual(8);
  });

  it('新指数的四源代码都在（任一上游代码缺失都会静默缺数据）', () => {
    for (const key of ['STOXX50', 'SMI', 'MIB', 'IBEX', 'AEX', 'NZ50']) {
      const def = getIndexDefinition(key);
      expect(def, key).toBeDefined();
      expect(def?.yahoo.length, key).toBeGreaterThan(0); // 主源必须有
      expect(def?.em, key).toMatch(/^100\./); // 新指数必须三源齐备才收录
      expect(def?.sina, key).toBeTruthy();
      expect(def?.tencent, key).toBeNull(); // 腾讯只覆盖美/港 5 个
    }
    // 意大利 MIB 的 Yahoo 符号是 MIL 交易所原生符号（^FTMIB 实测无数据）
    expect(getIndexDefinition('MIB')?.yahoo).toBe('FTSEMIB.MI');
  });

  it('腾讯应急源恰好覆盖美/港 5 个（2026-09-26 实测：其余市场全部无代码）', () => {
    const covered = INDEX_REGISTRY.filter((entry) => entry.tencent !== null).map(
      (entry) => entry.key,
    );
    expect(covered.sort()).toEqual(['DJI', 'HSI', 'IXIC', 'NDX', 'SPX']);
    // 腾讯代码是市场前缀式（us/hk），与 Yahoo/东财都不同
    for (const entry of INDEX_REGISTRY) {
      if (entry.tencent !== null) expect(entry.tencent).toMatch(/^(us|hk)[A-Z]+$/i);
    }
  });

  it('东财 100.NDX 登记在「纳斯达克综合」而不是「纳斯达克100」（同名陷阱）', () => {
    expect(getIndexDefinition('IXIC')?.em).toBe('100.NDX');
    expect(getIndexDefinition('NDX')?.em).toBeNull();
    // 纳指 100 的 Yahoo 符号是 ^NDX，与东财的 NDX 代码不同义
    expect(getIndexDefinition('NDX')?.yahoo).toBe('^NDX');
    expect(getIndexDefinition('IXIC')?.yahoo).toBe('^IXIC');
  });

  it('恒生科技用 HSTECH.HK 而不是 ^HSTECH（后者实测 404）', () => {
    expect(getIndexDefinition('HSTECH')?.yahoo).toBe('HSTECH.HK');
  });

  it('默认指数存在，且属于美国地区', () => {
    const def = getIndexDefinition(INDEX_DEFAULT_CODE);
    expect(def?.name).toBe('标普500');
    expect(def?.region).toBe('us');
  });

  it('按地区分组不丢不重', () => {
    const groups = groupRegistryByRegion();
    const flattened = [...groups.values()].flat().map((entry) => entry.key);
    expect(flattened.sort()).toEqual(INDEX_REGISTRY.map((entry) => entry.key).sort());
    expect([...groups.keys()].sort()).toEqual([...INDEX_REGION_KEYS].sort());
  });
});

describe('区间常量 —— 与 fx 同取值（服务端复用 fx 序列函数的编译期前提）', () => {
  it('展示区间与统计区间的字面量与 FX 完全一致', () => {
    expect([...INDEX_RANGE_KEYS]).toEqual([...FX_RANGE_KEYS]);
    expect([...INDEX_INTERVAL_KEYS]).toEqual([...FX_INTERVAL_KEYS]);
  });

  it('标签、默认值与护栏常量齐全', () => {
    for (const key of INDEX_RANGE_KEYS) expect(INDEX_RANGE_LABELS[key]).toBeTruthy();
    for (const key of INDEX_INTERVAL_KEYS) expect(INDEX_INTERVAL_LABELS[key]).toBeTruthy();
    expect(INDEX_RANGE_KEYS).toContain(INDEX_DEFAULT_RANGE);
    expect(INDEX_MAX_CHART_POINTS).toBeGreaterThanOrEqual(1000);
    expect(INDEX_CROSS_SOURCE_DRIFT).toBeGreaterThan(0);
    expect(INDEX_CROSS_SOURCE_DRIFT).toBeLessThan(0.02);
  });

  it('每个地区都有展示标签', () => {
    for (const region of INDEX_REGION_KEYS) expect(INDEX_REGION_LABELS[region]).toBeTruthy();
  });
});
