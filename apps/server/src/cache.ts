interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * 进程内 TTL 缓存。
 *
 * 两个职责：
 * 1. 挡住高频读（前端反复刷新、切换筛选）—— 不打上游，也少打 DB
 * 2. `getOrBuild` 对同一 key 的并发请求合并为一次构建，避免缓存击穿时「惊群」
 */
export class TtlCache {
  private readonly store = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs: number) {
    this.defaultTtlMs = defaultTtlMs;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs = this.defaultTtlMs): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  /** 取缓存，未命中则构建一次；同 key 的并发调用共享同一次构建 */
  async getOrBuild<T>(key: string, build: () => Promise<T>, ttlMs = this.defaultTtlMs): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      try {
        const value = await build();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }
}
