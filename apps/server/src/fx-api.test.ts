import type { FxDatasetResponse, FxRefreshResponse } from '@funds-helper/shared';
import type { RawFxDailyBar } from '@funds-helper/sources';
import { describe, expect, it } from 'vitest';
import { createHarness } from './testing/app-harness.ts';
import { createFakeFxSource, type FakeFxSource } from './testing/fake-fx-source.ts';
import { createFxTool } from './tools/fx/index.ts';

type App = Awaited<ReturnType<typeof createHarness>>;

interface FxHarness {
  app: App;
  source: FakeFxSource;
}

async function fxHarness(bars?: RawFxDailyBar[]): Promise<FxHarness> {
  const source = createFakeFxSource(bars === undefined ? {} : { bars });
  const app = await createHarness({ buildTools: ({ now }) => [createFxTool({ source, now })] });
  return { app, source };
}

function lastBar(bars: readonly RawFxDailyBar[]): RawFxDailyBar {
  const bar = bars.at(-1);
  if (bar === undefined) throw new Error('假数据为空');
  return bar;
}

function barOnOrAfter(bars: readonly RawFxDailyBar[], date: string): RawFxDailyBar {
  const bar = bars.find((item) => item.date >= date);
  if (bar === undefined) throw new Error(`假数据中没有 ${date} 之后的点`);
  return bar;
}

describe('GET /api/tools/fx/dataset', () => {
  it('返回走势点、区间涨跌、年度表现与概要', async () => {
    const { app, source } = await fxHarness();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/tools/fx/dataset' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as FxDatasetResponse;

      expect(body.symbol).toBe('fx_fake');
      expect(body.direction).toBe('USD/CNY');
      expect(body.range).toBe('5y'); // 默认区间

      expect(body.summary.totalBars).toBe(3600);
      expect(body.summary.firstDate).toBe(source.bars[0]?.date);
      expect(body.summary.lastDate).toBe(lastBar(source.bars).date);
      expect(body.summary.latest).toEqual({
        date: lastBar(source.bars).date,
        rate: lastBar(source.bars).close,
      });

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
      expect(body.yearly.map((item) => item.year)).toEqual([
        '2015',
        '2016',
        '2017',
        '2018',
        '2019',
        '2020',
        '2021',
        '2022',
        '2023',
        '2024',
      ]);

      expect(body.freshness).toMatchObject({
        dataDate: lastBar(source.bars).date,
        stale: false,
        source: 'fake',
      });
      expect(body.disclaimer).toContain('银行');
      expect(body.points.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('区间越短点数越少，全部区间会被抽稀到阈值以内', async () => {
    const { app } = await fxHarness();
    try {
      const one = (
        await app.inject({ method: 'GET', url: '/api/tools/fx/dataset?range=1y' })
      ).json() as FxDatasetResponse;
      const three = (
        await app.inject({ method: 'GET', url: '/api/tools/fx/dataset?range=3y' })
      ).json() as FxDatasetResponse;
      const all = (
        await app.inject({ method: 'GET', url: '/api/tools/fx/dataset?range=all' })
      ).json() as FxDatasetResponse;

      expect(one.range).toBe('1y');
      expect(one.points.length).toBeGreaterThanOrEqual(365);
      expect(one.points.length).toBeLessThanOrEqual(367);
      expect(one.points.length).toBeLessThan(three.points.length);
      // 3600 根超出图表阈值 → 抽稀，但仍能看出全貌
      expect(all.points.length).toBeLessThanOrEqual(1601);
      expect(all.points.length).toBeGreaterThan(1000);
      // 抽稀不影响统计口径
      expect(all.summary.totalBars).toBe(3600);
    } finally {
      await app.close();
    }
  });

  it('非法区间回落默认值而不是报错（分享链接的手误不该变成错误页）', async () => {
    const { app } = await fxHarness();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/tools/fx/dataset?range=99y&direction=xxx',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as FxDatasetResponse;
      expect(body.range).toBe('5y');
      expect(body.direction).toBe('USD/CNY');
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/tools/fx/dataset —— 报价方向', () => {
  it('CNY/USD 是倒数，且 low/high 互换', async () => {
    const { app, source } = await fxHarness();
    try {
      const usd = (
        await app.inject({ method: 'GET', url: '/api/tools/fx/dataset?range=1y' })
      ).json() as FxDatasetResponse;
      const cny = (
        await app.inject({
          method: 'GET',
          url: '/api/tools/fx/dataset?range=1y&direction=CNY%2FUSD',
        })
      ).json() as FxDatasetResponse;

      expect(cny.direction).toBe('CNY/USD');
      const target = lastBar(source.bars);
      expect(cny.summary.latest.rate).toBeCloseTo(1 / target.close, 8);
      expect(usd.summary.latest.rate).toBeCloseTo(target.close, 8);

      const cnyLast = cny.points.at(-1);
      expect(cnyLast?.date).toBe(target.date);
      expect(cnyLast?.close).toBeCloseTo(1 / target.close, 8);
      // 反向后的最低 = 1 / 原最高
      expect(cnyLast?.low).toBeCloseTo(1 / (target.high ?? target.close), 8);
      expect(cnyLast?.high).toBeCloseTo(1 / (target.low ?? target.close), 8);
    } finally {
      await app.close();
    }
  });

  it('涨跌幅按方向重算（1/x 下不对称，不能前端取倒数）', async () => {
    const { app, source } = await fxHarness();
    try {
      const usd = (
        await app.inject({ method: 'GET', url: '/api/tools/fx/dataset?range=1y' })
      ).json() as FxDatasetResponse;
      const cny = (
        await app.inject({
          method: 'GET',
          url: '/api/tools/fx/dataset?range=1y&direction=CNY%2FUSD',
        })
      ).json() as FxDatasetResponse;

      const target = lastBar(source.bars);
      const yearStart = `${target.date.slice(0, 4)}-01-01`;
      const first = barOnOrAfter(source.bars, yearStart);

      const usdYtd = usd.intervals.find((item) => item.key === 'ytd');
      const cnyYtd = cny.intervals.find((item) => item.key === 'ytd');

      expect(usdYtd?.from).toBe(first.date);
      expect(usdYtd?.changePct).toBeCloseTo(((target.close - first.close) / first.close) * 100, 6);
      expect(cnyYtd?.changePct).toBeCloseTo(
        ((1 / target.close - 1 / first.close) / (1 / first.close)) * 100,
        6,
      );
      // 两个方向的涨跌幅必须不同 —— 这正是「必须在服务端算」的证据
      expect(usdYtd?.changePct).not.toBeCloseTo(cnyYtd?.changePct ?? 0, 3);
    } finally {
      await app.close();
    }
  });

  it('切换区间与方向都不打上游（缓存只落在全量历史这个不变量上）', async () => {
    const { app, source } = await fxHarness();
    try {
      await app.inject({ method: 'GET', url: '/api/tools/fx/dataset?range=1y' });
      await app.inject({ method: 'GET', url: '/api/tools/fx/dataset?range=5y' });
      await app.inject({
        method: 'GET',
        url: '/api/tools/fx/dataset?range=all&direction=CNY%2FUSD',
      });
      expect(source.calls.daily).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('重复请求走内存缓存', async () => {
    const { app, source } = await fxHarness();
    try {
      await app.inject({ method: 'GET', url: '/api/tools/fx/dataset' });
      await app.inject({ method: 'GET', url: '/api/tools/fx/dataset' });
      expect(source.calls.daily).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/tools/fx/refresh', () => {
  it('整段落库，重复抓取幂等（inserted = 0）', async () => {
    const { app, source } = await fxHarness();
    try {
      const first = (
        await app.inject({ method: 'POST', url: '/api/tools/fx/refresh' })
      ).json() as FxRefreshResponse;
      expect(first.ok).toBe(true);
      expect(first.bars).toBe(3600);
      expect(first.inserted).toBe(3600);
      expect(first.dataDate).toBe(lastBar(source.bars).date);
      expect(first.message).toContain('3600');

      const second = (
        await app.inject({ method: 'POST', url: '/api/tools/fx/refresh' })
      ).json() as FxRefreshResponse;
      expect(second.inserted).toBe(0);
      expect(second.bars).toBe(3600);
    } finally {
      await app.close();
    }
  });
});

describe('降级与错误暴露', () => {
  it('无本地数据时上游失败 → 503', async () => {
    const { app, source } = await fxHarness();
    try {
      source.failures.add('daily');
      const response = await app.inject({ method: 'GET', url: '/api/tools/fx/dataset' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } });
    } finally {
      await app.close();
    }
  });

  it('有数据时上游失败 → 200 且 stale，并带上真实原因', async () => {
    const { app, source } = await fxHarness();
    try {
      await app.inject({ method: 'GET', url: '/api/tools/fx/dataset' });
      expect(source.calls.daily).toBe(1);

      app.advance(7 * 3_600_000);
      source.failures.add('daily');
      const response = await app.inject({ method: 'GET', url: '/api/tools/fx/dataset?refresh=1' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as FxDatasetResponse;
      expect(body.summary.totalBars).toBe(3600);
      expect(body.freshness.stale).toBe(true);
      expect(body.freshness.staleReason).toContain('汇率日线接口不可用');
    } finally {
      await app.close();
    }
  });

  it('非上游的内部错误必须暴露为 500，不能伪装成「上游不可用」503', async () => {
    const { app, source } = await fxHarness();
    try {
      source.failures.add('daily:internal');
      const response = await app.inject({ method: 'GET', url: '/api/tools/fx/dataset' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: 'INTERNAL' } });
    } finally {
      await app.close();
    }
  });
});
