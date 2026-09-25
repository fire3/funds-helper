import type {
  QdiiChangesResponse,
  QdiiFundDetailResponse,
  QdiiPremiumResponse,
  QdiiRefreshResponse,
} from '@funds-helper/shared';
import { describe, expect, it } from 'vitest';
import { createHarness } from './testing/app-harness.ts';

async function datasetReady(h: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  await h.inject({ method: 'GET', url: '/api/tools/qdii/dataset' });
}

describe('GET /api/tools/qdii/funds/:code', () => {
  it('聚合详情：基础信息 / 净值走势 / 阶段收益 / 持仓 / 公告', async () => {
    const h = await createHarness();
    try {
      await datasetReady(h);
      const response = await h.inject({ method: 'GET', url: '/api/tools/qdii/funds/270042' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as QdiiFundDetailResponse;
      expect(body.code).toBe('270042');
      expect(body.record?.region).toBe('纳斯达克100');
      expect(body.base?.company).toBe('广发基金');
      expect(body.base?.rate).toBe('0.13%');
      expect(body.base?.nextOpenDate).toBeNull(); // "--" → null

      expect(body.navTrend.length).toBe(5);
      expect(body.navTrend.at(-1)).toMatchObject({ date: '2026-09-30', nav: 110 });
      // 没有分拆/分红 → 无需解释，也不改变区间统计口径
      expect(body.navEvents).toEqual([]);
      expect(body.navSummaryNote).toBeNull();

      expect(body.scale).toHaveLength(2);
      expect(body.allocation.map((item) => item.name)).toEqual(['股票占净比', '现金占净比']);
      expect(body.holders.map((item) => item.name)).toContain('机构持有比例');

      expect(body.reportDate).toBe('2026-06-30');
      expect(body.holdings.etf).toEqual({ code: '159941', name: '纳指ETF广发' });

      expect(body.notices[0]).toMatchObject({ publishDate: '2026-09-10' });
      expect(body.notices[0]?.url).toContain('gonggao/270042');
      expect(body.errors).toEqual([]);
      expect(body.disclaimer).toContain('仅供参考');
    } finally {
      await h.close();
    }
  });

  it('区间统计给出涨幅与最大回撤', async () => {
    const h = await createHarness();
    try {
      await datasetReady(h);
      const body = (
        await h.inject({ method: 'GET', url: '/api/tools/qdii/funds/270042' })
      ).json() as QdiiFundDetailResponse;

      const month = body.navSummary.find((row) => row.label === '近1月');
      expect(month?.returnPct).toBe(10);
      expect(month?.maxDrawdownPct).toBe(-25);
    } finally {
      await h.close();
    }
  });

  it('阶段收益按周期排序，Y=月 / N=年', async () => {
    const h = await createHarness();
    try {
      await datasetReady(h);
      const body = (
        await h.inject({ method: 'GET', url: '/api/tools/qdii/funds/270042' })
      ).json() as QdiiFundDetailResponse;

      expect(body.periods.map((period) => period.label)).toEqual(['近1周', '近1年', '成立来']);
      // 成立来没有同类基准，兜底为 null
      expect(body.periods.at(-1)?.avg).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('给出同基金其它份额类别（A/C 选择）与购买建议', async () => {
    const h = await createHarness();
    try {
      await datasetReady(h);
      const body = (
        await h.inject({ method: 'GET', url: '/api/tools/qdii/funds/270042' })
      ).json() as QdiiFundDetailResponse;

      expect(body.shareClasses.map((item) => item.code)).toEqual(['006479']);
      expect(body.advice.some((item) => item.title.includes('额度极紧'))).toBe(true);
      expect(body.advice.some((item) => item.title === '赎回费红线')).toBe(true);
      expect(body.advice.some((item) => item.text.includes('广发基金'))).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('代码格式非法 → 400 BAD_REQUEST', async () => {
    const h = await createHarness();
    try {
      const response = await h.inject({ method: 'GET', url: '/api/tools/qdii/funds/abc123' });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    } finally {
      await h.close();
    }
  });

  it('不是 QDII 的代码 → 404 NOT_FOUND', async () => {
    const h = await createHarness();
    try {
      await datasetReady(h);
      const response = await h.inject({ method: 'GET', url: '/api/tools/qdii/funds/999999' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    } finally {
      await h.close();
    }
  });

  it('部分区块失败不影响其它区块（每块独立容错）', async () => {
    const h = await createHarness();
    try {
      await datasetReady(h);
      h.source.failures.add('pingzhong');
      h.source.failures.add('period');
      h.source.failures.add('holdings');

      const response = await h.inject({ method: 'GET', url: '/api/tools/qdii/funds/270042' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as QdiiFundDetailResponse;
      expect(body.errors).toHaveLength(3);
      expect(body.navTrend).toEqual([]);
      expect(body.periods).toEqual([]);
      // 仍可用的区块照常返回
      expect(body.base?.company).toBe('广发基金');
      expect(body.notices).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('详情结果按 code 缓存，重复请求不打上游', async () => {
    const h = await createHarness();
    try {
      await datasetReady(h);
      await h.inject({ method: 'GET', url: '/api/tools/qdii/funds/270042' });
      await h.inject({ method: 'GET', url: '/api/tools/qdii/funds/270042' });
      expect(h.source.calls.detail).toBe(1);
      expect(h.source.calls.pingzhong).toBe(1);
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/tools/qdii/premium', () => {
  it('只包含场内交易品种，并把折价率转换成溢价率语义', async () => {
    const h = await createHarness();
    try {
      const response = await h.inject({ method: 'GET', url: '/api/tools/qdii/premium' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as QdiiPremiumResponse;
      expect(body.items.map((item) => item.code)).toEqual(['513100']);
      // f402 = -8.24（折价），语义转换后溢价 8.24%
      expect(body.items[0]?.discountRate).toBe(-8.24);
      expect(body.items[0]?.premiumRate).toBe(8.24);
    } finally {
      await h.close();
    }
  });

  it('行情接口失败时回退到最近一次落库的溢价，并标记 stale', async () => {
    const h = await createHarness();
    try {
      await h.inject({ method: 'GET', url: '/api/tools/qdii/premium' }); // 先成功一次，落库
      h.source.failures.add('quotes');

      const response = await h.inject({ method: 'GET', url: '/api/tools/qdii/premium?refresh=1' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as QdiiPremiumResponse;
      expect(body.freshness.stale).toBe(true);
      expect(body.items).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('从未成功拉过行情时，行情失败 → 503', async () => {
    const h = await createHarness();
    try {
      h.source.failures.add('quotes');
      const response = await h.inject({ method: 'GET', url: '/api/tools/qdii/premium' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } });
    } finally {
      await h.close();
    }
  });
});

describe('POST /api/tools/qdii/refresh 与额度变更', () => {
  it('首次刷新落库全部快照，且不产生变更事件（只建基线）', async () => {
    const h = await createHarness();
    try {
      const response = await h.inject({ method: 'POST', url: '/api/tools/qdii/refresh' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as QdiiRefreshResponse;
      expect(body.ok).toBe(true);
      expect(body.total).toBe(6);
      expect(body.inserted).toBe(6);
      expect(body.changed).toBe(0);
      expect(body.message).toContain('2026-09-14');

      const changes = (
        await h.inject({ method: 'GET', url: '/api/tools/qdii/changes' })
      ).json() as QdiiChangesResponse;
      expect(changes.items).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('第二天额度收紧会被检测为 tightened', async () => {
    const h = await createHarness();
    try {
      await h.inject({ method: 'POST', url: '/api/tools/qdii/refresh' });

      // 模拟第二天的数据：270042 从 2 元降到 1 元，050025 从暂停申购变为限大额
      h.source.showday = ['2026-09-15', '2026-09-14'];
      h.source.rows = h.source.rows.map((item) => {
        if (item.code === '270042') return { ...item, dailyLimit: '1.0' };
        if (item.code === '050025') {
          return { ...item, purchaseStatus: '限大额', dailyLimit: '100.0' };
        }
        return item;
      });

      const response = await h.inject({ method: 'POST', url: '/api/tools/qdii/refresh' });
      const body = response.json() as QdiiRefreshResponse;
      expect(body.inserted).toBe(6);
      expect(body.changed).toBeGreaterThanOrEqual(2);

      const changes = (
        await h.inject({ method: 'GET', url: '/api/tools/qdii/changes' })
      ).json() as QdiiChangesResponse;

      const limitChange = changes.items.find(
        (item) => item.code === '270042' && item.field === 'daily_limit',
      );
      expect(limitChange).toMatchObject({
        oldValue: '2',
        newValue: '1',
        direction: 'tightened',
        dataDate: '2026-09-15',
      });

      const statusChange = changes.items.find(
        (item) => item.code === '050025' && item.field === 'status',
      );
      expect(statusChange?.direction).toBe('loosened');

      expect(changes.summary.tightened).toBeGreaterThanOrEqual(1);
      expect(changes.summary.loosened).toBeGreaterThanOrEqual(1);
      expect(changes.freshness.dataDate).toBe('2026-09-15');
    } finally {
      await h.close();
    }
  });

  it('同一数据日重复抓取不会重复插入同一条变更', async () => {
    const h = await createHarness();
    try {
      await h.inject({ method: 'POST', url: '/api/tools/qdii/refresh' });

      // 第二天：270042 从 2 元降到 1 元
      h.source.showday = ['2026-09-15', '2026-09-14'];
      h.source.rows = h.source.rows.map((item) =>
        item.code === '270042' ? { ...item, dailyLimit: '1.0' } : item,
      );

      await h.inject({ method: 'POST', url: '/api/tools/qdii/refresh' });
      // 再抓一次。基线日仍是 09-14，diff 会再次产出同一条事件 —— 必须去重
      await h.inject({ method: 'POST', url: '/api/tools/qdii/refresh' });

      const changes = (
        await h.inject({ method: 'GET', url: '/api/tools/qdii/changes' })
      ).json() as QdiiChangesResponse;

      const limitChanges = changes.items.filter(
        (item) => item.code === '270042' && item.field === 'daily_limit',
      );
      expect(limitChanges).toHaveLength(1);
      expect(limitChanges[0]).toMatchObject({
        oldValue: '2',
        newValue: '1',
        direction: 'tightened',
        dataDate: '2026-09-15',
      });
    } finally {
      await h.close();
    }
  });

  it('同一数据日内值再次变化时覆盖原条目，而不是新增一条', async () => {
    const h = await createHarness();
    try {
      await h.inject({ method: 'POST', url: '/api/tools/qdii/refresh' });

      h.source.showday = ['2026-09-15', '2026-09-14'];
      const setLimit = (value: string): void => {
        h.source.rows = h.source.rows.map((item) =>
          item.code === '270042' ? { ...item, dailyLimit: value } : item,
        );
      };

      setLimit('1.0');
      await h.inject({ method: 'POST', url: '/api/tools/qdii/refresh' });

      // 当天内上游又改了口径（1 → 0.5），仍属同一天的净变化
      setLimit('0.5');
      await h.inject({ method: 'POST', url: '/api/tools/qdii/refresh' });

      const changes = (
        await h.inject({ method: 'GET', url: '/api/tools/qdii/changes' })
      ).json() as QdiiChangesResponse;

      const limitChanges = changes.items.filter(
        (item) => item.code === '270042' && item.field === 'daily_limit',
      );
      expect(limitChanges).toHaveLength(1);
      expect(limitChanges[0]).toMatchObject({ oldValue: '2', newValue: '0.5' });
    } finally {
      await h.close();
    }
  });

  it('上游失败时刷新返回 503（不能假装成功）', async () => {
    const h = await createHarness();
    try {
      h.source.failures.add('snapshot');
      const response = await h.inject({ method: 'POST', url: '/api/tools/qdii/refresh' });
      expect(response.statusCode).toBe(503);
    } finally {
      await h.close();
    }
  });

  it('手动刷新会留下 job_run 记录（可在 /api/health 看到）', async () => {
    const h = await createHarness();
    try {
      await h.inject({ method: 'POST', url: '/api/tools/qdii/refresh' });

      const health = (await h.inject({ method: 'GET', url: '/api/health' })).json() as {
        jobs: { jobName: string; status: string }[];
      };

      const snapshotJob = health.jobs.find((job) => job.jobName === 'qdii.snapshot');
      expect(snapshotJob?.status).toBe('success');
    } finally {
      await h.close();
    }
  });
});
