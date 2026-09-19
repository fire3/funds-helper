import type {
  UsdDatasetResponse,
  UsdFundDetailResponse,
  UsdRefreshResponse,
} from '@funds-helper/shared';
import { describe, expect, it } from 'vitest';
import { createHarness } from './testing/app-harness.ts';
import { usdRows } from './testing/fake-qdii-source.ts';
import { createUsdTool } from './tools/usd/index.ts';

async function usdHarness(): Promise<Awaited<ReturnType<typeof createHarness>>> {
  return createHarness({
    rows: usdRows(),
    buildTools: ({ source, now }) => [createUsdTool({ source, now })],
  });
}

describe('GET /api/tools/usd/dataset', () => {
  it('从全市场筛出美元份额，过滤掉人民币份额与非美元基金', async () => {
    const h = await usdHarness();
    try {
      const response = await h.inject({ method: 'GET', url: '/api/tools/usd/dataset' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as UsdDatasetResponse;
      expect(body.total).toBe(4);
      const codes = body.funds.map((fund) => fund.code);
      expect(codes).toEqual(['011000', '011002', '011003', '011004']);
      expect(codes).not.toContain('011001'); // 人民币同类份额
      expect(codes).not.toContain('000001'); // 非美元基金
    } finally {
      await h.close();
    }
  });

  it('每条记录带份额形式、归类与额度文案', async () => {
    const h = await usdHarness();
    try {
      const body = (
        await h.inject({ method: 'GET', url: '/api/tools/usd/dataset' })
      ).json() as UsdDatasetResponse;

      const spot = body.funds.find((fund) => fund.code === '011000');
      expect(spot).toMatchObject({
        currency: 'USD',
        usdKind: '现汇',
        region: '美国',
        theme: '综合配置',
        status: '限大额',
        buyable: true,
        // 上游 0 值 = 渠道不售，必须与「无限额」区分
        limitText: '渠道不适用',
      });
      expect(spot?.dailyLimitNote).toContain('银行');

      const open = body.funds.find((fund) => fund.code === '011002');
      expect(open).toMatchObject({ usdKind: '未标注', limitText: '无限额', buyable: true });

      const suspended = body.funds.find((fund) => fund.code === '011003');
      expect(suspended).toMatchObject({ usdKind: '现钞', limitText: '暂停申购', buyable: false });

      const realLimit = body.funds.find((fund) => fund.code === '011004');
      expect(realLimit).toMatchObject({ limitText: '5,000.00 美元', dailyLimit: 5000 });

      expect(body.funds.every((fund) => fund.capturedAt && fund.dataDate === '2026-09-14')).toBe(
        true,
      );
    } finally {
      await h.close();
    }
  });

  it('统计与分类覆盖', async () => {
    const h = await usdHarness();
    try {
      const body = (
        await h.inject({ method: 'GET', url: '/api/tools/usd/dataset' })
      ).json() as UsdDatasetResponse;

      expect(body.stats.buyable).toBe(3); // 011000 / 011002 / 011004
      expect(body.stats.usdKind).toMatchObject({ 现汇: 2, 现钞: 1, 未标注: 1 });
      expect(body.stats.status).toMatchObject({ 限大额: 2, 开放申购: 1, 暂停申购: 1 });

      const regionSum = body.categories.regions.reduce((sum, item) => sum + item.count, 0);
      const themeSum = body.categories.themes.reduce((sum, item) => sum + item.count, 0);
      expect(regionSum).toBe(body.total);
      expect(themeSum).toBe(body.total);

      expect(body.freshness).toMatchObject({
        dataDate: '2026-09-14',
        stale: false,
        source: 'fake',
      });
    } finally {
      await h.close();
    }
  });

  it('第二次请求走缓存，不再打上游', async () => {
    const h = await usdHarness();
    try {
      await h.inject({ method: 'GET', url: '/api/tools/usd/dataset' });
      await h.inject({ method: 'GET', url: '/api/tools/usd/dataset' });
      expect(h.source.calls.snapshot).toBe(1);
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/tools/usd/funds/:code', () => {
  it('聚合通用详情区块，并给出同基金人民币份额对照', async () => {
    const h = await usdHarness();
    try {
      await h.inject({ method: 'GET', url: '/api/tools/usd/dataset' });
      const response = await h.inject({ method: 'GET', url: '/api/tools/usd/funds/011000' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as UsdFundDetailResponse;
      expect(body.code).toBe('011000');
      expect(body.record?.usdKind).toBe('现汇');
      expect(body.base?.company).toBe('广发基金');

      expect(body.navTrend).toHaveLength(5);
      expect(body.periods.map((period) => period.label)).toEqual(['近1周', '近1年', '成立来']);
      expect(body.holdings.etf).toEqual({ code: '159941', name: '纳指ETF广发' });
      expect(body.notices[0]?.url).toContain('gonggao/011000');

      // 人民币份额对照
      expect(body.cnySiblings.map((item) => item.code)).toEqual(['011001']);
      expect(body.errors).toEqual([]);
      expect(body.disclaimer).toContain('仅供参考');
    } finally {
      await h.close();
    }
  });

  it('代码格式非法 → 400，未知代码 → 404', async () => {
    const h = await usdHarness();
    try {
      const bad = await h.inject({ method: 'GET', url: '/api/tools/usd/funds/abc123' });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });

      await h.inject({ method: 'GET', url: '/api/tools/usd/dataset' });
      const missing = await h.inject({ method: 'GET', url: '/api/tools/usd/funds/999999' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    } finally {
      await h.close();
    }
  });

  it('详情结果按 code 缓存，重复请求不打上游', async () => {
    const h = await usdHarness();
    try {
      await h.inject({ method: 'GET', url: '/api/tools/usd/dataset' });
      await h.inject({ method: 'GET', url: '/api/tools/usd/funds/011000' });
      await h.inject({ method: 'GET', url: '/api/tools/usd/funds/011000' });
      expect(h.source.calls.detail).toBe(1);
    } finally {
      await h.close();
    }
  });
});

describe('POST /api/tools/usd/refresh 与降级', () => {
  it('刷新落库并在重复抓取时幂等', async () => {
    const h = await usdHarness();
    try {
      const first = (
        await h.inject({ method: 'POST', url: '/api/tools/usd/refresh' })
      ).json() as UsdRefreshResponse;
      expect(first.ok).toBe(true);
      expect(first.total).toBe(4);
      expect(first.inserted).toBe(4);

      const second = (
        await h.inject({ method: 'POST', url: '/api/tools/usd/refresh' })
      ).json() as UsdRefreshResponse;
      expect(second.inserted).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('非上游的内部错误必须暴露为 500，不能伪装成「上游不可用」503', async () => {
    const h = await usdHarness();
    try {
      h.source.failures.add('snapshot:internal');
      const response = await h.inject({ method: 'GET', url: '/api/tools/usd/dataset' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: 'INTERNAL' } });
    } finally {
      await h.close();
    }
  });

  it('无本地数据时上游失败 → 503；有数据时 → 200 且 stale', async () => {
    const h = await usdHarness();
    try {
      h.source.failures.add('snapshot');
      const failed = await h.inject({ method: 'GET', url: '/api/tools/usd/dataset' });
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } });

      h.source.failures.delete('snapshot');
      await h.inject({ method: 'GET', url: '/api/tools/usd/dataset' });

      h.advance(7 * 3_600_000);
      h.source.failures.add('snapshot');
      const stale = await h.inject({ method: 'GET', url: '/api/tools/usd/dataset?refresh=1' });
      expect(stale.statusCode).toBe(200);
      const body = stale.json() as UsdDatasetResponse;
      expect(body.total).toBe(4);
      expect(body.freshness.stale).toBe(true);
    } finally {
      await h.close();
    }
  });
});
