import { createServer, type Server } from 'node:http';
import type {
  NewsConfigResponse,
  NewsFeedResponse,
  NewsGenerateResponse,
  NewsRefreshResponse,
  NewsSourcesResponse,
  NewsSummaryHistoryResponse,
  NewsSummaryResponse,
} from '@funds-helper/shared';
import { FEEDS, type HttpClient } from '@funds-helper/sources';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, json } from './testing/app-harness.ts';
import { createNewsTool } from './tools/news/index.ts';

/**
 * `news` 工具的集成测试（`fastify.inject()`）。
 *
 * 两类替身：
 * - **假 HttpClient**：返回真实结构的 RSS（信源维度），验证抓取 / 去重 / 筛选 / 分页；
 * - **真的本地 HTTP 服务器**当模型端点：验证「第一次不合法 → 第二次修复成功」
 *   「两次都失败 → PARSE_FAILED + detail 带模型原文」「401/超时 → 503」这些**只有走真实
 *   网络栈才验得到**的路径（baseUrl 归一化、response_format 降级也一并覆盖）。
 *
 * 时钟固定在 2026-09-26 10:00（Asia/Shanghai），窗口边界按它算。
 */

const NOW = Date.parse('2026-09-26T02:00:00.000Z'); // Asia/Shanghai 2026-09-26 10:00
const TODAY_RFC822 = 'Sat, 26 Sep 2026 01:00:00 GMT';
// 上海时间 2026-09-25 18:00（= 昨天）；今天 = 2026-09-26
const YESTERDAY_RFC822 = 'Fri, 25 Sep 2026 10:00:00 GMT';

interface FakeItem {
  title: string;
  link: string;
  pubDate?: string;
  description?: string;
}

function rssOf(items: readonly FakeItem[]): string {
  const body = items
    .map(
      (item) =>
        `<item><title><![CDATA[${item.title}]]></title><link>${item.link}</link>` +
        (item.pubDate === undefined ? '' : `<pubDate>${item.pubDate}</pubDate>`) +
        (item.description === undefined
          ? ''
          : `<description><![CDATA[${item.description}]]></description>`) +
        `</item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>fake</title>${body}</channel></rss>`;
}

function itemsFor(feedId: string, homeUrl: string, name: string): FakeItem[] {
  const base = homeUrl.replace(/\/+$/, '');
  const item = (n: number, extra: Partial<FakeItem> = {}): FakeItem => ({
    title: `${name} story ${n}`,
    // 链接必须**按信源唯一**：两个 Google News feed 共用一个 homeUrl，
    // 撞 canonical 会被去重索引吃掉（这正是「canonical 相同 → 同一条目」的语义）
    link: `${base}/${feedId}/story/${n}`,
    pubDate: TODAY_RFC822,
    description: `<p>${name} 的第 ${n} 条摘要，含 <b>标记</b> 与 &amp; 实体。</p>`,
    ...extra,
  });

  if (feedId === 'ft.home') {
    return [
      item(1),
      item(2, { pubDate: 'Sat, 26 Sep 2026 00:30:00 GMT' }),
      item(3, { pubDate: YESTERDAY_RFC822 }),
    ];
  }
  if (feedId === 'fed') return [item(1), item(2)];
  if (feedId === 'gnews.reuters') return [item(1), item(2)];
  if (feedId === 'ecb') return [item(1, { pubDate: YESTERDAY_RFC822 })];
  // Nikkei 的真实 feed 没有 pubDate —— 时间未知时按抓取时刻兜底排序，绝不伪造
  if (feedId === 'nikkei.asia') {
    const noDate = item(1);
    delete noDate.pubDate;
    return [noDate];
  }
  return [item(1)];
}

interface FakeHttpOptions {
  /** 某个信源返回 HTML 挑战页（模拟站点拦截） */
  brokenHosts?: string[];
}

function fakeHttp(options: FakeHttpOptions = {}): HttpClient {
  const broken = new Set(options.brokenHosts ?? []);
  return {
    getRaw: async (url: string, requestOptions?: unknown) => {
      const feed = FEEDS.find((entry) => entry.url === url);
      if (feed === undefined) throw new Error(`测试替身收到非注册表地址：${url}`);

      if (broken.has(new URL(url).host)) {
        return {
          status: 200,
          headers: {},
          text: '<!doctype html><html><head><title>Blocked</title></head><body>blocked</body></html>',
        };
      }

      const etag = `"${feed.id}-v1"`;
      const req = (requestOptions ?? {}) as { ifNoneMatch?: string | null };
      if (req.ifNoneMatch === etag) return { status: 304, headers: { etag }, text: '' };

      return {
        status: 200,
        headers: { etag, 'last-modified': YESTERDAY_RFC822 },
        text: rssOf(itemsFor(feed.id, feed.homeUrl, feed.name)),
      };
    },
    getText: async (url: string) => {
      const response = await fakeHttp(options).getRaw(url);
      return response.text;
    },
  } as unknown as HttpClient;
}

type App = Awaited<ReturnType<typeof createHarness>>;

/**
 * 每个用例自己起一个 harness；**统一在 afterEach 里收尾** ——
 * 断言中途失败时若漏掉 close，下一个用例注册同名 cron 会直接崩（croner 要求任务名全局唯一）。
 */
const openApps: (() => Promise<void>)[] = [];

async function newsApp(
  options: { http?: HttpClient; config?: Record<string, string | boolean> } = {},
): Promise<App> {
  const harness = await createHarness({
    config: options.config ?? {},
    buildTools: ({ now }) => [createNewsTool({ now })],
    http: options.http ?? fakeHttp(),
  });
  harness.setNow(NOW);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await harness.close();
  };
  openApps.push(close);
  return { ...harness, close };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((close) => close()));
});

async function get<T>(app: App, url: string): Promise<{ status: number; body: T }> {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: await json<T>(response) };
}

async function post<T>(
  app: App,
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await app.inject({
    method: 'POST',
    url,
    ...(payload === undefined
      ? {}
      : {
          payload: payload as Record<string, unknown>,
          headers: { 'content-type': 'application/json' },
        }),
  });
  return { status: response.statusCode, body: await json<T>(response) };
}

async function put<T>(
  app: App,
  url: string,
  payload: unknown,
): Promise<{ status: number; body: T }> {
  const response = await app.inject({
    method: 'PUT',
    url,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json' },
  });
  return { status: response.statusCode, body: await json<T>(response) };
}

async function refresh(app: App): Promise<NewsRefreshResponse> {
  const { status, body } = await post<NewsRefreshResponse>(app, '/api/tools/news/refresh');
  expect(status).toBe(200);
  return body;
}

// ---------------------------------------------------------------------------
// 模型端点替身：一个真的本地 HTTP 服务器
// ---------------------------------------------------------------------------

interface ModelCall {
  path: string;
  body: {
    model?: string;
    messages?: { role: string; content: string }[];
    max_tokens?: number;
    response_format?: { type?: string; json_schema?: { strict?: boolean; schema?: unknown } };
  };
}

type ModelHandler = (
  call: ModelCall,
  index: number,
) => { status?: number; content?: string; raw?: string };

function completion(content: string): string {
  return JSON.stringify({
    model: 'fake-model',
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 1234, completion_tokens: 567 },
  });
}

async function withModel<T>(
  handler: ModelHandler,
  fn: (baseUrl: string, calls: ModelCall[]) => Promise<T>,
): Promise<T> {
  const calls: ModelCall[] = [];
  const server: Server = createServer((request, response) => {
    let data = '';
    request.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    request.on('end', () => {
      const call: ModelCall = {
        path: request.url ?? '/',
        body: data === '' ? {} : (JSON.parse(data) as ModelCall['body']),
      };
      calls.push(call);
      const result = handler(call, calls.length - 1);
      const status = result.status ?? 200;
      const body = result.raw ?? completion(result.content ?? '{}');
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  try {
    return await fn(baseUrl, calls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const VALID_PAYLOAD = {
  headline: '美联储维持利率不变，官员暗示年内仅降息一次',
  sections: {
    macro: [
      { text: '美联储维持基准利率不变，官员暗示年内仅降息一次', refs: [1] },
      { text: 'ECB 管委称通胀回落进入最后阶段', refs: [2] },
    ],
    markets: [{ text: '美股三大指数收高', refs: [3] }],
    companies: [],
    asia: [{ text: '日元走弱引发干预猜测', refs: [4] }],
  },
  risk: [{ text: '两家信源对年内降息时点说法不一', refs: [] }],
  watch: ['下周公布美国 CPI'],
};

async function configure(app: App, baseUrl: string, extra: Record<string, unknown> = {}) {
  const { status, body } = await put<NewsConfigResponse>(app, '/api/tools/news/config', {
    baseUrl,
    apiKey: 'sk-test',
    model: 'fake-model',
    ...extra,
  });
  expect(status).toBe(200);
  return body;
}

// ---------------------------------------------------------------------------
// 抓取与信息流
// ---------------------------------------------------------------------------

describe('POST /api/tools/news/refresh —— 抓取与信源健康', () => {
  it('一次抓全部到期信源：15 个信源、19 条条目落库，并留下 job_run', async () => {
    const app = await newsApp();
    try {
      const stats = await refresh(app);
      expect(stats.ok).toBe(true);
      expect(stats.due).toBe(15);
      expect(stats.fetched).toBe(15);
      expect(stats.failed).toBe(0);
      expect(stats.inserted).toBe(19);

      const { body } = await get<NewsSourcesResponse>(app, '/api/tools/news/sources');
      expect(body.sources).toHaveLength(15);
      const total = body.sources.reduce((sum, source) => sum + source.itemCount, 0);
      expect(total).toBe(19);
      for (const source of body.sources) {
        expect(source.lastStatus).toBe(200);
        expect(source.consecFailures).toBe(0);
        expect(source.lastError).toBeNull();
        expect(source.itemCount).toBeGreaterThan(0);
      }
      expect(body.lastRun?.okFeeds).toBe(15);
      expect(body.lastRun?.failFeeds).toBe(0);
      expect(body.lastRun?.newItems).toBe(19);
    } finally {
      await app.close();
    }
  });

  it('没到 cadence 就再抓一次：直接跳过，不打上游（幂等的到期判断）', async () => {
    const app = await newsApp();
    try {
      await refresh(app);
      const second = await refresh(app);
      expect(second.skipped).toBe(true);
      expect(second.due).toBe(0);
      expect(second.message).toContain('没有到期');
    } finally {
      await app.close();
    }
  });

  it('到点后条件请求命中 304：不重复入库（inserted = 0）', async () => {
    const app = await newsApp();
    try {
      await refresh(app);
      app.advance(3600_000); // media cadence = 30min，policy = 60min → 全部到点
      const again = await refresh(app);
      expect(again.skipped).toBe(false);
      expect(again.inserted).toBe(0);
      expect(again.failed).toBe(0);

      const { body } = await get<NewsSourcesResponse>(app, '/api/tools/news/sources');
      for (const source of body.sources) expect(source.lastStatus).toBe(304);
      const { body: feed } = await get<NewsFeedResponse>(app, '/api/tools/news/feed?range=all');
      expect(feed.total).toBe(19);
    } finally {
      await app.close();
    }
  });

  it('单个信源返回 HTML 挑战页：只影响它自己（14 成 1 败），其它信源照常', async () => {
    const app = await newsApp({ http: fakeHttp({ brokenHosts: ['www.ecb.europa.eu'] }) });
    try {
      const stats = await refresh(app);
      expect(stats.ok).toBe(false);
      expect(stats.fetched).toBe(14);
      expect(stats.failed).toBe(1);
      expect(stats.inserted).toBe(18);

      const { body } = await get<NewsSourcesResponse>(app, '/api/tools/news/sources');
      const ecb = body.sources.find((source) => source.id === 'ecb');
      expect(ecb?.lastError).toContain('HTML');
      expect(ecb?.consecFailures).toBe(1);
      // 退避：60 分钟 cadence × 2^1 = 2 小时后才重试（上限 4 小时）
      expect(Date.parse(ecb?.nextFetchAt ?? '') - Date.parse(ecb?.lastFetchedAt ?? '')).toBe(
        2 * 3_600_000,
      );
      expect(body.lastRun?.failFeeds).toBe(1);
      // 信息流完全不受影响
      const { body: feed } = await get<NewsFeedResponse>(app, '/api/tools/news/feed?range=all');
      expect(feed.total).toBe(18);
    } finally {
      await app.close();
    }
  });

  it('信源页在第一次抓取之前就能列出全部信源（状态为「未抓取」）', async () => {
    const app = await newsApp();
    try {
      const { status, body } = await get<NewsSourcesResponse>(app, '/api/tools/news/sources');
      expect(status).toBe(200);
      expect(body.sources).toHaveLength(15);
      expect(body.sources.every((source) => source.lastFetchedAt === null)).toBe(true);
      expect(body.sources.every((source) => source.itemCount === 0)).toBe(true);
      expect(body.lastRun).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/tools/news/feed —— 服务端筛选与游标分页', () => {
  async function seeded(): Promise<App> {
    const app = await newsApp();
    await refresh(app);
    return app;
  }

  it('默认今日窗口：时间倒序、首屏带 total、摘要是纯文本', async () => {
    const app = await seeded();
    try {
      const { status, body } = await get<NewsFeedResponse>(app, '/api/tools/news/feed');
      expect(status).toBe(200);
      expect(body.total).toBe(17); // 19 条里有 2 条是昨天的
      expect(body.items).toHaveLength(17);
      expect(body.freshness.source).toBe('rss');

      const keys = body.items.map((item) => item.publishedAt ?? item.fetchedAt);
      expect([...keys].sort().reverse()).toEqual(keys);

      const first = body.items[0];
      expect(first?.sourceName.length).toBeGreaterThan(0);
      expect(first?.summary).not.toContain('<');
      expect(first?.summary).toContain('&');
    } finally {
      await app.close();
    }
  });

  it('窗口语义：今日 17 条、昨日 2 条、近 3 日/近 7 日/全部都是 19 条', async () => {
    const app = await seeded();
    try {
      const totals: Record<string, number | null> = {};
      for (const range of ['today', 'yesterday', '3d', '7d', 'all']) {
        const { body } = await get<NewsFeedResponse>(app, `/api/tools/news/feed?range=${range}`);
        totals[range] = body.total;
      }
      expect(totals).toEqual({ today: 17, yesterday: 2, '3d': 19, '7d': 19, all: 19 });
    } finally {
      await app.close();
    }
  });

  it('游标分页：每页 5 条，翻完不重不漏，且第二页不再统计 total', async () => {
    const app = await seeded();
    try {
      const ids: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      let firstTotal: number | null = null;

      do {
        const url: string =
          cursor === null
            ? '/api/tools/news/feed?range=all&limit=5'
            : `/api/tools/news/feed?range=all&limit=5&cursor=${encodeURIComponent(cursor)}`;
        const { body } = await get<NewsFeedResponse>(app, url);
        if (pages === 0) firstTotal = body.total;
        else expect(body.total).toBeNull();
        ids.push(...body.items.map((item) => item.id));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 20);

      expect(firstTotal).toBe(19);
      expect(ids).toHaveLength(19);
      expect(new Set(ids).size).toBe(19);
      expect(pages).toBe(4);
    } finally {
      await app.close();
    }
  });

  it('分组 / 信源 / 关键词筛选都在服务端完成', async () => {
    const app = await seeded();
    try {
      const policy = await get<NewsFeedResponse>(app, '/api/tools/news/feed?range=all&cat=policy');
      expect(policy.body.items).toHaveLength(5); // fed 2 + ecb/boe/sec 各 1
      expect(policy.body.items.every((item) => item.category === 'policy')).toBe(true);

      const discovery = await get<NewsFeedResponse>(
        app,
        '/api/tools/news/feed?range=all&cat=discovery',
      );
      expect(discovery.body.items).toHaveLength(3);
      expect(discovery.body.items.every((item) => item.discovery)).toBe(true);

      const multi = await get<NewsFeedResponse>(
        app,
        '/api/tools/news/feed?range=all&cat=policy,discovery',
      );
      expect(multi.body.total).toBe(8); // 5 政策 + 3 发现

      const source = await get<NewsFeedResponse>(app, '/api/tools/news/feed?range=all&src=ft.home');
      expect(source.body.items).toHaveLength(3);
      expect(source.body.items.every((item) => item.sourceId === 'ft.home')).toBe(true);

      const keyword = await get<NewsFeedResponse>(app, '/api/tools/news/feed?range=all&q=ECB');
      expect(keyword.body.items).toHaveLength(1);
      expect(keyword.body.items[0]?.sourceId).toBe('ecb');

      const empty = await get<NewsFeedResponse>(
        app,
        '/api/tools/news/feed?range=all&q=zzz-nothing',
      );
      expect(empty.body.items).toHaveLength(0);
      expect(empty.body.total).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('Nikkei 的条目没有发布时间：按抓取时刻排序，publishedAt 为 null（不伪造）', async () => {
    const app = await seeded();
    try {
      const { body } = await get<NewsFeedResponse>(
        app,
        '/api/tools/news/feed?range=all&src=nikkei.asia',
      );
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.publishedAt).toBeNull();
      expect(body.items[0]?.fetchedAt).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('非法窗口 / 分组 / 信源 / limit 一律 400（参数不许静默忽略）', async () => {
    const app = await seeded();
    try {
      for (const url of [
        '/api/tools/news/feed?range=bogus',
        '/api/tools/news/feed?cat=not-a-category',
        '/api/tools/news/feed?src=not-a-source',
        '/api/tools/news/feed?limit=abc',
        '/api/tools/news/feed?limit=0',
        '/api/tools/news/feed?cursor=not-a-cursor',
      ]) {
        const { status, body } = await get<{ error: { code: string } }>(app, url);
        expect(status, url).toBe(400);
        expect(body.error.code).toBe('BAD_REQUEST');
      }
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 配置与提示词
// ---------------------------------------------------------------------------

describe('GET/PUT /api/tools/news/config', () => {
  it('**绝不回传 apiKey 明文**，只给 hasApiKey', async () => {
    const app = await newsApp();
    try {
      await configure(app, 'http://127.0.0.1:9999/v1');
      const { body } = await get<NewsConfigResponse>(app, '/api/tools/news/config');
      expect(body.ai.hasApiKey).toBe(true);
      expect('apiKey' in body.ai).toBe(false);
      expect(JSON.stringify(body)).not.toContain('sk-test');
      expect(body.ai.baseUrl).toBe('http://127.0.0.1:9999/v1');
      expect(body.prompts.map((prompt) => prompt.key)).toEqual(['daily', 'policy', 'weekly']);
      expect(body.prompts.find((prompt) => prompt.key === 'daily')?.isDefault).toBe(true);
      expect(body.usage).toMatchObject({ used: 0, limit: 10 });
    } finally {
      await app.close();
    }
  });

  it('改配置立刻生效（不重启）；apiKey 留空表示不改', async () => {
    const app = await newsApp();
    try {
      await configure(app, 'http://127.0.0.1:9999/v1');
      await put<NewsConfigResponse>(app, '/api/tools/news/config', {
        baseUrl: '',
        model: '',
        apiKey: '',
        dailyLimit: 3,
      });
      const { body } = await get<NewsConfigResponse>(app, '/api/tools/news/config');
      expect(body.ai.baseUrl).toBe(''); // 清空是允许的（生成时会明确报 400）
      expect(body.ai.hasApiKey).toBe(true); // 留空 = 不改
      expect(body.ai.dailyLimit).toBe(3);

      // 未配置 → 生成必须是 400，而不是拿空地址去打网络
      const generate = await post<{ error: { code: string; message: string } }>(
        app,
        '/api/tools/news/summaries/generate',
        { window: 'today', force: true },
      );
      expect(generate.status).toBe(400);
      expect(generate.body.error.message).toContain('还没有配置模型地址');
    } finally {
      await app.close();
    }
  });

  it('非法配置被 schema 挡住（400 而不是 500）', async () => {
    const app = await newsApp();
    try {
      const bad = await put<{ error: { code: string; detail?: string } }>(
        app,
        '/api/tools/news/config',
        { baseUrl: 'ftp://example.com', model: 'x' },
      );
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('BAD_REQUEST');

      const badLimit = await put<{ error: { code: string } }>(app, '/api/tools/news/config', {
        dailyLimit: 9999,
      });
      expect(badLimit.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('提示词可改且立刻生效，写进 app_setting（提示词是数据不是代码）', async () => {
    const app = await newsApp();
    try {
      const updated = await put<NewsConfigResponse>(app, '/api/tools/news/prompts/daily', {
        name: '我的每日简报',
        systemPrompt: '只写一句话。',
      });
      expect(updated.status).toBe(200);
      const daily = updated.body.prompts.find((prompt) => prompt.key === 'daily');
      expect(daily?.name).toBe('我的每日简报');
      expect(daily?.systemPrompt).toBe('只写一句话。');
      expect(daily?.isDefault).toBe(true);
      // 下发的提示词带现算 hash：与简报记录里的 promptHash 对比即可发现「旧提示词」
      expect(daily?.promptHash).toMatch(/^[0-9a-f]{8}$/);

      const missing = await put<{ error: { code: string } }>(app, '/api/tools/news/prompts/nope', {
        name: 'x',
      });
      expect(missing.status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 简报
// ---------------------------------------------------------------------------

describe('GET /api/tools/news/summary', () => {
  it('没生成过 → 404，且提示怎么触发', async () => {
    const app = await newsApp();
    try {
      for (const window of ['today', 'yesterday', 'last7d']) {
        const { status, body } = await get<{ error: { code: string; message: string } }>(
          app,
          `/api/tools/news/summary?window=${window}`,
        );
        expect(status).toBe(404);
        expect(body.error.code).toBe('NOT_FOUND');
        expect(body.error.message).toContain('还没有生成过简报');
      }
    } finally {
      await app.close();
    }
  });

  it('窗口参数非法 → 400', async () => {
    const app = await newsApp();
    try {
      const { status } = await get(app, '/api/tools/news/summary?window=forever');
      expect(status).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/tools/news/summaries/generate —— 正常路径', () => {
  it('一次调用产出结构化简报：引用回填、预算留痕、usage 计数', async () => {
    const app = await newsApp();
    await refresh(app);

    await withModel(
      () => ({ content: JSON.stringify(VALID_PAYLOAD) }),
      async (baseUrl, calls) => {
        await configure(app, baseUrl);
        const { status, body } = await post<NewsGenerateResponse>(
          app,
          '/api/tools/news/summaries/generate',
          { window: 'today', force: true },
        );

        expect(status).toBe(200);
        expect(body.reused).toBe(false);
        expect(body.summary.status).toBe('success');
        expect(body.summary.payload?.headline).toBe(VALID_PAYLOAD.headline);
        expect(body.summary.itemCount).toBeGreaterThan(0);
        expect(body.summary.droppedCount).toBe(0);
        expect(body.summary.promptKey).toBe('daily');
        expect(body.summary.promptHash).toMatch(/^[0-9a-f]{8}$/);
        const config = await get<NewsConfigResponse>(app, '/api/tools/news/config');
        expect(body.summary.promptHash).toBe(
          config.body.prompts.find((prompt) => prompt.key === 'daily')?.promptHash,
        );
        expect(body.summary.promptTokens).toBe(1234);
        expect(body.summary.completionTokens).toBe(567);
        expect(body.summary.citations).toBe('ok');
        expect(body.usage).toMatchObject({ used: 1, limit: 10 });

        // 引用条目回填：前端渲染角标时不用再查条目表
        const items = body.summary.payload?.items ?? {};
        expect(Object.keys(items)).toContain('1');
        expect(items['1']?.url).toMatch(/^https:\/\//);
        expect(items['1']?.title.length).toBeGreaterThan(0);

        // 请求形态：严格 json_schema + system/user 两条消息 + 条目清单带编号
        expect(calls).toHaveLength(1);
        const call = calls[0];
        expect(call?.path).toBe('/chat/completions');
        expect(call?.body.response_format?.type).toBe('json_schema');
        expect(call?.body.response_format?.json_schema?.strict).toBe(true);
        expect(call?.body.messages?.map((message) => message.role)).toEqual(['system', 'user']);
        expect(call?.body.messages?.[1]?.content).toContain('[1] ');
        expect(call?.body.messages?.[1]?.content).not.toContain('{{');

        // 信息流与简报是两条读路径：生成后信息流照常
        const { body: feed } = await get<NewsFeedResponse>(app, '/api/tools/news/feed');
        expect(feed.total).toBe(17);
      },
    );

    await app.close();
  });

  it('today 的陈旧规则：4 小时内且没有新条目 → 直接返回缓存（reused），不打模型', async () => {
    const app = await newsApp();
    await refresh(app);

    await withModel(
      () => ({ content: JSON.stringify(VALID_PAYLOAD) }),
      async (baseUrl, calls) => {
        await configure(app, baseUrl);
        const first = await post<NewsGenerateResponse>(app, '/api/tools/news/summaries/generate', {
          window: 'today',
        });
        expect(first.status).toBe(200);
        expect(first.body.reused).toBe(false);

        const second = await post<NewsGenerateResponse>(app, '/api/tools/news/summaries/generate', {
          window: 'today',
        });
        expect(second.status).toBe(200);
        expect(second.body.reused).toBe(true);
        expect(second.body.summary.id).toBe(first.body.summary.id);
        expect(calls).toHaveLength(1); // 第二次没打模型

        // 显式「重新生成」（force）绕过陈旧规则
        const forced = await post<NewsGenerateResponse>(app, '/api/tools/news/summaries/generate', {
          window: 'today',
          force: true,
        });
        expect(forced.body.reused).toBe(false);
        expect(calls).toHaveLength(2);
      },
    );

    await app.close();
  });

  it('引用越界：丢弃坏引用、要点保留、invalidRefs 计数', async () => {
    const app = await newsApp();
    await refresh(app);
    const payload = {
      ...VALID_PAYLOAD,
      sections: {
        ...VALID_PAYLOAD.sections,
        macro: [{ text: '编造的引用', refs: [1, 999] }],
      },
    };

    await withModel(
      () => ({ content: JSON.stringify(payload) }),
      async (baseUrl) => {
        await configure(app, baseUrl);
        const { status, body } = await post<NewsGenerateResponse>(
          app,
          '/api/tools/news/summaries/generate',
          { window: 'today', force: true },
        );
        expect(status).toBe(200);
        expect(body.summary.invalidRefs).toBe(1);
        expect(body.summary.payload?.sections.macro[0]?.refs).toEqual([1]);
        expect(body.summary.payload?.sections.macro[0]?.text).toBe('编造的引用');
        // 999 没有被回填成一个不存在的链接
        expect(body.summary.payload?.items['999']).toBeUndefined();
      },
    );

    await app.close();
  });

  it('窗口内没有条目 → 404，且**不消耗**模型调用', async () => {
    const app = await newsApp(); // 不 refresh，库里是空的
    await withModel(
      () => ({ content: JSON.stringify(VALID_PAYLOAD) }),
      async (baseUrl, calls) => {
        await configure(app, baseUrl);
        const { status, body } = await post<{ error: { code: string } }>(
          app,
          '/api/tools/news/summaries/generate',
          { window: 'today', force: true },
        );
        expect(status).toBe(404);
        expect(body.error.code).toBe('NOT_FOUND');
        expect(calls).toHaveLength(0);
      },
    );
    await app.close();
  });
});

describe('POST /api/tools/news/summaries/generate —— 失败要显式', () => {
  it('第一次输出不合法 → 修复重试一次后成功', async () => {
    const app = await newsApp();
    await refresh(app);

    await withModel(
      (_call, index) =>
        index === 0
          ? { content: '抱歉，我无法生成 JSON。' }
          : { content: JSON.stringify(VALID_PAYLOAD) },
      async (baseUrl, calls) => {
        await configure(app, baseUrl);
        const { status, body } = await post<NewsGenerateResponse>(
          app,
          '/api/tools/news/summaries/generate',
          { window: 'today', force: true },
        );
        expect(status).toBe(200);
        expect(body.summary.status).toBe('success');
        expect(calls).toHaveLength(2);

        const repair = calls[1]?.body.messages ?? [];
        expect(repair).toHaveLength(3);
        expect(repair[2]?.role).toBe('user');
        expect(repair[2]?.content).toContain('上一次的输出是');
        expect(repair[2]?.content).toContain('校验错误是');
        expect(repair[2]?.content).toContain('抱歉，我无法生成 JSON');
      },
    );
    await app.close();
  });

  it('两次都不合法 → 502 PARSE_FAILED，detail 带模型原文，并记一行 failed', async () => {
    const app = await newsApp();
    await refresh(app);

    await withModel(
      () => ({ content: 'I will not output JSON.' }),
      async (baseUrl, calls) => {
        await configure(app, baseUrl);
        const { status, body } = await post<{
          error: { code: string; message: string; detail?: string };
        }>(app, '/api/tools/news/summaries/generate', { window: 'today', force: true });
        expect(status).toBe(502);
        expect(body.error.code).toBe('PARSE_FAILED');
        expect(body.error.message).toContain('两次');
        expect(body.error.detail).toContain('I will not output JSON');
        expect(calls).toHaveLength(2); // 修复重试只允许一次

        // 失败留痕：历史里能看到这次失败（而不是静默消失）
        const { body: history } = await get<NewsSummaryHistoryResponse>(
          app,
          '/api/tools/news/summary/history?window=today',
        );
        expect(history.history).toHaveLength(1);
        expect(history.history[0]?.status).toBe('failed');
        expect(history.history[0]?.error).toContain('I will not output JSON');
        expect(history.history[0]?.payload).toBeNull();

        // 但信息流完全不受影响 —— 这是整个设计的可用性下限
        const { body: feed } = await get<NewsFeedResponse>(app, '/api/tools/news/feed');
        expect(feed.total).toBe(17);
      },
    );
    await app.close();
  });

  it('JSON 合法但 schema 不符（缺 sections）→ 同样走修复重试，仍失败则 502', async () => {
    const app = await newsApp();
    await refresh(app);

    await withModel(
      () => ({ content: JSON.stringify({ headline: '只有标题' }) }),
      async (baseUrl, calls) => {
        await configure(app, baseUrl);
        const { status, body } = await post<{ error: { code: string; detail?: string } }>(
          app,
          '/api/tools/news/summaries/generate',
          { window: 'today', force: true },
        );
        expect(status).toBe(502);
        expect(body.error.code).toBe('PARSE_FAILED');
        expect(body.error.detail).toContain('sections');
        expect(calls).toHaveLength(2);
      },
    );
    await app.close();
  });

  it('端点不支持 response_format → 自动降级重发（仍然一次生成成功）', async () => {
    const app = await newsApp();
    await refresh(app);

    await withModel(
      (call) =>
        call.body.response_format === undefined
          ? { content: JSON.stringify(VALID_PAYLOAD) }
          : {
              status: 400,
              raw: JSON.stringify({
                error: { message: 'response_format json_schema is not supported' },
              }),
            },
      async (baseUrl, calls) => {
        await configure(app, baseUrl);
        const { status, body } = await post<NewsGenerateResponse>(
          app,
          '/api/tools/news/summaries/generate',
          { window: 'today', force: true },
        );
        expect(status).toBe(200);
        expect(body.summary.status).toBe('success');
        expect(calls).toHaveLength(2);
        expect(calls[0]?.body.response_format?.type).toBe('json_schema');
        expect(calls[1]?.body.response_format).toBeUndefined();
        // 降级只算一次逻辑调用：额度只扣一次
        expect(body.usage.used).toBe(1);
      },
    );
    await app.close();
  });

  it('模型端点 5xx → 503 UPSTREAM_UNAVAILABLE 且 detail 带上游原文', async () => {
    const app = await newsApp();
    await refresh(app);

    await withModel(
      () => ({ status: 500, raw: JSON.stringify({ error: 'internal server error' }) }),
      async (baseUrl) => {
        await configure(app, baseUrl);
        const { status, body } = await post<{ error: { code: string; detail?: string } }>(
          app,
          '/api/tools/news/summaries/generate',
          { window: 'today', force: true },
        );
        expect(status).toBe(503);
        expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
        expect(body.error.detail).toContain('internal server error');
      },
    );
    await app.close();
  });

  it('模型端点连不上 → 503（而不是 500 或空简报）', async () => {
    const app = await newsApp();
    await refresh(app);
    await configure(app, 'http://127.0.0.1:1'); // 端口 1 必然连不上

    const { status, body } = await post<{ error: { code: string; message: string } }>(
      app,
      '/api/tools/news/summaries/generate',
      { window: 'today', force: true },
    );
    expect(status).toBe(503);
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(body.error.message).toContain('信息流不受影响');
    await app.close();
  });
});

describe('每日调用限额（dailyLimit）', () => {
  it('打满后返回 503 并说明何时重置；测试连接同样计入额度', async () => {
    const app = await newsApp();
    await refresh(app);

    await withModel(
      () => ({ content: JSON.stringify(VALID_PAYLOAD) }),
      async (baseUrl) => {
        await configure(app, baseUrl, { dailyLimit: 1 });

        const first = await post<NewsGenerateResponse>(app, '/api/tools/news/summaries/generate', {
          window: 'today',
          force: true,
        });
        expect(first.status).toBe(200);
        expect(first.body.usage).toMatchObject({ used: 1, limit: 1 });

        const second = await post<{ error: { code: string; message: string } }>(
          app,
          '/api/tools/news/summaries/generate',
          { window: 'yesterday', force: true },
        );
        expect(second.status).toBe(503);
        expect(second.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
        expect(second.body.error.message).toContain('已达上限（1/1）');
        expect(second.body.error.message).toContain('明日重置');

        // 测试连接也绕不过护栏
        const test = await post<{ error: { message: string } }>(app, '/api/tools/news/config/test');
        expect(test.status).toBe(503);
        expect(test.body.error.message).toContain('已达上限');
      },
    );
    await app.close();
  });

  it('测试连接成功：返回耗时与模型名，并计入今日用量（kind=test）', async () => {
    const app = await newsApp();
    await refresh(app);

    await withModel(
      () => ({ content: 'OK' }),
      async (baseUrl) => {
        await configure(app, baseUrl);
        const { status, body } = await post<{
          ok: boolean;
          model: string;
          latencyMs: number;
          message: string;
        }>(app, '/api/tools/news/config/test');
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.model).toBe('fake-model');
        expect(body.latencyMs).toBeGreaterThanOrEqual(0);

        const config = await get<NewsConfigResponse>(app, '/api/tools/news/config');
        expect(config.body.usage.used).toBe(1);

        const { body: history } = await get<NewsSummaryHistoryResponse>(
          app,
          '/api/tools/news/summary/history?window=today',
        );
        expect(history.history[0]?.kind).toBe('test');
      },
    );
    await app.close();
  });
});

describe('历史与任务触发', () => {
  it('历史保留多份（换模型/改提示词后可对比），且 GET summary 始终取最新成功那份', async () => {
    const app = await newsApp();
    await refresh(app);

    await withModel(
      () => ({ content: JSON.stringify(VALID_PAYLOAD) }),
      async (baseUrl, calls) => {
        await configure(app, baseUrl);
        await post(app, '/api/tools/news/summaries/generate', { window: 'yesterday', force: true });
        await post(app, '/api/tools/news/summaries/generate', { window: 'yesterday', force: true });
        expect(calls).toHaveLength(2);

        const { body: history } = await get<NewsSummaryHistoryResponse>(
          app,
          '/api/tools/news/summary/history?window=yesterday',
        );
        expect(history.history).toHaveLength(2);
        expect(history.history[0]?.id).toBeGreaterThan(history.history[1]?.id ?? 0);

        const { body: summary } = await get<NewsSummaryResponse>(
          app,
          '/api/tools/news/summary?window=yesterday',
        );
        expect(summary.summary.id).toBe(history.history[0]?.id);
        expect(summary.disclaimer).toContain('不构成投资建议');
        expect(summary.summary.payload?.headline).toBe(VALID_PAYLOAD.headline);
      },
    );
    await app.close();
  });

  it('按名触发任务：未知任务名 400，news.summary 走同一条生成链路', async () => {
    const app = await newsApp();
    await refresh(app);

    await withModel(
      () => ({ content: JSON.stringify(VALID_PAYLOAD) }),
      async (baseUrl) => {
        await configure(app, baseUrl);
        const unknown = await post<{ error: { code: string } }>(
          app,
          '/api/tools/news/jobs/evil/execute',
        );
        expect(unknown.status).toBe(400);

        const { status, body } = await post<{ ok: boolean; job: string; stats: unknown }>(
          app,
          '/api/tools/news/jobs/news.summary/execute',
        );
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.job).toBe('news.summary');
        expect(body.stats).toMatchObject({ window: 'yesterday' });
      },
    );
    await app.close();
  });
});
