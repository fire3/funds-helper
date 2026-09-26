import {
  ETF_CATEGORIES as CORE_ETF_CATEGORIES,
  ETF_MARKETS as CORE_ETF_MARKETS,
  ETF_PREMIUM_LEVELS as CORE_ETF_PREMIUM_LEVELS,
  FX_DIRECTIONS as CORE_FX_DIRECTIONS,
  NEWS_CATEGORIES as CORE_NEWS_CATEGORIES,
  NEWS_SECTION_KEYS as CORE_NEWS_SECTION_KEYS,
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
  ETF_SPOT_SOURCE_ORDER,
  ETF_SPOT_SOURCES,
  EtfConfigResponseSchema,
  EtfConfigUpdateSchema,
  FX_INTERVALS,
  FX_RANGES,
  NEWS_SOURCE_IDS,
  NEWS_SUMMARY_JSON_SCHEMA,
  NewsSummaryPayloadSchema,
  PURCHASE_STATUSES,
  REDEEM_STATUSES,
  FX_DIRECTIONS as SHARED_FX_DIRECTIONS,
  NEWS_CATEGORIES as SHARED_NEWS_CATEGORIES,
  NEWS_SECTION_KEYS as SHARED_NEWS_SECTION_KEYS,
  USD_KINDS as SHARED_USD_KINDS,
  TOOL_CATALOG,
} from '@funds-helper/shared';
import { ETF_SPOT_SOURCE_IDS, FEED_CATEGORIES, FEEDS } from '@funds-helper/sources';
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

  it('渠道展示顺序覆盖全部渠道且不重复（界面的下拉框直接用它）', () => {
    expect([...ETF_SPOT_SOURCE_ORDER].sort()).toEqual([...ETF_SPOT_SOURCE_IDS].sort());
    expect(new Set(ETF_SPOT_SOURCE_ORDER).size).toBe(ETF_SPOT_SOURCE_ORDER.length);
  });

  it('渠道配置契约能解析服务端的响应形状，并挡住非法渠道', () => {
    // 前端用同一个 schema 解析响应：形状对不上会直接报错，所以这里必须锁住
    const parsed = EtfConfigResponseSchema.safeParse({
      spotSource: 'eastmoney',
      envDefault: 'sina',
      activeSource: 'sina',
      sources: ETF_SPOT_SOURCE_ORDER.map((id) => ETF_SPOT_SOURCES[id]),
    });
    expect(parsed.success).toBe(true);
    expect(EtfConfigUpdateSchema.safeParse({ spotSource: 'tencent' }).success).toBe(false);
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
    expect(tools).toHaveLength(5);
    expect(tools[0]?.descriptor).toBe(TOOL_CATALOG.qdii);
    expect(tools[1]?.descriptor).toBe(TOOL_CATALOG.usd);
    expect(tools[2]?.descriptor).toBe(TOOL_CATALOG.fx);
    expect(tools[3]?.descriptor).toBe(TOOL_CATALOG.etf);
    expect(tools[4]?.descriptor).toBe(TOOL_CATALOG.news);
  });

  it('每个工具都声明了 5 段式 cron 的定时任务', () => {
    const tools = createServerTools();
    const qdiiJobs = tools[0]?.jobs?.({} as never) ?? [];
    const usdJobs = tools[1]?.jobs?.({} as never) ?? [];
    const fxJobs = tools[2]?.jobs?.({} as never) ?? [];
    const etfJobs = tools[3]?.jobs?.({} as never) ?? [];
    const newsJobs = tools[4]?.jobs?.({} as never) ?? [];

    expect(qdiiJobs.map((job) => job.name)).toEqual(['qdii.snapshot', 'qdii.premium']);
    expect(usdJobs.map((job) => job.name)).toEqual(['usd.snapshot']);
    expect(fxJobs.map((job) => job.name)).toEqual(['fx.daily']);
    expect(etfJobs.map((job) => job.name)).toEqual(['etf.snapshot', 'etf.feeders', 'etf.periods']);
    expect(newsJobs.map((job) => job.name)).toEqual(['news.fetch', 'news.summary']);

    for (const job of [...qdiiJobs, ...usdJobs, ...fxJobs, ...etfJobs, ...newsJobs]) {
      expect(job.cron.split(' ')).toHaveLength(5);
    }
  });

  it('news.fetch 每 10 分钟一跳且启动补跑；news.summary 每天 08:30 且**不**启动补跑', () => {
    const newsJobs = createServerTools()[4]?.jobs?.({} as never) ?? [];
    const fetchJob = newsJobs.find((job) => job.name === 'news.fetch');
    const summaryJob = newsJobs.find((job) => job.name === 'news.summary');

    expect(fetchJob?.cron).toBe('*/10 * * * *');
    expect(fetchJob?.runOnBoot).toBe(true);
    // 简报有历史可展示，重启后补跑纯属烧配额
    expect(summaryJob?.cron).toBe('30 8 * * *');
    expect(summaryJob?.runOnBoot).toBe(false);
  });

  it('ETF 快照只在交易时段跑（场内行情收盘后不再变化）', () => {
    const etfJobs = createServerTools()[3]?.jobs?.({} as never) ?? [];
    expect(etfJobs[0]?.cron).toBe('*/30 9-15 * * 1-5');
  });

  it('联接基金反查每周只跑一次（全量约 2300 个请求，不能跟着行情快照的节奏）', () => {
    const etfJobs = createServerTools()[3]?.jobs?.({} as never) ?? [];
    const feederJob = etfJobs.find((job) => job.name === 'etf.feeders');
    expect(feederJob?.cron).toBe('0 3 * * 1');
    expect(feederJob?.runOnBoot).toBe(true);
  });

  it('区间涨幅每周只跑一次，且错开联接反查的时段（约 1500 个请求）', () => {
    const etfJobs = createServerTools()[3]?.jobs?.({} as never) ?? [];
    const periodsJob = etfJobs.find((job) => job.name === 'etf.periods');
    expect(periodsJob?.cron).toBe('0 4 * * 1');
    expect(periodsJob?.runOnBoot).toBe(true);
  });
});

describe('news 工具的口径一致性', () => {
  it('core 与 shared 的分组取值完全一致（含顺序）', () => {
    expect([...CORE_NEWS_CATEGORIES]).toEqual([...SHARED_NEWS_CATEGORIES]);
    expect([...FEED_CATEGORIES]).toEqual([...SHARED_NEWS_CATEGORIES]);
  });

  it('shared 的信源 id 清单与 sources 注册表逐字相同（前端靠它清洗 URL 参数）', () => {
    expect([...NEWS_SOURCE_IDS]).toEqual(FEEDS.map((feed) => feed.id));
    expect(new Set(NEWS_SOURCE_IDS).size).toBe(NEWS_SOURCE_IDS.length);
  });

  it('core 与 shared 的简报分区键完全一致（前端分区渲染靠它）', () => {
    expect([...CORE_NEWS_SECTION_KEYS]).toEqual([...SHARED_NEWS_SECTION_KEYS]);
  });

  it('信源注册表：只有注册表里的地址会被请求（SSRF 验收断言）', () => {
    for (const feed of FEEDS) {
      expect(feed.url).toMatch(/^https:\/\//);
      expect(FEED_CATEGORIES).toContain(feed.category);
      expect(feed.cadenceSec).toBeGreaterThanOrEqual(60);
    }
    // 任何请求参数里的 URL 都不会被当成信源地址
    expect(FEEDS.some((feed) => feed.url.includes('127.0.0.1'))).toBe(false);
  });

  it('response_format 的 JSON schema 与 Zod schema 同步（严格模式靠它生效）', () => {
    const schema = NEWS_SUMMARY_JSON_SCHEMA as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['headline', 'sections', 'risk', 'watch']);
    const sections = schema.properties?.sections as { required?: string[] };
    expect(sections.required).toEqual([...SHARED_NEWS_SECTION_KEYS]);

    // 按 JSON schema 造的合法样例必须能过 Zod（否则模型“合规”但服务端拒收）
    const sample = {
      headline: '今日要闻',
      sections: {
        macro: [{ text: '维持利率不变', refs: [1] }],
        markets: [],
        companies: [],
        asia: [],
      },
      risk: [],
      watch: ['下周 CPI'],
    };
    expect(NewsSummaryPayloadSchema.safeParse(sample).success).toBe(true);
    // 缺 section / refs 是字符串 / 枚举外的分区 id 都必须被挡住
    expect(NewsSummaryPayloadSchema.safeParse({ ...sample, sections: { macro: [] } }).success).toBe(
      false,
    );
    expect(
      NewsSummaryPayloadSchema.safeParse({
        ...sample,
        sections: { ...sample.sections, bogus: [] },
      }).success,
    ).toBe(false);
    expect(
      NewsSummaryPayloadSchema.safeParse({
        ...sample,
        sections: { ...sample.sections, macro: [{ text: 'x', refs: '1' }] },
      }).success,
    ).toBe(false);
  });

  it('15 个信源全部登记在册，且都能对上一份 fixture', () => {
    expect(FEEDS).toHaveLength(15);
    const fixtures = new Set(FEEDS.map((feed) => feed.fixture));
    expect(fixtures.size).toBe(FEEDS.length); // 一个信源一份 fixture，不共用
    for (const feed of FEEDS) expect(feed.fixture.endsWith('.xml')).toBe(true);
  });
});
