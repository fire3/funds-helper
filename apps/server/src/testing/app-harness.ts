import type { PurchaseSnapshotRow } from '@funds-helper/sources';
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

export interface HarnessOptions {
  config?: Partial<AppConfig>;
  /** 覆盖假数据源的行（例如测试美元份额时需要美元行） */
  rows?: PurchaseSnapshotRow[];
  /** 用同一个假数据源与「当前时间」构造被测工具；默认只注册 QDII 工具 */
  buildTools?: (deps: { source: FakeQdiiSource; now: () => number }) => ServerTool[];
}

/**
 * 起一个完整应用（内存库 + 假数据源），用 `app.inject()` 打接口 ——
 * 不占端口、不触网，但仍走真实的路由 / 错误处理 / 服务层链路。
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const source = createFakeQdiiSource(options.rows === undefined ? {} : { rows: options.rows });
  let now = Date.parse('2026-09-14T10:00:00.000Z');
  const nowFn = (): number => now;

  const config = testConfig(options.config);
  const tools = options.buildTools
    ? options.buildTools({ source, now: nowFn })
    : [createQdiiTool({ source, now: nowFn })];

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
