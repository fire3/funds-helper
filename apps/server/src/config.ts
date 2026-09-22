import { z } from 'zod';

/** pino 支持的级别；`silent` 用于测试与静默运行 */
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * 环境变量里的布尔值。
 * **不能用 `z.coerce.boolean()`**：`Boolean('false') === true`，
 * 会导致 JOBS_ENABLED=false 反而开启定时任务。
 */
function envBool(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((raw) =>
      raw === undefined
        ? defaultValue
        : ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase()),
    );
}

export const AppConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(8787),
  dbPath: z.string().default('./data/funds.db'),
  /** 影响净值日期换算与定时任务触发时刻，务必保持 Asia/Shanghai */
  timezone: z.string().default('Asia/Shanghai'),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  /** 本地开发保持 false；服务器常驻时设为 true（避免两端重复打上游） */
  jobsEnabled: envBool(false),
  upstreamTimeoutMs: z.coerce.number().int().positive().default(60_000),
  upstreamConcurrency: z.coerce.number().int().positive().default(2),
  upstreamMinIntervalMs: z.coerce.number().int().min(0).default(300),
  memoryCacheTtlSec: z.coerce.number().int().positive().default(1800),
  staleWindowSec: z.coerce.number().int().positive().default(21_600),
  /**
   * ETF 行情是否**优先**走东方财富 `push2`（默认 false）。
   *
   * 2026-09-22 实测：push2 的 `clist`（全市场列表）对本项目出口 IP 长期重置
   * （`UND_ERR_SOCKET`，主备域名 + 多台集群全部一样），且失败要等退避重试一轮（约 8 秒）——
   * 因此默认**只走新浪列表**（见 `docs/design/etf-data-sources.md` §7）。
   * 代价是新浪没有折溢价率/上市日期；需要折溢价时置 `ETF_EASTMONEY_ENABLED=true`，
   * 届时东财失败仍会自动降级到新浪（不会让数据集挂掉）。
   */
  etfEastmoneyEnabled: envBool(false),
  /** 前端构建产物目录；存在即由本服务托管静态资源 */
  webDistPath: z.string().default(''),
  /**
   * 是否托管前端静态资源。
   * 开发时置 false —— 否则 :8787 会托管上一次 `pnpm build` 的**旧前端**，
   * 容易让人误以为改动没生效（开发应始终访问 Vite 的 :5173）。
   */
  serveStatic: envBool(true),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/** 丢弃 undefined，让 zod 的 .default() 正常生效 */
function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return AppConfigSchema.parse(
    compact({
      host: env.HOST,
      port: env.PORT,
      dbPath: env.DB_PATH,
      timezone: env.TZ,
      logLevel: env.LOG_LEVEL,
      jobsEnabled: env.JOBS_ENABLED,
      upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
      upstreamConcurrency: env.UPSTREAM_CONCURRENCY,
      upstreamMinIntervalMs: env.UPSTREAM_MIN_INTERVAL_MS,
      memoryCacheTtlSec: env.MEMORY_CACHE_TTL_SEC,
      staleWindowSec: env.STALE_WINDOW_SEC,
      etfEastmoneyEnabled: env.ETF_EASTMONEY_ENABLED,
      // 默认指向 apps/web/dist —— 生产环境下由本服务同时托管 API 与前端
      webDistPath: env.WEB_DIST_PATH ?? new URL('../../web/dist', import.meta.url).pathname,
      serveStatic: env.SERVE_STATIC,
    }),
  );
}
