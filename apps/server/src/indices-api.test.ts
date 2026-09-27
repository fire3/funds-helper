import { INDEX_REGISTRY } from '@funds-helper/core';
import type {
  IndexDatasetResponse,
  IndexOverviewResponse,
  IndexRefreshResponse,
} from '@funds-helper/shared';
import { describe, expect, it } from 'vitest';
import { createHarness } from './testing/app-harness.ts';
import { createFakeIndicesSource, type FakeIndicesSource } from './testing/fake-indices-source.ts';
import { createIndicesTool } from './tools/indices/index.ts';

type App = Awaited<ReturnType<typeof createHarness>>;

interface IndicesHarness {
  app: App;
  source: FakeIndicesSource;
}

async function indicesHarness(): Promise<IndicesHarness> {
  const source = createFakeIndicesSource();
  const app = await createHarness({
    buildTools: ({ now }) => [createIndicesTool({ source, now })],
  });
  return { app, source };
}

const SPX_SERIES_ROWS = 3600;

describe('GET /api/tools/indices/dataset', () => {
  it('默认指数 SPX、默认区间 5y，返回走势点、区间涨跌、年度表现与概要', async () => {
    const { app } = await indicesHarness();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/tools/indices/dataset' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as IndexDatasetResponse;

      expect(body.code).toBe('SPX');
      expect(body.name).toBe('标普500');
      expect(body.currency).toBe('USD');
      expect(body.timeZone).toBe('America/New_York');
      expect(body.range).toBe('5y');

      expect(body.summary.totalBars).toBe(SPX_SERIES_ROWS);
      expect(body.summary.firstDate).toBe('2015-01-01');
      expect(body.summary.latest.value).toBeGreaterThan(0);
      expect(body.summary.previous).not.toBeNull();
      expect(body.summary.dayChangePct).not.toBeNull();

      expect(body.intervals.map((item) => item.key)).toEqual([
        '1m',
        '3m',
        '6m',
        '1y',
        '3y',
        '5y',
        'ytd',
        'all',
      ]);
      expect(body.yearly.map((item) => item.year)).toContain('2015');
      expect(body.yearly.map((item) => item.year)).toContain('2024');

      expect(body.freshness).toMatchObject({ stale: false, source: 'fake' });
      expect(body.freshness.dataDate).toBe(body.summary.lastDate);
      expect(body.disclaimer).toContain('Yahoo');
      expect(body.points.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('未知 code 回落默认指数（分享链接的手误不该变成错误页）', async () => {
    const { app } = await indicesHarness();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/tools/indices/dataset?code=%5ENOSUCH&range=99y',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as IndexDatasetResponse;
      expect(body.code).toBe('SPX');
      expect(body.range).toBe('5y');
    } finally {
      await app.close();
    }
  });

  it('切到东财缺位的指数（纳指100）同样有数据（主源是 Yahoo，注册表 em=null 不影响抓取）', async () => {
    const { app } = await indicesHarness();
    try {
      const body = (
        await app.inject({ method: 'GET', url: '/api/tools/indices/dataset?code=NDX' })
      ).json() as IndexDatasetResponse;
      expect(body.code).toBe('NDX');
      expect(body.name).toBe('纳斯达克100');
      expect(body.summary.totalBars).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('切换区间与指数都不重复打上游（缓存按「全量历史」分 key）', async () => {
    const { app, source } = await indicesHarness();
    try {
      await app.inject({ method: 'GET', url: '/api/tools/indices/dataset?range=1y' });
      await app.inject({ method: 'GET', url: '/api/tools/indices/dataset?range=all' });
      await app.inject({ method: 'GET', url: '/api/tools/indices/dataset?code=HSI&range=3y' });
      // SPX 一次 + HSI 一次
      expect(source.calls.fetch).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('区间越短点数越少，长区间被抽稀但统计仍基于全量', async () => {
    const { app } = await indicesHarness();
    try {
      const one = (
        await app.inject({ method: 'GET', url: '/api/tools/indices/dataset?range=1y' })
      ).json() as IndexDatasetResponse;
      const all = (
        await app.inject({ method: 'GET', url: '/api/tools/indices/dataset?range=all' })
      ).json() as IndexDatasetResponse;

      expect(one.points.length).toBeLessThanOrEqual(367);
      expect(all.points.length).toBeLessThanOrEqual(1601);
      expect(all.points.length).toBeGreaterThan(one.points.length);
      // 抽稀不影响统计口径
      expect(all.summary.totalBars).toBe(SPX_SERIES_ROWS);
      expect(all.summary.totalBars).toBe(one.summary.totalBars);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/tools/indices/overview', () => {
  it('按地区分组返回全部 28 个指数，逐条带自己的数据日期、来源与今开高低', async () => {
    const { app } = await indicesHarness();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/tools/indices/overview' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as IndexOverviewResponse;

      const items = body.regions.flatMap((region) => region.items);
      expect(items).toHaveLength(INDEX_REGISTRY.length);

      expect(body.regions.map((region) => region.key)).toEqual([
        'us',
        'hk',
        'apac',
        'europe',
        'americas',
      ]);

      const spx = items.find((item) => item.code === 'SPX');
      expect(spx?.price).toBeGreaterThan(0);
      expect(spx?.changePct).not.toBeNull();
      expect(spx?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(spx?.source).toBe('fake');
      // 卡片的今开/最高/最低（库里最新一根的 OHLC）
      expect(spx?.open).not.toBeNull();
      expect(spx?.high).toBeGreaterThanOrEqual(spx?.price ?? 0);
      expect(spx?.low).toBeLessThanOrEqual(spx?.price ?? 0);

      expect(body.freshness.stale).toBe(false);
      expect(body.freshness.dataDate).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('单个指数日线失败（从未入库）→ 批量实时补齐，概览仍完整', async () => {
    const { app, source } = await indicesHarness();
    try {
      source.failCodes.add('NZ50');
      const body = (
        await app.inject({ method: 'GET', url: '/api/tools/indices/overview' })
      ).json() as IndexOverviewResponse;
      const items = body.regions.flatMap((region) => region.items);
      expect(items).toHaveLength(INDEX_REGISTRY.length);

      const nz50 = items.find((item) => item.code === 'NZ50');
      expect(nz50?.source).toBe('fake-live');
      expect(nz50?.price).toBe(12345.67);
      expect(nz50?.prevClose).toBe(12300);
      // harness 固定 now = 2026-09-14T10:00Z（周一）→ 各时区交易日都是 09-14
      expect(nz50?.date).toBe('2026-09-14');
      // 部分失败不算失败：日线链路整体是成功的，不标 stale
      expect(body.freshness.stale).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('重复请求走内存缓存，不重复打上游', async () => {
    const { app, source } = await indicesHarness();
    try {
      await app.inject({ method: 'GET', url: '/api/tools/indices/overview' });
      await app.inject({ method: 'GET', url: '/api/tools/indices/overview' });
      expect(source.calls.fetch).toBe(INDEX_REGISTRY.length);
    } finally {
      await app.close();
    }
  });

  it('先抓单指数再进概览 → 自动补齐其余指数（全局年龄还很新也不能漏）', async () => {
    const { app, source } = await indicesHarness();
    try {
      // 只打开了 SPX 的走势：库里只有 1 个指数，但 capturedAt 是“刚刚”
      await app.inject({ method: 'GET', url: '/api/tools/indices/dataset' });
      expect(source.calls.fetch).toBe(1);

      const body = (
        await app.inject({ method: 'GET', url: '/api/tools/indices/overview' })
      ).json() as IndexOverviewResponse;
      const items = body.regions.flatMap((region) => region.items);
      expect(items).toHaveLength(INDEX_REGISTRY.length);
      // 1（先抓 SPX）+ captureAll 对全部 28 个做一轮增量（含已抓过的 SPX，回看 10 天，代价可忽略）
      expect(source.calls.fetch).toBe(1 + INDEX_REGISTRY.length);
      expect(body.freshness.stale).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('库里已有大部分新鲜数据、只有少数指数永远补不上 → 立即返回，抓取转后台', async () => {
    const { app, source } = await indicesHarness();
    try {
      // 模拟「稳定源里没有代码」的指数（罗素/VIX/恒生科技）：它们从未入库，
      // hasMissing 因此长期为真 —— 这正是线上每次重建概览都同步卡 40 秒的触发条件。
      for (const code of ['RUT', 'VIX', 'HSTECH']) source.failCodes.add(code);
      await app.inject({ method: 'GET', url: '/api/tools/indices/overview' });
      const afterFirst = source.calls.fetch ?? 0;
      expect(afterFirst).toBe(INDEX_REGISTRY.length);

      // 闸门卡住上游：若概览仍**同步**等抓取，这个 inject 会一直挂到测试超时
      let release!: () => void;
      source.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/tools/indices/overview?refresh=1',
      });
      expect(response.statusCode).toBe(200);
      const items = (response.json() as IndexOverviewResponse).regions.flatMap(
        (region) => region.items,
      );
      // 用的是库里的快照（4 个从未入库的指数里只有东财有代码的恒生国企能被实时补齐）
      expect(items.length).toBeGreaterThan(0);
      // 后台确实已经开始抓：第一个指数进来就被闸门挡住
      expect(source.calls.fetch).toBeGreaterThan(afterFirst);

      // 放行并等后台任务收尾，避免它在 app.close() 之后还写库
      release();
      source.gate = null;
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 0);
      });
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/tools/indices/refresh', () => {
  it('整段落库，重复抓取幂等（inserted = 0）', async () => {
    const { app } = await indicesHarness();
    try {
      const first = (
        await app.inject({ method: 'POST', url: '/api/tools/indices/refresh' })
      ).json() as IndexRefreshResponse;
      expect(first.ok).toBe(true);
      expect(first.indices).toBe(INDEX_REGISTRY.length);
      expect(first.failed).toEqual([]);
      expect(first.inserted).toBeGreaterThan(0);
      expect(first.message).toContain('已更新');

      const second = (
        await app.inject({ method: 'POST', url: '/api/tools/indices/refresh' })
      ).json() as IndexRefreshResponse;
      expect(second.inserted).toBe(0);
      expect(second.bars).toBe(first.bars);
    } finally {
      await app.close();
    }
  });

  it('单个指数故障 → 部分失败可见（failed 列表），但其余指数照常更新', async () => {
    const { app, source } = await indicesHarness();
    try {
      await app.inject({ method: 'POST', url: '/api/tools/indices/refresh' });

      source.failCodes.add('VIX');
      app.advance(7 * 3_600_000);
      const partial = (
        await app.inject({ method: 'POST', url: '/api/tools/indices/refresh' })
      ).json() as IndexRefreshResponse;

      expect(partial.ok).toBe(false);
      expect(partial.indices).toBe(INDEX_REGISTRY.length - 1);
      expect(partial.failed.map((item) => item.code)).toEqual(['VIX']);

      // 概览仍完整：VIX 保留上一次抓到的数据（陈旧但真实）
      const overview = (
        await app.inject({ method: 'GET', url: '/api/tools/indices/overview' })
      ).json() as IndexOverviewResponse;
      const items = overview.regions.flatMap((region) => region.items);
      expect(items).toHaveLength(INDEX_REGISTRY.length);
      expect(overview.freshness.stale).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('降级与错误暴露', () => {
  it('无本地数据时上游失败 → 503', async () => {
    const { app, source } = await indicesHarness();
    try {
      source.failures.add('fetch');
      const response = await app.inject({ method: 'GET', url: '/api/tools/indices/dataset' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } });
    } finally {
      await app.close();
    }
  });

  it('概览：无数据且日线与批量实时都失败 → 503', async () => {
    const { app, source } = await indicesHarness();
    try {
      source.failures.add('fetch');
      source.failures.add('live');
      const response = await app.inject({ method: 'GET', url: '/api/tools/indices/overview' });
      expect(response.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('概览：无数据且日线失败，但批量实时可用 → 200 降级补齐（不白屏，但标 stale）', async () => {
    const { app, source } = await indicesHarness();
    try {
      source.failures.add('fetch');
      const response = await app.inject({ method: 'GET', url: '/api/tools/indices/overview' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as IndexOverviewResponse;

      const items = body.regions.flatMap((region) => region.items);
      // 实时报价只能覆盖有东财代码的指数（em=null 的纳指100/罗素/VIX/恒生科技补不了）
      const expected = INDEX_REGISTRY.filter((entry) => entry.em !== null).length;
      expect(items).toHaveLength(expected);
      expect(items.every((item) => item.source === 'fake-live')).toBe(true);

      expect(body.freshness.stale).toBe(true);
      expect(body.freshness.staleReason).toContain('指数日线接口不可用');
    } finally {
      await app.close();
    }
  });

  it('有数据时上游失败 → 200 且 stale，并带上真实原因', async () => {
    const { app, source } = await indicesHarness();
    try {
      await app.inject({ method: 'GET', url: '/api/tools/indices/dataset' });
      expect(source.calls.fetch).toBe(1);

      app.advance(7 * 3_600_000);
      source.failures.add('fetch');
      const response = await app.inject({
        method: 'GET',
        url: '/api/tools/indices/dataset?refresh=1',
      });
      expect(response.statusCode).toBe(200);

      const body = response.json() as IndexDatasetResponse;
      expect(body.summary.totalBars).toBe(SPX_SERIES_ROWS);
      expect(body.freshness.stale).toBe(true);
      expect(body.freshness.staleReason).toContain('指数日线接口不可用');
    } finally {
      await app.close();
    }
  });

  it('概览：有数据时上游失败 → 200 且 stale', async () => {
    const { app, source } = await indicesHarness();
    try {
      await app.inject({ method: 'GET', url: '/api/tools/indices/overview' });

      app.advance(7 * 3_600_000);
      source.failures.add('fetch');
      const body = (
        await app.inject({ method: 'GET', url: '/api/tools/indices/overview?refresh=1' })
      ).json() as IndexOverviewResponse;

      expect(body.regions.length).toBeGreaterThan(0);
      expect(body.freshness.stale).toBe(true);
      expect(body.freshness.staleReason).toContain('指数日线接口不可用');
    } finally {
      await app.close();
    }
  });

  it('非上游的内部错误必须暴露为 500，不能伪装成「上游不可用」503', async () => {
    const { app, source } = await indicesHarness();
    try {
      source.failures.add('fetch:internal');
      const response = await app.inject({ method: 'GET', url: '/api/tools/indices/dataset' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: 'INTERNAL' } });
    } finally {
      await app.close();
    }
  });
});
