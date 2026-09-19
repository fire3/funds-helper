import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ParseError, UpstreamError } from './errors.ts';
import { DEFAULT_USER_AGENT, HttpClient } from './http.ts';

let server: Server;
let baseUrl = '';
const hits = new Map<string, number>();
const requestLog: { path: string; at: number }[] = [];
let active = 0;
let maxConcurrent = 0;
let lastUserAgent: string | undefined;

function hit(path: string): number {
  const next = (hits.get(path) ?? 0) + 1;
  hits.set(path, next);
  return next;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);

    const url = new URL(req.url ?? '/', 'http://localhost');
    requestLog.push({ path: url.pathname, at: Date.now() });
    const count = hit(url.pathname);
    lastUserAgent = req.headers['user-agent'];

    const finish = (status: number, body: string) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(body);
      active -= 1;
    };

    switch (url.pathname) {
      case '/bom':
        finish(200, '\uFEFFvar r = [1];');
        break;
      case '/retry':
        // 前两次 500，第三次成功
        if (count < 3) finish(500, 'boom');
        else finish(200, 'ok');
        break;
      case '/notfound':
        finish(404, 'nope');
        break;
      case '/big':
        finish(200, 'x'.repeat(5000));
        break;
      case '/json':
        finish(200, '{"code":"270042"}');
        break;
      case '/bad-json':
        finish(200, 'not json');
        break;
      case '/slow':
        setTimeout(() => finish(200, 'slow'), 60);
        break;
      default:
        finish(200, 'ok');
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}): HttpClient {
  return new HttpClient({
    minIntervalMs: 0,
    concurrency: 8,
    maxRetries: 2,
    retryBackoffMs: 5,
    timeoutMs: 5000,
    ...overrides,
  });
}

describe('HttpClient', () => {
  it('剥离 BOM（接口 E/G 带 BOM，不处理首字符会变成 \\uFEFF）', async () => {
    const text = await client().getText(`${baseUrl}/bom`);
    expect(text.startsWith('\uFEFF')).toBe(false);
    expect(text).toBe('var r = [1];');
  });

  it('带默认 User-Agent', async () => {
    await client().getText(`${baseUrl}/ok`);
    expect(lastUserAgent).toBe(DEFAULT_USER_AGENT);
  });

  it('5xx 会退避重试，最终成功', async () => {
    hits.set('/retry', 0);
    const text = await client().getText(`${baseUrl}/retry`);
    expect(text).toBe('ok');
    expect(hits.get('/retry')).toBe(3);
  });

  it('4xx 不重试（参数错误重试没有意义）', async () => {
    hits.set('/notfound', 0);
    await expect(client().getText(`${baseUrl}/notfound`)).rejects.toBeInstanceOf(UpstreamError);
    expect(hits.get('/notfound')).toBe(1);
  });

  it('重试次数用尽后抛出最后一次错误', async () => {
    const http = client({ maxRetries: 1, retryBackoffMs: 1 });
    hits.set('/retry', 0);
    await expect(http.getText(`${baseUrl}/retry`)).rejects.toBeInstanceOf(UpstreamError);
    expect(hits.get('/retry')).toBe(2); // 首次 + 1 次重试
  });

  it('错误里带上 HTTP 状态码', async () => {
    try {
      await client().getText(`${baseUrl}/notfound`);
      expect.unreachable('应当抛错');
    } catch (error) {
      expect((error as UpstreamError).status).toBe(404);
    }
  });

  it('超过体积上限立即中止（防止上游异常返回打爆内存）', async () => {
    await expect(client({ maxResponseBytes: 1000 }).getText(`${baseUrl}/big`)).rejects.toThrow(
      /上限|过大/,
    );
  });

  it('getJson 解析合法 JSON', async () => {
    const payload = await client().getJson<{ code: string }>(`${baseUrl}/json`);
    expect(payload.code).toBe('270042');
  });

  it('getJson 遇到非 JSON 抛 UpstreamError', async () => {
    await expect(client().getJson(`${baseUrl}/bad-json`)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('同 host 请求遵守最小间隔（对非官方接口保持克制）', async () => {
    requestLog.length = 0;
    const http = client({ minIntervalMs: 80, concurrency: 8 });
    await Promise.all([
      http.getText(`${baseUrl}/ok`),
      http.getText(`${baseUrl}/ok`),
      http.getText(`${baseUrl}/ok`),
    ]);

    const times = requestLog
      .filter((entry) => entry.path === '/ok')
      .map((entry) => entry.at)
      .sort((a, b) => a - b);

    expect(times).toHaveLength(3);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(60);
    expect((times[2] ?? 0) - (times[1] ?? 0)).toBeGreaterThanOrEqual(60);
  });

  it('并发上限生效', async () => {
    maxConcurrent = 0;
    const http = client({ concurrency: 1, minIntervalMs: 0 });
    await Promise.all([
      http.getText(`${baseUrl}/slow`),
      http.getText(`${baseUrl}/slow`),
      http.getText(`${baseUrl}/slow`),
    ]);
    expect(maxConcurrent).toBe(1);
  });

  it('ParseError 是 UpstreamError 的子类，便于统一捕获', () => {
    expect(new ParseError('x')).toBeInstanceOf(UpstreamError);
  });
});
