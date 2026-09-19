import { buildApp } from '../app.ts';
import type { AppConfig } from '../config.ts';
import { createQdiiTool } from '../tools/qdii/index.ts';
import type { ServerTool } from '../tools/types.ts';
import { createFakeQdiiSource, type FakeQdiiSource } from './fake-qdii-source.ts';
import { testConfig, testDb } from './harness.ts';

export interface Harness {
  source: FakeQdiiSource;
  config: AppConfig;
  /** 可推进的「当前时间」，用于测试数据陈旧与变更检测 */
  setNow(ms: number): void;
  advance(ms: number): void;
  inject: Awaited<ReturnType<typeof buildApp>>['app']['inject'];
  cache: Awaited<ReturnType<typeof buildApp>>['cache'];
  scheduler: Awaited<ReturnType<typeof buildApp>>['scheduler'];
  close(): Promise<void>;
}

/**
 * 起一个完整应用（内存库 + 假数据源），用 `app.inject()` 打接口 ——
 * 不占端口、不触网，但仍走真实的路由 / 错误处理 / 服务层链路。
 */
export async function createHarness(
  options: { config?: Partial<AppConfig>; tools?: ServerTool[] } = {},
): Promise<Harness> {
  const source = createFakeQdiiSource();
  let now = Date.parse('2026-09-14T10:00:00.000Z');

  const config = testConfig(options.config);
  const tools = options.tools ?? [createQdiiTool({ source, now: () => now })];

  const built = await buildApp({
    config,
    tools,
    db: testDb(),
    serveStatic: false,
  });

  return {
    source,
    config,
    setNow: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    inject: built.app.inject.bind(built.app),
    cache: built.cache,
    scheduler: built.scheduler,
    close: () => built.close(),
  };
}

export async function json<T>(response: { json(): unknown }): Promise<T> {
  return response.json() as T;
}
