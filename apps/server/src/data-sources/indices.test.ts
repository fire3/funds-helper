import { readFileSync } from 'node:fs';
import { getIndexDefinition } from '@funds-helper/core';
import { type HttpClient, UpstreamError } from '@funds-helper/sources';
import { describe, expect, it } from 'vitest';
import { createIndicesDataSource } from './indices.ts';

function fixture(path: string): string {
  return readFileSync(
    new URL(`../../../../packages/sources/test/fixtures/${path}`, import.meta.url),
    'utf8',
  );
}

const FIXTURES = {
  sina: () => fixture('sina/global-index/dax-daily.json'),
  tencent: () => fixture('tencent/kline/usdji-kline.json'),
  eastmoney: () => fixture('eastmoney/global-index/spx-kline.json'),
  yahoo: () => fixture('yahoo/chart/gspc-daily.json'),
};

type UpstreamKey = keyof typeof FIXTURES;

function hostKey(url: string): UpstreamKey {
  if (url.includes('gi.finance.sina.com.cn')) return 'sina';
  if (url.includes('ifzq.gtimg.cn')) return 'tencent';
  if (url.includes('eastmoney.com')) return 'eastmoney';
  if (url.includes('finance.yahoo.com')) return 'yahoo';
  throw new Error(`stub 不认识这个 URL：${url}`);
}

/**
 * 按 host 路由的 HttpClient 替身：记录调用顺序，可选让某个源「故障」。
 * 用真实 parse 路径（不 mock fetch 函数），才能锁住编排的优先级语义。
 */
function stubHttp(options: { broken?: Set<UpstreamKey> } = {}) {
  const calls: UpstreamKey[] = [];
  const client = {
    getText: async (url: string): Promise<string> => {
      const key = hostKey(url);
      calls.push(key);
      if (options.broken?.has(key)) throw new UpstreamError(`stub：${key} 上游故障`);
      return FIXTURES[key]();
    },
  } as unknown as HttpClient;
  return { client, calls };
}

function def(key: string) {
  const definition = getIndexDefinition(key);
  if (definition === undefined) throw new Error(`注册表缺少 ${key}`);
  return definition;
}

describe('createIndicesDataSource —— 稳定国内源优先的四源编排', () => {
  it('新浪有代码的指数（DAX）优先走新浪，不碰东财/Yahoo', async () => {
    const { client, calls } = stubHttp();
    const result = await createIndicesDataSource(client).fetchBars(def('GDAXI'));
    expect(result.source).toBe('sina');
    expect(result.bars.length).toBe(1000);
    expect(calls).toEqual(['sina']);
  });

  it('新浪没有、腾讯有的美/港指数（标普）优先走腾讯', async () => {
    const { client, calls } = stubHttp();
    const result = await createIndicesDataSource(client).fetchBars(def('SPX'));
    expect(result.source).toBe('tencent');
    expect(calls).toEqual(['tencent']);
  });

  it('新浪/腾讯都没有的指数（罗素2000）只能落到 Yahoo 兜底', async () => {
    const { client, calls } = stubHttp();
    const result = await createIndicesDataSource(client).fetchBars(def('RUT'));
    expect(result.source).toBe('yahoo');
    expect(calls).toEqual(['yahoo']);
  });

  it('稳定源故障时按 新浪 → 东财 → Yahoo 降级', async () => {
    const { client, calls } = stubHttp({ broken: new Set<UpstreamKey>(['sina', 'eastmoney']) });
    const result = await createIndicesDataSource(client).fetchBars(def('GDAXI'));
    expect(result.source).toBe('yahoo');
    // 东财 K 线主备两个端点，故障时各试一次
    expect(calls).toEqual(['sina', 'eastmoney', 'eastmoney', 'yahoo']);
  });

  it('四源全部失败 → 抛出聚合的 UpstreamError', async () => {
    const { client } = stubHttp({ broken: new Set<UpstreamKey>(['sina', 'eastmoney', 'yahoo']) });
    await expect(createIndicesDataSource(client).fetchBars(def('GDAXI'))).rejects.toThrow(
      UpstreamError,
    );
  });
});
