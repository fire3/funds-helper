import { SettingRepository } from '@funds-helper/db';
import type {
  EtfConfigResponse,
  EtfConfigUpdateResponse,
  EtfDatasetResponse,
  EtfFundDetailResponse,
  EtfPeriodRefreshResponse,
  EtfRefreshResponse,
} from '@funds-helper/shared';
import { describe, expect, it } from 'vitest';
import { createHarness } from './testing/app-harness.ts';
import {
  createFakeEtfSource,
  etfProfiles,
  etfSinaSpotItems,
  etfSpotItemsWithStyle,
  type FakeEtfSource,
} from './testing/fake-etf-source.ts';
import { createEtfTool } from './tools/etf/index.ts';

type App = Awaited<ReturnType<typeof createHarness>>;

type EtfHarnessOptions = Parameters<typeof createFakeEtfSource>[0] & {
  /** `ETF_EASTMONEY_ENABLED` 的值（只作为「没有运行时偏好」时的默认，见 config.ts） */
  eastmoney?: boolean;
};

interface EtfHarness {
  app: App;
  source: FakeEtfSource;
  db: Awaited<ReturnType<typeof createHarness>>['db'];
  scheduler: Awaited<ReturnType<typeof createHarness>>['scheduler'];
}

async function etfHarness(options: EtfHarnessOptions = {}): Promise<EtfHarness> {
  const { eastmoney = false, ...sourceOptions } = options;
  const source = createFakeEtfSource(sourceOptions);
  const app = await createHarness({
    config: { etfEastmoneyEnabled: eastmoney },
    buildTools: ({ now }) => [createEtfTool({ source, now })],
  });
  return { app, source, db: app.db, scheduler: app.scheduler };
}

async function datasetOf(app: App): Promise<EtfDatasetResponse> {
  const response = await app.inject({ method: 'GET', url: '/api/tools/etf/dataset' });
  expect(response.statusCode).toBe(200);
  return response.json() as EtfDatasetResponse;
}

describe('GET /api/tools/etf/dataset', () => {
  it('行情与目录按代码 join：跟踪指数、分类、区间涨跌都来自接口 B', async () => {
    const { app } = await etfHarness({ eastmoney: true });
    try {
      const body = await datasetOf(app);
      expect(body.total).toBe(8);

      const hs300 = body.funds.find((fund) => fund.code === '510300');
      expect(hs300).toMatchObject({
        name: '沪深300ETF华泰柏瑞',
        market: '沪市',
        category: '宽基',
        categorySource: 'upstream',
        indexName: '沪深300',
        listingDate: '2012-05-28',
        shares: 23_713_687_700,
        change1w: 1.39,
        maxDrawdown1y: -11.17,
      });
      expect(hs300?.scale).toBe(109_391_241_858);
    } finally {
      await app.close();
    }
  });

  it('默认只走新浪：折溢价率整体不可用，必须显示为「未知」而不是 0', async () => {
    const { app, source } = await etfHarness();
    try {
      const body = await datasetOf(app);

      expect(body.dataSource).toEqual({
        id: 'sina',
        name: '新浪财经',
        missing: ['折溢价率', '上市日期', '主力净流入', '量比'],
      });
      // 关键：默认链路里根本没有东财行情这一跳
      expect(source.calls.spot).toBeUndefined();

      expect(body.funds.every((fund) => fund.premiumRate === null)).toBe(true);
      expect(body.funds.every((fund) => fund.premiumLevel === '未知')).toBe(true);
      expect(body.stats.premium.unknown).toBe(body.total);
      expect(body.stats.premium.maxPremium).toBeNull();
      expect(body.funds.every((fund) => fund.listingDate === null)).toBe(true);
      // 跟踪指数/分类来自接口 B，与行情渠道无关
      expect(body.funds.find((fund) => fund.code === '510300')?.indexName).toBe('沪深300');
      // 新浪列表不带行情时间戳 → 数据日期退化成「本地今天」
      expect(body.freshness.dataDate).toBe('2026-09-14');
    } finally {
      await app.close();
    }
  });

  it('打开东财时把目录代码池交给批量报价（ulist.np），不再按板块翻页', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      const body = await datasetOf(app);

      expect(body.dataSource).toEqual({ id: 'eastmoney', name: '东方财富行情', missing: [] });
      expect(source.calls.spotByCodes).toBe(1);
      // 有代码池就不该再走「按板块翻页」那条路
      expect(source.calls.spot).toBeUndefined();
      expect(source.lastSpotCodes).toEqual(source.profiles.map((row) => row.code));
      // 东财有折溢价 → 同一只 ETF 不再是「未知」
      expect(body.funds.find((fund) => fund.code === '510300')?.premiumRate).toBe(-0.06);
    } finally {
      await app.close();
    }
  });

  it('目录失败（没有代码池）时退回自带代码池的 clist，而不是直接放弃东财', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      source.failures.add('profiles');
      const body = await datasetOf(app);

      expect(body.dataSource.id).toBe('eastmoney');
      expect(source.calls.spot).toBe(1);
      expect(source.calls.spotByCodes).toBeUndefined();
      // clist 自带代码池 → 目录缺失不影响标的数量
      expect(body.total).toBe(8);
      expect(body.freshness.dataDate).toBe('2026-09-22');
    } finally {
      await app.close();
    }
  });

  it('分类覆盖六类（宽基/行业主题/跨境/债券/商品/货币由标志位判定）', async () => {
    const { app } = await etfHarness();
    try {
      const body = await datasetOf(app);
      const categoryOf = (code: string): string | undefined =>
        body.funds.find((fund) => fund.code === code)?.category;

      expect(categoryOf('510300')).toBe('宽基');
      expect(categoryOf('512880')).toBe('行业主题');
      expect(categoryOf('513100')).toBe('跨境');
      expect(categoryOf('511990')).toBe('货币');
      expect(categoryOf('159985')).toBe('商品');
    } finally {
      await app.close();
    }
  });

  it('风格优先于宽基（IS_FGETF 与 IS_KJETF 叠加时按风格展示）', async () => {
    const { app } = await etfHarness({ spot: etfSpotItemsWithStyle() });
    try {
      const body = await datasetOf(app);
      expect(body.funds.find((fund) => fund.code === '512890')).toMatchObject({
        category: '风格',
        categorySource: 'upstream',
      });
    } finally {
      await app.close();
    }
  });

  it('目录里没有的行回退名称判定（并标记 categorySource=name）', async () => {
    // 目录（接口 B）偶尔会比行情少几行：行情的行仍要能归类，靠名称判定兜底
    const { app } = await etfHarness({
      profiles: etfProfiles().filter((row) => row.code !== '513500' && row.code !== '512480'),
    });
    try {
      const body = await datasetOf(app);
      // 这两只被人为从目录里摘掉 → 名称含「标普」/「半导体」→ 名称判定
      expect(body.funds.find((fund) => fund.code === '513500')).toMatchObject({
        category: '跨境',
        categorySource: 'name',
        indexName: null,
        shares: null,
      });
      expect(body.funds.find((fund) => fund.code === '512480')).toMatchObject({
        category: '行业主题',
        categorySource: 'name',
      });
    } finally {
      await app.close();
    }
  });

  it('折溢价取反成正数（正 = 溢价），并给出档位与文案', async () => {
    const { app } = await etfHarness({ eastmoney: true });
    try {
      const body = await datasetOf(app);
      const premiumOf = (code: string) => body.funds.find((fund) => fund.code === code);

      // 上游 f402 = -1.5 → 溢价 1.5% → 高溢价（带提示）
      expect(premiumOf('512880')).toMatchObject({
        premiumRate: 1.5,
        premiumLevel: '高溢价',
        premiumText: '溢价 1.50%',
      });
      expect(premiumOf('512880')?.premiumNote).toContain('多付');

      // 上游 f402 = 0.06 → 折价 0.06% → 平价（|rate| < 0.1）
      expect(premiumOf('510300')).toMatchObject({ premiumRate: -0.06, premiumLevel: '平价' });

      // 上游 f402 = 2 → 折价 2% → 高折价
      expect(premiumOf('513100')).toMatchObject({ premiumLevel: '高折价', premiumNote: null });

      // 无数据必须是「未知 + —」，不能是 0%
      expect(premiumOf('159985')).toMatchObject({
        premiumRate: null,
        premiumLevel: '未知',
        premiumText: '—',
      });
    } finally {
      await app.close();
    }
  });

  it('汇总统计：分类分布、折溢价分布、覆盖率与极值', async () => {
    const { app } = await etfHarness({ spot: etfSpotItemsWithStyle(), eastmoney: true });
    try {
      const body = await datasetOf(app);
      const stats = body.stats;

      expect(stats.total).toBe(9);
      expect(stats.byCategory.map((item) => item.category)).toEqual([
        '宽基',
        '行业主题',
        '风格',
        '跨境',
        '商品',
        '货币',
      ]);
      expect(stats.byCategory.find((item) => item.category === '宽基')).toMatchObject({ count: 2 });
      expect(stats.byMarket.map((item) => item.market)).toEqual(['沪市', '深市']);

      // 溢价档位计数与列表徽标同源
      expect(stats.premium.counts).toEqual({
        高溢价: 1, // 512880  溢价 1.5%
        溢价: 3, // 159915 0.43% / 513500 0.2% / 512890 0.1%（0.1 归入溢价）
        平价: 3, // 510300 / 511990 / 512480
        折价: 0,
        高折价: 1, // 513100 折价 2%
      });
      expect(stats.premium.unknown).toBe(1);
      expect(stats.premium.maxPremium).toMatchObject({ code: '512880', rate: 1.5 });
      expect(stats.premium.maxDiscount).toMatchObject({ code: '513100', rate: -2 });

      expect(stats.extremes.largest?.code).toBe('510300');
      expect(stats.extremes.mostActive?.code).toBe('511990');

      // 目录 8 条、行情 9 条 → 目录里没有行情的只有 158000（已成立未上市）
      expect(stats.coverage).toEqual({ spot: 9, profile: 10, unlisted: 1 });
      expect(stats.totalScale).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('数据日期取该批行情的最大行情时间（北京时间的交易日），不是本地今天', async () => {
    const { app } = await etfHarness({ eastmoney: true });
    try {
      const body = await datasetOf(app);
      // 假行情时间戳 1790064693 = 2026-09-22T08:11:33Z = 北京时间 16:11（收盘后快照）
      expect(body.freshness.dataDate).toBe('2026-09-22');
      expect(body.funds[0]?.quoteAt).toBe('2026-09-22T08:11:33.000Z');
    } finally {
      await app.close();
    }
  });

  it('接口 B 失败只降级：数据集照常返回，分类全部走名称回退', async () => {
    const { app, source } = await etfHarness();
    try {
      source.failures.add('profiles');
      const body = await datasetOf(app);

      expect(body.total).toBe(8);
      expect(body.funds.every((fund) => fund.categorySource === 'name')).toBe(true);
      expect(body.funds.every((fund) => fund.indexName === null)).toBe(true);
      // 覆盖率仍以行情为准
      expect(body.stats.coverage.profile).toBe(0);
      expect(body.funds.find((fund) => fund.code === '510300')?.category).toBe('宽基');
    } finally {
      await app.close();
    }
  });

  it('打开东财后它故障 → 自动降级到新浪：行情仍可用，折溢价置空并显式标注', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      source.failures.add('spotByCodes');
      const body = await datasetOf(app);

      expect(body.total).toBe(8);
      expect(source.calls.sinaSpot).toBe(1);
      expect(body.dataSource).toEqual({
        id: 'sina',
        name: '新浪财经',
        missing: ['折溢价率', '上市日期', '主力净流入', '量比'],
      });
      expect(body.freshness.source).toBe('sina');

      // 备用渠道没有折溢价：必须是「未知 / —」，不能被当成平价 0
      expect(body.funds.every((fund) => fund.premiumRate === null)).toBe(true);
      expect(body.funds.every((fund) => fund.premiumLevel === '未知')).toBe(true);
      expect(body.funds.every((fund) => fund.premiumText === '—')).toBe(true);
      expect(body.stats.premium.unknown).toBe(8);
      expect(body.stats.premium.maxPremium).toBeNull();
      expect(body.funds.every((fund) => fund.listingDate === null)).toBe(true);

      // 分类与跟踪指数来自接口 B，不受行情渠道影响
      expect(body.funds.find((fund) => fund.code === '510300')?.indexName).toBe('沪深300');
      // 备用渠道不给行情时间戳 → 数据日期退化成「本地今天」（降级路径的已知代价）
      expect(body.freshness.dataDate).toBe('2026-09-14');
    } finally {
      await app.close();
    }
  });

  it('渠道来自数据库而不是内存：清缓存/重建响应后仍标注备用渠道', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      source.failures.add('spotByCodes');
      await datasetOf(app);

      app.cache.clear();
      const again = await datasetOf(app);
      expect(again.dataSource.id).toBe('sina');
      // 只从库里读，不会再打一次新浪
      expect(source.calls.sinaSpot).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('新浪故障且库里没有数据 → 503；库里已有数据 → 陈旧快照 + stale', async () => {
    const { app, source } = await etfHarness();
    try {
      source.failures.add('sinaSpot');
      // 第一次抓取就失败：没有任何本地数据
      const failed = await app.inject({ method: 'GET', url: '/api/tools/etf/dataset' });
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } });

      // 恢复上游 → 抓一次拿到数据
      source.failures.delete('sinaSpot');
      expect((await datasetOf(app)).total).toBe(8);

      // 再让新浪故障，并把时间推过陈旧窗口 → 返回陈旧快照
      source.failures.add('sinaSpot');
      app.setNow(Date.parse('2026-09-22T10:00:00.000Z') + 7 * 3_600_000);
      app.cache.clear();

      const stale = await datasetOf(app);
      expect(stale.total).toBe(8);
      expect(stale.freshness.stale).toBe(true);
      expect(stale.freshness.staleReason).toContain('不可用');
    } finally {
      await app.close();
    }
  });

  it('非上游错误（如数据库故障）原样冒泡为 500，不被伪装成上游不可用', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      source.failures.add('spotByCodes:internal');
      const response = await app.inject({ method: 'GET', url: '/api/tools/etf/dataset' });
      expect(response.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/tools/etf/refresh', () => {
  it('首次抓取写入行情与目录，同日重复抓取幂等（inserted=0）', async () => {
    const { app } = await etfHarness({ eastmoney: true });
    try {
      const first = await app.inject({ method: 'POST', url: '/api/tools/etf/refresh' });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as EtfRefreshResponse;
      expect(firstBody).toMatchObject({ ok: true, spot: 8, profile: 10, dataDate: '2026-09-22' });
      expect(firstBody.inserted).toBe(8);

      const second = await app.inject({ method: 'POST', url: '/api/tools/etf/refresh' });
      const secondBody = second.json() as EtfRefreshResponse;
      expect(secondBody.inserted).toBe(0);
      expect(secondBody.message).toContain('8 只 ETF');
    } finally {
      await app.close();
    }
  });

  it('接口 B 失败时刷新照常成功，并在 message 里说明', async () => {
    const { app, source } = await etfHarness();
    try {
      source.failures.add('profiles');
      const response = await app.inject({ method: 'POST', url: '/api/tools/etf/refresh' });
      const body = response.json() as EtfRefreshResponse;
      expect(response.statusCode).toBe(200);
      expect(body.profile).toBe(0);
      expect(body.message).toContain('目录失败');
    } finally {
      await app.close();
    }
  });

  it('主源故障时刷新走备用渠道，并在 source 与 message 里说明缺失字段', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      source.failures.add('spotByCodes');
      const response = await app.inject({ method: 'POST', url: '/api/tools/etf/refresh' });
      const body = response.json() as EtfRefreshResponse;

      expect(response.statusCode).toBe(200);
      expect(body.source).toBe('sina');
      expect(body.spot).toBe(8);
      expect(body.message).toContain('新浪财经');
      expect(body.message).toContain('该渠道不含折溢价率');
    } finally {
      await app.close();
    }
  });

  it('默认（不打开东财）刷新直接走新浪，且不会调用东财行情', async () => {
    const { app, source } = await etfHarness();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/tools/etf/refresh' });
      const body = response.json() as EtfRefreshResponse;

      expect(body.source).toBe('sina');
      expect(body.spot).toBe(8);
      expect(source.calls.spot).toBeUndefined();
      expect(body.message).toContain('该渠道不含折溢价率');
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/tools/etf/funds/:code', () => {
  it('返回行情记录 + 基金概况（接口 C）+ 通用详情区块', async () => {
    const { app } = await etfHarness();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/tools/etf/funds/510300' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as EtfFundDetailResponse;

      expect(body.code).toBe('510300');
      expect(body.record?.indexName).toBe('沪深300');
      expect(body.profile).toMatchObject({
        fullName: '华泰柏瑞沪深300交易型开放式指数证券投资基金',
        managementFee: '0.15%',
        custodyFee: '0.05%',
        salesServiceFee: null,
        netAssetsDate: '2026-06-30',
        company: '华泰柏瑞基金',
        manager: '柳军',
      });
      // 通用区块与 QDII/美元份额共用同一份聚合
      expect(body.navTrend.length).toBeGreaterThan(0);
      expect(body.scale.length).toBeGreaterThan(0);
      expect(body.notices.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('详情缓存命中后不再打上游（第二次请求 0 次调用）', async () => {
    const { app, source } = await etfHarness();
    try {
      await app.inject({ method: 'GET', url: '/api/tools/etf/funds/510300' });
      const afterFirst = source.calls.fundProfile ?? 0;
      await app.inject({ method: 'GET', url: '/api/tools/etf/funds/510300' });
      expect(source.calls.fundProfile).toBe(afterFirst);
    } finally {
      await app.close();
    }
  });

  it('接口 C 失败只记进 errors，其余区块照常返回', async () => {
    const { app, source } = await etfHarness();
    try {
      source.failures.add('fundProfile');
      const response = await app.inject({ method: 'GET', url: '/api/tools/etf/funds/510300' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as EtfFundDetailResponse;
      expect(body.profile).toBeNull();
      expect(body.errors.some((message) => message.includes('基金概况'))).toBe(true);
      expect(body.navTrend.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('份额分拆：走势保留原始单位净值，区间统计与说明改走复权口径', async () => {
    const { app, source } = await etfHarness();
    try {
      // 159507 形态：2026-09-11 每份分拆 3 份，单位净值 3.3 → 1.1（看起来一天跌 66.7%）
      source.fetchPingzhong = async () => ({
        Data_netWorthTrend: [
          { x: Date.UTC(2026, 8, 1), y: 3.0, equityReturn: 0, unitMoney: '' },
          { x: Date.UTC(2026, 8, 10), y: 3.3, equityReturn: 10, unitMoney: '' },
          {
            x: Date.UTC(2026, 8, 11),
            y: 1.1,
            equityReturn: 0,
            unitMoney: '拆分：每份基金份额分拆3.0份',
          },
          { x: Date.UTC(2026, 8, 20), y: 1.0, equityReturn: -9.09, unitMoney: '' },
          { x: Date.UTC(2026, 8, 30), y: 1.2, equityReturn: 20, unitMoney: '' },
        ],
        Data_ACWorthTrend: [
          [Date.UTC(2026, 8, 1), 3.0],
          [Date.UTC(2026, 8, 10), 3.3],
          [Date.UTC(2026, 8, 11), 3.3],
          [Date.UTC(2026, 8, 20), 3.0],
          [Date.UTC(2026, 8, 30), 3.6],
        ],
      });

      const response = await app.inject({ method: 'GET', url: '/api/tools/etf/funds/510300' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as EtfFundDetailResponse;

      // 走势图仍是原始单位净值（台阶是真实发生的）
      expect(body.navTrend.map((point) => point.nav)).toEqual([3.0, 3.3, 1.1, 1.0, 1.2]);

      // 卡片可展示的解释：哪天、什么事件、多大比例、真实涨跌
      expect(body.navEvents).toHaveLength(1);
      expect(body.navEvents[0]).toMatchObject({ date: '2026-09-11', kind: 'split', ratio: 3 });
      expect(body.navEvents[0]?.title).toContain('份额分拆');
      expect(body.navEvents[0]?.text).toContain('不是亏损');
      expect(body.navEvents[0]?.text).toContain('复权口径');
      expect(body.navSummaryNote).toContain('复权口径');

      // 区间统计按累计净值：+20%（不是单位净值的 -60%），回撤 -9.09%（不是 -69.7%）
      const month = body.navSummary.find((row) => row.label === '近1月');
      expect(month?.returnPct).toBe(20);
      expect(month?.maxDrawdownPct).toBeCloseTo(-9.09, 1);
    } finally {
      await app.close();
    }
  });

  it('代码格式不对 → 400；不在行情里 → 404（含已成立未上市）', async () => {
    const { app } = await etfHarness();
    try {
      const bad = await app.inject({ method: 'GET', url: '/api/tools/etf/funds/abc' });
      expect(bad.statusCode).toBe(400);

      const missing = await app.inject({ method: 'GET', url: '/api/tools/etf/funds/999999' });
      expect(missing.statusCode).toBe(404);

      // 158000 在目录里但没有场内行情 → 明确 404 而不是半成品
      const unlisted = await app.inject({ method: 'GET', url: '/api/tools/etf/funds/158000' });
      expect(unlisted.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('行情渠道配置（/api/tools/etf/config）', () => {
  async function configOf(app: App): Promise<EtfConfigResponse> {
    const response = await app.inject({ method: 'GET', url: '/api/tools/etf/config' });
    expect(response.statusCode).toBe(200);
    return response.json() as EtfConfigResponse;
  }

  it('默认值来自环境变量，并列出各渠道的能力差异', async () => {
    const { app } = await etfHarness({ eastmoney: true });
    try {
      const config = await configOf(app);
      expect(config.spotSource).toBe('eastmoney');
      expect(config.envDefault).toBe('eastmoney');
      // 还没有数据时「实际渠道」按主源报
      expect(config.activeSource).toBe('eastmoney');
      expect(config.sources.map((source) => source.id)).toEqual(['eastmoney', 'sina']);
      expect(config.sources.find((source) => source.id === 'sina')?.missing).toContain('折溢价率');
      expect(config.sources.find((source) => source.id === 'eastmoney')?.missing).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('没有运行时偏好时跟随环境变量：ETF_EASTMONEY_ENABLED=false → 只走新浪', async () => {
    const { app, source } = await etfHarness({ eastmoney: false });
    try {
      const config = await configOf(app);
      expect(config.spotSource).toBe('sina');
      expect(config.envDefault).toBe('sina');

      await datasetOf(app);
      // 偏好是新浪 → 连东财都不该碰
      expect(source.calls.spotByCodes).toBeUndefined();
      expect(source.calls.spot).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('PUT 切换渠道：落库 + 立刻重抓，数据与配置一起变成新渠道', async () => {
    const { app, source, db } = await etfHarness({ eastmoney: true });
    try {
      // 先把时钟拨到行情时间戳所在的交易日，让两个渠道落在同一个 data_date 上
      app.setNow(Date.parse('2026-09-22T10:00:00.000Z'));
      expect((await datasetOf(app)).dataSource.id).toBe('eastmoney');

      const response = await app.inject({
        method: 'PUT',
        url: '/api/tools/etf/config',
        payload: { spotSource: 'sina' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as EtfConfigUpdateResponse;
      expect(body.config.spotSource).toBe('sina');
      expect(body.refresh.source).toBe('sina');
      expect(body.refresh.message).toContain('新浪财经');
      expect(body.refresh.message).toContain('该渠道不含折溢价率');
      // 偏好确实写进了 app_setting（不是只改了内存）
      expect(new SettingRepository(db).get('etf.spotSource')).toBe('sina');

      const dataset = await datasetOf(app);
      expect(dataset.dataSource).toEqual({
        id: 'sina',
        name: '新浪财经',
        missing: ['折溢价率', '上市日期', '主力净流入', '量比'],
      });
      expect(dataset.funds.every((fund) => fund.premiumRate === null)).toBe(true);
      expect(dataset.stats.premium.unknown).toBe(dataset.total);
      expect(source.calls.sinaSpot).toBe(1);

      // 切回东财：折溢价回来（source 列被同一天的行覆盖）
      const back = await app.inject({
        method: 'PUT',
        url: '/api/tools/etf/config',
        payload: { spotSource: 'eastmoney' },
      });
      expect((back.json() as EtfConfigUpdateResponse).refresh.source).toBe('eastmoney');
      app.cache.clear();
      const restored = await datasetOf(app);
      expect(restored.dataSource.id).toBe('eastmoney');
      expect(restored.funds.find((fund) => fund.code === '510300')?.premiumRate).toBe(-0.06);
    } finally {
      await app.close();
    }
  });

  it('非法渠道 → 400，且不改动已有配置', async () => {
    const { app, db } = await etfHarness({ eastmoney: true });
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/tools/etf/config',
        payload: { spotSource: 'tencent' },
      });
      expect(response.statusCode).toBe(400);
      expect(new SettingRepository(db).get('etf.spotSource')).toBeNull();
      expect((await configOf(app)).spotSource).toBe('eastmoney');
    } finally {
      await app.close();
    }
  });

  it('切换后即使清缓存也保持（偏好来自数据库而不是进程内存）', async () => {
    const { app } = await etfHarness({ eastmoney: true });
    try {
      await app.inject({
        method: 'PUT',
        url: '/api/tools/etf/config',
        payload: { spotSource: 'sina' },
      });
      app.cache.clear();
      expect((await configOf(app)).spotSource).toBe('sina');
    } finally {
      await app.close();
    }
  });
});

describe('切换行情渠道时的数据一致性', () => {
  it('新的渠道会顶掉同一天里其它渠道的行（数据集不会混着两个渠道的标的）', async () => {
    // 东财有、新浪没有的一只（真实场景：新浪列表里已退市/停牌的代码两边对不齐）
    const eastmoneyOnly = { ...etfSpotItemsWithStyle()[0]!, code: '588000', name: '科创50ETF华夏' };
    const sinaOnly = { ...etfSinaSpotItems()[0]!, code: '512390', name: '已退市ETF' };
    const { app } = await etfHarness({
      eastmoney: true,
      spot: [...etfSpotItemsWithStyle(), eastmoneyOnly],
      sinaSpot: [...etfSinaSpotItems(etfSpotItemsWithStyle()), sinaOnly],
      profiles: [
        ...etfProfiles(),
        { ...etfProfiles()[0]!, code: '588000', name: '科创50ETF华夏', indexName: '科创50' },
      ],
    });
    try {
      const start = await datasetOf(app);
      expect(start.dataSource.id).toBe('eastmoney');
      expect(start.funds.map((fund) => fund.code)).toContain('588000');
      expect(start.funds.map((fund) => fund.code)).not.toContain('512390');

      await app.inject({
        method: 'PUT',
        url: '/api/tools/etf/config',
        payload: { spotSource: 'sina' },
      });

      app.cache.clear();
      const switched = await datasetOf(app);
      const codes = switched.funds.map((fund) => fund.code);
      expect(switched.dataSource.id).toBe('sina');
      // 新浪的代码进来了，东财独有的那只被清掉 —— 不会两个渠道各留一半
      expect(codes).toContain('512390');
      expect(codes).not.toContain('588000');
      // 新浪的 10 只（withStyle 的 9 只 + 新浪独有的 1 只），东财那只已被顶掉
      expect(switched.total).toBe(10);
      // 同一个数据日期上只剩一个渠道
      expect(switched.funds.every((fund) => fund.premiumRate === null)).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('场外联接基金反查（ETF → 场外）', () => {
  async function feedersOf(app: App): Promise<EtfDatasetResponse> {
    // 反查会清数据集缓存，这里显式取一份最新的
    return datasetOf(app);
  }

  it('没反查过时：联接列表为空、覆盖度为 0，且接口不会自己去打上游', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      const body = await feedersOf(app);
      expect(body.feeder).toEqual({ updatedAt: null, etfCount: 0, fundCount: 0 });
      expect(body.funds.every((fund) => fund.feederFunds.length === 0)).toBe(true);
      // 2320 个请求的慢链路绝不能挂在用户请求上
      expect(source.calls.feeders ?? 0).toBe(0);
      expect(source.calls.fundCatalog ?? 0).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('全量反查：363 行落库后，每只 ETF 拿到自己的联接份额（A/C/I/Y 都在）', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/tools/etf/feeders/refresh?full=1',
      });
      expect(response.statusCode).toBe(200);
      const body = await response.json();
      expect(body.full).toBe(true);
      // 候选池 = 名称含「联接」的那些（替身里 18 只，另有 2 只 ETF 本身不该入选）
      expect(body.scanned).toBe(18);
      expect(body.mapped).toBe(18);
      expect(body.empty).toBe(0);
      expect(body.failed).toBe(0);
      expect(source.lastFeederCodes).not.toContain('510300');

      const dataset = await feedersOf(app);
      const hs300 = dataset.funds.find((fund) => fund.code === '510300');
      expect(hs300?.feederFunds.map((fund) => fund.code)).toEqual([
        '006131',
        '022699',
        '022948',
        '460300',
      ]);
      const chuangye = dataset.funds.find((fund) => fund.code === '159915');
      expect(chuangye?.feederFunds).toHaveLength(3);
      // 没有联接基金的 ETF（替身里 513100/511990 是空集）保持空数组，不是 null
      expect(dataset.funds.find((fund) => fund.code === '513100')?.feederFunds).toEqual([]);
      // 覆盖度：7 只 ETF 有联接（8 只行情里的 513100/511990 没有），18 只联接基金
      expect(dataset.feeder.etfCount).toBe(7);
      expect(dataset.feeder.fundCount).toBe(18);
      expect(dataset.feeder.updatedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('增量反查：第二次只查「还没落库」的候选，不重复打 2300 个请求', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      await app.inject({ method: 'POST', url: '/api/tools/etf/feeders/refresh?full=1' });
      expect(source.lastFeederCodes).toHaveLength(18);

      const second = await app.inject({ method: 'POST', url: '/api/tools/etf/feeders/refresh' });
      const body = await second.json();
      expect(body.full).toBe(false);
      expect(body.scanned).toBe(0);
      expect(body.message).toContain('没有新增');
      // 没有任何上游请求：候选池没有新增时连接口 I 都不碰
      expect(source.lastFeederCodes).toHaveLength(18);

      // 新成立一只联接基金 → 下一次增量只查这一只
      source.feederCatalog = [
        ...source.feederCatalog,
        {
          code: '029999',
          name: '某某中证A500ETF联接A',
          pinyinAbbr: null,
          fundType: '指数型-股票',
          pinyinFull: null,
        },
      ];
      source.feederTargets.set('029999', {
        etfCode: '510300',
        etfName: '沪深300ETF华泰柏瑞',
        reportDate: '2026-06-30',
      });
      const third = await app.inject({ method: 'POST', url: '/api/tools/etf/feeders/refresh' });
      const thirdBody = await third.json();
      expect(thirdBody.scanned).toBe(1);
      expect(source.lastFeederCodes).toEqual(['029999']);

      const dataset = await feedersOf(app);
      expect(
        dataset.funds.find((fund) => fund.code === '510300')?.feederFunds.map((fund) => fund.code),
      ).toEqual(['006131', '022699', '022948', '029999', '460300']);
    } finally {
      await app.close();
    }
  });

  it('上游没给目标 ETF 的候选下次仍会重查（不写库 = 未知，而不是「没有」）', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      // 让 000942（名称不含 ETF 的联接基金）查不到目标
      const targets = new Map(source.feederTargets);
      targets.delete('000942');
      source.feederTargets = targets;

      const first = await app.inject({
        method: 'POST',
        url: '/api/tools/etf/feeders/refresh?full=1',
      });
      const firstBody = await first.json();
      expect(firstBody.empty).toBe(1);
      expect(firstBody.mapped).toBe(17);

      const second = await app.inject({ method: 'POST', url: '/api/tools/etf/feeders/refresh' });
      const secondBody = await second.json();
      expect(source.lastFeederCodes).toEqual(['000942']);
      expect(secondBody.scanned).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('单只请求失败不影响其它行，失败的代码会在下次增量里重试', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      source.failures.add('feeder:006131');
      const first = await app.inject({
        method: 'POST',
        url: '/api/tools/etf/feeders/refresh?full=1',
      });
      const body = await first.json();
      expect(body.failed).toBe(1);
      expect(body.mapped).toBe(17);

      const dataset = await feedersOf(app);
      expect(
        dataset.funds.find((fund) => fund.code === '510300')?.feederFunds.map((fund) => fund.code),
      ).toEqual(['022699', '022948', '460300']);

      source.failures.delete('feeder:006131');
      await app.inject({ method: 'POST', url: '/api/tools/etf/feeders/refresh' });
      expect(source.lastFeederCodes).toEqual(['006131']);
      const healed = await feedersOf(app);
      expect(healed.funds.find((fund) => fund.code === '510300')?.feederFunds).toHaveLength(4);
    } finally {
      await app.close();
    }
  });

  it('候选池整体不可用时 500，且**不清空**已落库的映射', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      await app.inject({ method: 'POST', url: '/api/tools/etf/feeders/refresh?full=1' });
      source.failures.add('fundCatalog');
      const response = await app.inject({
        method: 'POST',
        url: '/api/tools/etf/feeders/refresh?full=1',
      });
      // 上游不可用 → 503（与其它工具的 UpstreamError 一致）
      expect(response.statusCode).toBe(503);

      const dataset = await feedersOf(app);
      expect(dataset.feeder.fundCount).toBe(18);
    } finally {
      await app.close();
    }
  });

  it('全量反查结果异常少时不清扫（护栏：不能把已有映射删光）', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      await app.inject({ method: 'POST', url: '/api/tools/etf/feeders/refresh?full=1' });

      // 模拟上游退化成「只回一条」：mapped 远低于 ETF_FEEDER_MIN_MAPPED
      source.feederTargets = new Map([
        ['460300', { etfCode: '510300', etfName: '沪深300ETF华泰柏瑞', reportDate: '2026-06-30' }],
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/api/tools/etf/feeders/refresh?full=1',
      });
      expect(response.statusCode).toBe(200);

      const dataset = await feedersOf(app);
      // 既有的 17 只没有被清扫掉
      expect(dataset.feeder.fundCount).toBe(18);
    } finally {
      await app.close();
    }
  });

  it('全量反查无失败时才清扫：已清盘的联接基金不会残留', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      await app.inject({ method: 'POST', url: '/api/tools/etf/feeders/refresh?full=1' });
      let dataset = await feedersOf(app);
      expect(dataset.feeder.fundCount).toBe(18);

      // 000942 清盘：从候选池消失
      source.feederCatalog = source.feederCatalog.filter((row) => row.code !== '000942');
      const targets = new Map(source.feederTargets);
      targets.delete('000942');
      source.feederTargets = targets;

      await app.inject({ method: 'POST', url: '/api/tools/etf/feeders/refresh?full=1' });
      dataset = await feedersOf(app);
      expect(dataset.feeder.fundCount).toBe(17);
    } finally {
      await app.close();
    }
  });

  it('定时任务：首次会全量，距上次不足 6 天时直接跳过', async () => {
    const { app, source, scheduler } = await etfHarness({ eastmoney: true });
    try {
      const first = await scheduler.execute('etf.feeders', 'manual');
      expect(first?.stats).toMatchObject({ full: true, skipped: false });

      const second = await scheduler.execute('etf.feeders', 'manual');
      expect(second?.stats).toMatchObject({ skipped: true });
      // 跳过的这一轮没有打上游
      expect(source.calls.feeders ?? 0).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe('区间涨幅与热点研究数据（/api/tools/etf/periods + dataset 新字段）', () => {
  it('没抓过时：periodReturns 全零、区间字段为 null，接口不会自己去打上游', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      const body = await datasetOf(app);
      expect(body.periodReturns).toEqual({
        updatedAt: null,
        dataDate: null,
        total: 0,
        covered1y: 0,
        covered3y: 0,
      });
      expect(body.funds.every((fund) => fund.ret6m === null && fund.ret1y === null)).toBe(true);
      expect(body.funds.every((fund) => fund.bench1y === null)).toBe(true);
      // 1500 个请求的慢链路绝不能挂在用户请求上
      expect(source.calls.periods ?? 0).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('全量抓取：跳过货币 ETF，落库后 dataset 带 6月/1年/3年与沪深300 基准', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      // 抓取名单来自最新行情，先落一次快照
      await app.inject({ method: 'POST', url: '/api/tools/etf/refresh' });
      const response = await app.inject({
        method: 'POST',
        url: '/api/tools/etf/periods/refresh?full=1',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as EtfPeriodRefreshResponse;
      expect(body).toMatchObject({
        ok: true,
        full: true,
        scanned: 7,
        updated: 7,
        failed: 0,
        skipped: false,
      });
      // 货币 ETF（511990）不在名单里
      expect(source.lastPeriodCodes).not.toContain('511990');
      expect(source.lastPeriodCodes).toHaveLength(7);

      const dataset = await datasetOf(app);
      expect(dataset.periodReturns).toMatchObject({
        updatedAt: expect.any(String),
        dataDate: '2026-09-22',
        total: 7,
        covered1y: 7,
        covered3y: 7,
      });
      const hs300 = dataset.funds.find((fund) => fund.code === '510300');
      expect(hs300).toMatchObject({
        ret6m: 6,
        ret1y: 12,
        ret3y: 36,
        bench1y: 5,
        bench3y: 15,
        mainInflow: -22_936_530,
      });
      // 货币 ETF 没抓 → 字段保持 null
      expect(dataset.funds.find((fund) => fund.code === '511990')?.ret1y).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('行还没过期（<7 天）时增量刷新直接跳过，不打任何上游', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      await app.inject({ method: 'POST', url: '/api/tools/etf/refresh' });
      await app.inject({ method: 'POST', url: '/api/tools/etf/periods/refresh?full=1' });
      expect(source.calls.periods).toBe(1);

      const second = await app.inject({ method: 'POST', url: '/api/tools/etf/periods/refresh' });
      const body = second.json() as EtfPeriodRefreshResponse;
      expect(body).toMatchObject({ skipped: true, scanned: 0, updated: 0 });
      expect(body.message).toContain('未请求上游');
      expect(source.calls.periods).toBe(1);

      // 过了 7 天：行全部过期，重新进入抓取名单
      app.setNow(Date.parse('2026-09-22T10:00:00.000Z') + 8 * 24 * 3_600_000);
      const third = await app.inject({ method: 'POST', url: '/api/tools/etf/periods/refresh' });
      expect(third.json() as EtfPeriodRefreshResponse).toMatchObject({
        skipped: false,
        scanned: 7,
      });
      expect(source.calls.periods).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('单只失败保留旧行（captured_at 不前进），成功的照常落库', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      await app.inject({ method: 'POST', url: '/api/tools/etf/refresh' });
      await app.inject({ method: 'POST', url: '/api/tools/etf/periods/refresh?full=1' });

      // 510300 换个数值再抓一次，但这只失败 → 旧行（12%）必须原样保留
      source.periods = new Map([
        [
          '159915',
          {
            periods: [
              { title: '6Y', ret: '9', avg: null, bench: null, rank: null, total: null },
              { title: '1N', ret: '99', avg: null, bench: null, rank: null, total: null },
              { title: '3N', ret: '999', avg: null, bench: null, rank: null, total: null },
            ],
            estabDate: null,
            time: '2026-09-23',
          },
        ],
      ]);
      source.failures.add('period:510300');
      const second = await app.inject({
        method: 'POST',
        url: '/api/tools/etf/periods/refresh?full=1',
      });
      expect(second.json() as EtfPeriodRefreshResponse).toMatchObject({
        failed: 1,
        updated: 6,
      });

      const dataset = await datasetOf(app);
      expect(dataset.funds.find((fund) => fund.code === '510300')?.ret1y).toBe(12);
      expect(dataset.funds.find((fund) => fund.code === '159915')?.ret1y).toBe(99);
      // 行都还新鲜（<7 天）→ 增量跳过；失败的行 captured_at 没前进，
      // 行过期后（下一轮每周任务的节奏）会自动带上它重试
      const fresh = await app.inject({ method: 'POST', url: '/api/tools/etf/periods/refresh' });
      expect(fresh.json() as EtfPeriodRefreshResponse).toMatchObject({ skipped: true });

      source.failures.delete('period:510300');
      app.setNow(Date.parse('2026-09-22T10:00:00.000Z') + 8 * 24 * 3_600_000);
      const third = await app.inject({ method: 'POST', url: '/api/tools/etf/periods/refresh' });
      expect(third.json() as EtfPeriodRefreshResponse).toMatchObject({
        skipped: false,
        scanned: 7,
        failed: 0,
      });
      const healed = await datasetOf(app);
      expect(healed.funds.find((fund) => fund.code === '510300')?.ret1y).toBe(12);
    } finally {
      await app.close();
    }
  });

  it('定时任务 etf.periods：首次必跑，距上次不足 6 天直接跳过', async () => {
    const { app, scheduler, source } = await etfHarness({ eastmoney: true });
    try {
      await app.inject({ method: 'POST', url: '/api/tools/etf/refresh' });
      const first = await scheduler.execute('etf.periods', 'manual');
      expect(first?.stats).toMatchObject({ skipped: false, scanned: 7 });

      const second = await scheduler.execute('etf.periods', 'manual');
      expect(second?.stats).toMatchObject({ skipped: true });
      expect(source.calls.periods).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('份额按日积累：跨天后给出变化率（净申购代理），起点保持在首个快照日', async () => {
    const { app, source } = await etfHarness({ eastmoney: true });
    try {
      const day1 = await datasetOf(app);
      const first = day1.funds.find((fund) => fund.code === '510300');
      // 只积累了一天 → 变化率必须是 null（0% 会被误读成「没变化」）
      expect(first).toMatchObject({ sharesChangePct: null, sharesSince: '2026-09-22' });

      // 第二天：行情时间 +1 天、510300 份额 +10%（一级市场净申购）
      source.spot = source.spot.map((item) =>
        item.code === '510300' ? { ...item, quoteTs: (item.quoteTs ?? 0) + 86_400 } : item,
      );
      source.profiles = source.profiles.map((row) =>
        row.code === '510300' && row.shares !== null ? { ...row, shares: row.shares * 1.1 } : row,
      );
      const refreshed = await app.inject({ method: 'POST', url: '/api/tools/etf/refresh' });
      expect(refreshed.statusCode).toBe(200);

      const day2 = await datasetOf(app);
      const second = day2.funds.find((fund) => fund.code === '510300');
      expect(second?.sharesSince).toBe('2026-09-22');
      expect(second?.sharesChangePct).toBeCloseTo(10, 6);
      // 其它 ETF 没变份额 → 0%（真实的变化率，与「还没积累」的 null 区分开）
      const untouched = day2.funds.find((fund) => fund.code === '512880');
      expect(untouched?.sharesChangePct).toBeCloseTo(0, 6);
    } finally {
      await app.close();
    }
  });
});
