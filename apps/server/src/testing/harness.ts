import { type Db, openDb } from '@funds-helper/db';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.ts';

/** 测试用配置：全内存、不启动任务、不托管静态资源 */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dbPath: ':memory:',
    timezone: 'Asia/Shanghai',
    logLevel: 'silent',
    jobsEnabled: false,
    upstreamTimeoutMs: 1000,
    upstreamConcurrency: 2,
    upstreamMinIntervalMs: 0,
    memoryCacheTtlSec: 1800,
    staleWindowSec: 21_600,
    // 测试默认与产品默认一致：ETF 行情优先东财（个股测试可用 overrides 改成新浪）
    etfEastmoneyEnabled: true,
    webDistPath: '/nonexistent-web-dist',
    serveStatic: false,
    ...overrides,
  };
}

/** 静默日志：测试输出保持干净 */
export function testLogger(): FastifyBaseLogger {
  const noop = (): void => undefined;
  const logger = {
    child: () => logger,
    debug: noop,
    error: noop,
    fatal: noop,
    info: noop,
    level: 'fatal',
    silent: noop,
    trace: noop,
    warn: noop,
  };
  return logger as unknown as FastifyBaseLogger;
}

export function testDb(): Db {
  return openDb(':memory:');
}
