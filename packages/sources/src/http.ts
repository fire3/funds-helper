import { type Logger, UpstreamError } from './errors.ts';

/**
 * 面向非官方接口的受限 HTTP 客户端。
 *
 * 把「克制」收敛在这一个类里，业务代码无法绕过：
 * 超时 / 并发上限 / 同 host 最小间隔 / 有限重试 / 响应体积上限 / BOM 处理。
 * 宁可返回陈旧数据，也不放大请求量 —— 因此**不做**自动高频重试，也不做后台轮询兜底。
 */

export interface HttpClientOptions {
  timeoutMs: number;
  /** 全局并发上限 */
  concurrency: number;
  /** 同一 host 两次请求之间的最小间隔 */
  minIntervalMs: number;
  /** 单响应体积硬上限，防止上游异常返回把内存打爆 */
  maxResponseBytes: number;
  /** 最多重试次数（不含首次） */
  maxRetries: number;
  /** 指数退避基数 */
  retryBackoffMs: number;
  logger?: Logger | undefined;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const DEFAULT_HTTP_OPTIONS: HttpClientOptions = {
  timeoutMs: 60_000,
  concurrency: 2,
  minIntervalMs: 300,
  maxResponseBytes: 16 * 1024 * 1024,
  maxRetries: 2,
  retryBackoffMs: 1000,
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      // 名额直接移交给下一个等待者，active 保持不变
      next();
      return;
    }
    this.active -= 1;
  }
}

export class HttpClient {
  private readonly options: HttpClientOptions;
  private readonly semaphore: Semaphore;
  private readonly lastRequestAt = new Map<string, number>();
  private readonly hostChain = new Map<string, Promise<void>>();

  constructor(options: Partial<HttpClientOptions> = {}) {
    this.options = { ...DEFAULT_HTTP_OPTIONS, ...options };
    this.semaphore = new Semaphore(this.options.concurrency);
  }

  /** 同 host 串行化并保证最小间隔 */
  private async throttle(host: string): Promise<void> {
    const previous = this.hostChain.get(host) ?? Promise.resolve();
    const next = previous.then(async () => {
      const last = this.lastRequestAt.get(host) ?? 0;
      const wait = this.options.minIntervalMs - (Date.now() - last);
      if (wait > 0) await sleep(wait);
      this.lastRequestAt.set(host, Date.now());
    });
    this.hostChain.set(
      host,
      next.catch(() => undefined),
    );
    await next;
  }

  private isRetryable(error: unknown): boolean {
    if (!(error instanceof UpstreamError)) return true; // 网络层异常（TypeError / AbortError）
    if (error.status === undefined) return true;
    return error.status >= 500;
  }

  private async withRetry<T>(fn: () => Promise<T>, url: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === this.options.maxRetries || !this.isRetryable(error)) break;
        // 抖动与退避基数成比例，避免多个任务在退避后同时重试（也让测试能压低基数）
        const backoff = this.options.retryBackoffMs * 2 ** attempt * (1 + Math.random() * 0.25);
        this.options.logger?.warn(
          { url, attempt: attempt + 1, backoffMs: Math.round(backoff) },
          '上游请求失败，退避重试',
        );
        await sleep(backoff);
      }
    }
    throw lastError instanceof Error ? lastError : new UpstreamError(String(lastError), { url });
  }

  private async readCapped(response: Response, url: string): Promise<string> {
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > this.options.maxResponseBytes) {
      throw new UpstreamError(`上游响应体过大（${declared} 字节），已中止`, { url });
    }

    const reader = response.body?.getReader();
    if (!reader) return '';

    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > this.options.maxResponseBytes) {
        await reader.cancel();
        throw new UpstreamError(
          `上游响应体超过上限 ${this.options.maxResponseBytes} 字节，已中止`,
          { url },
        );
      }
      chunks.push(value);
    }

    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // TextDecoder 默认剥离 BOM（接口 E/G 都带 BOM，不处理会让首字符变成 \uFEFF）
    return new TextDecoder('utf-8').decode(buffer);
  }

  async getText(url: string, options: RequestOptions = {}): Promise<string> {
    const host = new URL(url).host;
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;

    await this.semaphore.acquire();
    try {
      await this.throttle(host);
      const startedAt = Date.now();
      const text = await this.withRetry(async () => {
        const response = await fetch(url, {
          headers: { 'User-Agent': DEFAULT_USER_AGENT, ...options.headers },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'follow',
        });

        if (!response.ok) {
          throw new UpstreamError(`上游返回 HTTP ${response.status}`, {
            url,
            status: response.status,
          });
        }
        return this.readCapped(response, url);
      }, url);

      this.options.logger?.debug(
        { url, bytes: Buffer.byteLength(text), elapsedMs: Date.now() - startedAt },
        '上游请求完成',
      );
      return text;
    } finally {
      this.semaphore.release();
    }
  }

  async getJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const text = await this.getText(url, options);
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new UpstreamError('上游返回的不是合法 JSON', { url, cause: error });
    }
  }
}
