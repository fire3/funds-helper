import {
  ETF_CATEGORIES as CORE_ETF_CATEGORIES,
  ETF_MARKETS as CORE_ETF_MARKETS,
  ETF_PREMIUM_LEVELS as CORE_ETF_PREMIUM_LEVELS,
  FX_DIRECTIONS as CORE_FX_DIRECTIONS,
  USD_KINDS as CORE_USD_KINDS,
  CURRENCY_VALUES,
  ETF_SORT_KEYS,
  FX_INTERVAL_KEYS,
  FX_RANGE_KEYS,
  PurchaseStatus,
  REDEEM_STATUS_VALUES,
} from '@funds-helper/core';
import {
  CURRENCIES,
  ETF_CATEGORIES,
  ETF_MARKETS,
  ETF_PREMIUM_LEVELS,
  ETF_SPOT_SOURCES,
  FX_INTERVALS,
  FX_RANGES,
  PURCHASE_STATUSES,
  REDEEM_STATUSES,
  FX_DIRECTIONS as SHARED_FX_DIRECTIONS,
  USD_KINDS as SHARED_USD_KINDS,
  TOOL_CATALOG,
} from '@funds-helper/shared';
import { ETF_SPOT_SOURCE_IDS } from '@funds-helper/sources';
import { describe, expect, it } from 'vitest';
import { createServerTools } from './tools/registry.ts';

/**
 * 口径一致性护栏。
 *
 * core 定义**领域模型**、shared 定义**传输契约**，两者各自维护取值字面量。
 * 这个测试确保它们不漂移 —— 一旦有人只改了一边，这里立刻失败。
 */
describe('core 领域模型 ↔ shared 传输契约', () => {
  it('申购状态取值完全一致（含顺序）', () => {
    expect(Object.values(PurchaseStatus)).toEqual([...PURCHASE_STATUSES]);
  });

  it('赎回状态取值完全一致（赎回是另一套枚举，不能复用申购的）', () => {
    expect(Object.values(REDEEM_STATUS_VALUES)).toEqual([...REDEEM_STATUSES]);
  });

  it('币种取值完全一致', () => {
    expect(Object.values(CURRENCY_VALUES)).toEqual([...CURRENCIES]);
  });

  it('申购与赎回是两套不同的枚举（防止有人图省事合并它们）', () => {
    expect([...PURCHASE_STATUSES]).not.toEqual([...REDEEM_STATUSES]);
  });

  it('美元份额形式取值完全一致（含顺序）', () => {
    expect(Object.values(CORE_USD_KINDS)).toEqual([...SHARED_USD_KINDS]);
  });

  it('汇率报价方向取值完全一致（含顺序）', () => {
    expect(Object.values(CORE_FX_DIRECTIONS)).toEqual([...SHARED_FX_DIRECTIONS]);
  });

  it('汇率展示区间取值完全一致（含顺序）', () => {
    expect([...FX_RANGE_KEYS]).toEqual([...FX_RANGES]);
  });

  it('汇率统计区间取值完全一致（含顺序）', () => {
    expect([...FX_INTERVAL_KEYS]).toEqual([...FX_INTERVALS]);
  });

  it('ETF 分类取值完全一致（含顺序 —— 顺序决定统计面板与筛选器的展示顺序）', () => {
    expect([...CORE_ETF_CATEGORIES]).toEqual([...ETF_CATEGORIES]);
  });

  it('ETF 交易所取值完全一致', () => {
    expect(Object.values(CORE_ETF_MARKETS)).toEqual([...ETF_MARKETS]);
  });

  it('ETF 折溢价档位取值完全一致', () => {
    expect(Object.values(CORE_ETF_PREMIUM_LEVELS)).toEqual([...ETF_PREMIUM_LEVELS]);
  });

  it('ETF 排序键都有中文标签（前端下拉直接用）', () => {
    expect(new Set(ETF_SORT_KEYS).size).toBe(ETF_SORT_KEYS.length);
  });

  it('ETF 行情渠道与 shared 的能力描述一一对应（缺字段的渠道必须显式声明）', () => {
    expect(Object.keys(ETF_SPOT_SOURCES)).toEqual([...ETF_SPOT_SOURCE_IDS]);
    for (const [id, info] of Object.entries(ETF_SPOT_SOURCES)) {
      expect(info.id).toBe(id);
      expect(info.name.length).toBeGreaterThan(0);
    }
    // 新浪列表没有 IOPV：它成为默认主源后，「折溢价率不可用」必须能被前端读到
    expect(ETF_SPOT_SOURCES.sina.missing).toContain('折溢价率');
    expect(ETF_SPOT_SOURCES.eastmoney.missing).toEqual([]);
  });
});

describe('工具注册表与 shared 目录', () => {
  it('注册的工具 id 都在 TOOL_CATALOG 中登记', () => {
    const catalogIds = new Set(Object.values(TOOL_CATALOG).map((tool) => tool.id));
    for (const tool of createServerTools()) {
      expect(catalogIds.has(tool.descriptor.id)).toBe(true);
    }
  });

  it('注册表里的描述符与 shared 目录指向同一个对象（服务端启动时的一致性断言）', () => {
    const tools = createServerTools();
    expect(tools).toHaveLength(4);
    expect(tools[0]?.descriptor).toBe(TOOL_CATALOG.qdii);
    expect(tools[1]?.descriptor).toBe(TOOL_CATALOG.usd);
    expect(tools[2]?.descriptor).toBe(TOOL_CATALOG.fx);
    expect(tools[3]?.descriptor).toBe(TOOL_CATALOG.etf);
  });

  it('每个工具都声明了 5 段式 cron 的定时任务', () => {
    const tools = createServerTools();
    const qdiiJobs = tools[0]?.jobs?.({} as never) ?? [];
    const usdJobs = tools[1]?.jobs?.({} as never) ?? [];
    const fxJobs = tools[2]?.jobs?.({} as never) ?? [];
    const etfJobs = tools[3]?.jobs?.({} as never) ?? [];

    expect(qdiiJobs.map((job) => job.name)).toEqual(['qdii.snapshot', 'qdii.premium']);
    expect(usdJobs.map((job) => job.name)).toEqual(['usd.snapshot']);
    expect(fxJobs.map((job) => job.name)).toEqual(['fx.daily']);
    expect(etfJobs.map((job) => job.name)).toEqual(['etf.snapshot']);

    for (const job of [...qdiiJobs, ...usdJobs, ...fxJobs, ...etfJobs]) {
      expect(job.cron.split(' ')).toHaveLength(5);
    }
  });

  it('ETF 快照只在交易时段跑（场内行情收盘后不再变化）', () => {
    const etfJobs = createServerTools()[3]?.jobs?.({} as never) ?? [];
    expect(etfJobs[0]?.cron).toBe('*/30 9-15 * * 1-5');
  });
});
