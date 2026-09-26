import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FEED_CATEGORIES,
  FEED_HOSTS,
  FEED_IDS,
  FEEDS,
  getFeed,
  isRegistryUrl,
} from './registry.ts';

describe('信源注册表', () => {
  it('id 唯一且都是小写点分风格', () => {
    expect(new Set(FEED_IDS).size).toBe(FEED_IDS.length);
    for (const id of FEED_IDS) expect(id).toMatch(/^[a-z0-9.-]+$/);
  });

  it('全部是 http(s) 的绝对地址（SSRF 护栏的前置条件）', () => {
    for (const feed of FEEDS) {
      expect(feed.url).toMatch(/^https:\/\//);
      expect(feed.homeUrl).toMatch(/^https:\/\//);
      // 与 homeUrl 分离：条目跳转用条目自己的 link，这里只是展示
      expect(new URL(feed.url).host.length).toBeGreaterThan(0);
    }
  });

  it('分组取值都是注册表自己的枚举（与 shared 的口径一致性由 contract.test 断言）', () => {
    const allowed = new Set<string>(FEED_CATEGORIES);
    for (const feed of FEEDS) expect(allowed.has(feed.category)).toBe(true);
    // discovery 必须存在：聚合器只能当线索，不能当事实依据
    expect(FEEDS.filter((feed) => feed.category === 'discovery').length).toBeGreaterThan(0);
    // 政策一手公告权重最高
    const policy = FEEDS.filter((feed) => feed.category === 'policy');
    expect(policy.length).toBeGreaterThanOrEqual(4);
    for (const feed of policy) expect(feed.weight).toBeGreaterThan(3);
  });

  it('cadence 只有两档：媒体 30 分钟、其余 60 分钟（轮询节奏是硬约束）', () => {
    const cadences = new Set(FEEDS.map((feed) => feed.cadenceSec));
    expect([...cadences].sort((a, b) => a - b)).toEqual([1800, 3600]);
    for (const feed of FEEDS) {
      if (feed.category === 'media') expect(feed.cadenceSec).toBe(1800);
      else expect(feed.cadenceSec).toBe(3600);
    }
  });

  it('host 白名单覆盖全部信源；isRegistryUrl 只认注册表里的地址', () => {
    expect(FEED_HOSTS.length).toBeGreaterThan(8);
    for (const feed of FEEDS) expect(FEED_HOSTS).toContain(new URL(feed.url).host);

    expect(isRegistryUrl(FEEDS[0]?.url ?? '')).toBe(true);
    expect(isRegistryUrl('https://evil.example.com/rss.xml')).toBe(false);
    // 任何请求参数里的 URL 都不会被当成信源地址（防 SSRF 的验收断言）
    expect(isRegistryUrl('http://127.0.0.1:8787/api')).toBe(false);
    expect(getFeed('ft.home')?.category).toBe('media');
    expect(getFeed('不存在')).toBeUndefined();
  });

  it('四个分组都至少有一个信源（信息流的分组筛选不会出现空组）', () => {
    for (const category of FEED_CATEGORIES) {
      expect(FEEDS.some((feed) => feed.category === category)).toBe(true);
    }
  });

  it('一个信源一份 fixture，且文件真实存在（fixture 是这个解析层的全部测试资产）', () => {
    for (const feed of FEEDS) {
      expect(feed.fixture).toMatch(/^[a-z0-9.-]+\.xml$/);
      const path = new URL(`../../test/fixtures/feeds/${feed.fixture}`, import.meta.url);
      expect(existsSync(path), `${feed.id} 缺少 fixture ${feed.fixture}`).toBe(true);
    }
  });
});
