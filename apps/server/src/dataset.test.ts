import type { QdiiDatasetResponse } from '@funds-helper/shared';
import { describe, expect, it } from 'vitest';
import { createHarness } from './testing/app-harness.ts';

describe('基础设施路由', () => {
  it('GET /api/health 返回服务与依赖状态', async () => {
    const h = await createHarness();
    try {
      const response = await h.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as {
        status: string;
        db: { ok: boolean; path: string };
        tools: { id: string }[];
      };
      expect(body.status).toBe('ok');
      expect(body.db.ok).toBe(true);
      expect(body.db.path).toBe(':memory:');
      expect(body.tools.map((tool) => tool.id)).toContain('qdii');
    } finally {
      await h.close();
    }
  });

  it('GET /api/tools 返回工具清单（由注册表生成）', async () => {
    const h = await createHarness();
    try {
      const response = await h.inject({ method: 'GET', url: '/api/tools' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as { tools: { id: string; name: string; question: string }[] };
      const qdii = body.tools.find((tool) => tool.id === 'qdii');
      expect(qdii?.name).toBe('QDII 额度');
      expect(qdii?.question).toContain('今天还能买多少');
    } finally {
      await h.close();
    }
  });

  it('未知路由返回统一错误模型', async () => {
    const h = await createHarness();
    try {
      const response = await h.inject({ method: 'GET', url: '/api/nope' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/tools/qdii/dataset', () => {
  it('返回全量数据集，过滤掉非 QDII', async () => {
    const h = await createHarness();
    try {
      const response = await h.inject({ method: 'GET', url: '/api/tools/qdii/dataset' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as QdiiDatasetResponse;
      // 假数据源 7 行，其中 1 行是「混合型-灵活」，应被 QDII 口径过滤
      expect(body.total).toBe(6);
      expect(body.funds.map((fund) => fund.code)).not.toContain('000001');
    } finally {
      await h.close();
    }
  });

  it('每条记录带双维度归类与可展示文案', async () => {
    const h = await createHarness();
    try {
      const body = (
        await h.inject({ method: 'GET', url: '/api/tools/qdii/dataset' })
      ).json() as QdiiDatasetResponse;

      const target = body.funds.find((fund) => fund.code === '270042');
      expect(target).toMatchObject({
        region: '纳斯达克100',
        theme: '宽基指数',
        currency: 'CNY',
        status: '限大额',
        dailyLimit: 2,
        limitText: '2 元',
        buyable: true,
        onExchange: false,
      });
      expect(target?.capturedAt).toBeTruthy();
      expect(target?.dataDate).toBe('2026-09-14');
    } finally {
      await h.close();
    }
  });

  it('分类计数覆盖地区与主题两个维度', async () => {
    const h = await createHarness();
    try {
      const body = (
        await h.inject({ method: 'GET', url: '/api/tools/qdii/dataset' })
      ).json() as QdiiDatasetResponse;

      expect(body.categories.regions.find((item) => item.name === '纳斯达克100')?.count).toBe(3);
      expect(body.categories.regions.find((item) => item.name === '标普500')?.count).toBe(1);
      expect(body.categories.regions.find((item) => item.name === '全球')?.count).toBe(1);
      expect(body.categories.themes.reduce((sum, item) => sum + item.count, 0)).toBe(6);
    } finally {
      await h.close();
    }
  });

  it('统计与数据新鲜度', async () => {
    const h = await createHarness();
    try {
      const body = (
        await h.inject({ method: 'GET', url: '/api/tools/qdii/dataset' })
      ).json() as QdiiDatasetResponse;

      expect(body.freshness).toMatchObject({
        dataDate: '2026-09-14',
        stale: false,
        source: 'fake',
      });
      expect(body.stats.buyable).toBe(4); // 限大额 3（270042/006479/000834）+ 开放申购 1（015641）
      expect(body.stats.tightest).toBe(2);
      expect(body.stats.limitBands[0]).toMatchObject({ name: '限 10 元以内', count: 3 });
      expect(body.stats.status).toMatchObject({ 暂停申购: 1, 场内交易: 1 });
      expect(body.disclaimer).toContain('仅供参考');
    } finally {
      await h.close();
    }
  });

  it('第二次请求走缓存，不再打上游', async () => {
    const h = await createHarness();
    try {
      await h.inject({ method: 'GET', url: '/api/tools/qdii/dataset' });
      await h.inject({ method: 'GET', url: '/api/tools/qdii/dataset' });
      expect(h.source.calls.snapshot).toBe(1);
    } finally {
      await h.close();
    }
  });
});

describe('降级：上游故障时的读路径', () => {
  it('没有任何本地数据时，上游失败 → 503 UPSTREAM_UNAVAILABLE', async () => {
    const h = await createHarness();
    try {
      h.source.failures.add('snapshot');

      const response = await h.inject({ method: 'GET', url: '/api/tools/qdii/dataset' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } });
    } finally {
      await h.close();
    }
  });

  it('已有本地数据时，上游失败 → 返回陈旧快照并标记 stale', async () => {
    const h = await createHarness();
    try {
      // 1) 先成功抓一次
      await h.inject({ method: 'GET', url: '/api/tools/qdii/dataset' });

      // 2) 时间推进到超出陈旧窗口，并让上游失败
      h.advance(7 * 3_600_000);
      h.source.failures.add('snapshot');

      // 3) force 绕过进程内缓存，触发「该刷新但刷新失败」的路径
      const response = await h.inject({
        method: 'GET',
        url: '/api/tools/qdii/dataset?refresh=1',
      });
      expect(response.statusCode).toBe(200);

      const body = response.json() as QdiiDatasetResponse;
      expect(body.total).toBe(6); // 陈旧但真实的数据照常返回
      expect(body.freshness.stale).toBe(true);
      expect(body.freshness.staleReason).toContain('申购状态接口不可用');
    } finally {
      await h.close();
    }
  });

  it('非上游的内部错误必须暴露为 500，不能伪装成「上游不可用」503', async () => {
    const h = await createHarness();
    try {
      h.source.failures.add('snapshot:internal');
      const response = await h.inject({ method: 'GET', url: '/api/tools/qdii/dataset' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: 'INTERNAL' } });
    } finally {
      await h.close();
    }
  });

  it('数据仍在陈旧窗口内时不会去打上游', async () => {
    const h = await createHarness();
    try {
      await h.inject({ method: 'GET', url: '/api/tools/qdii/dataset' });
      h.advance(60_000);
      h.source.failures.add('snapshot');

      const response = await h.inject({
        method: 'GET',
        url: '/api/tools/qdii/dataset?refresh=1',
      });
      expect(response.json()).toMatchObject({ freshness: { stale: false } });
      expect(h.source.calls.snapshot).toBe(1);
    } finally {
      await h.close();
    }
  });
});
