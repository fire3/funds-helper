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
   * ETF 行情是否**优先**走东方财富（默认 true）。
   *
   * 2026-09-22 实测：`clist`（按板块翻页）被上游**按接口**重置（主备域名 + 多台集群都一样），
   * 而同一域名的 `ulist.np`（按代码批量报价，100 只/请求）正常，字段完全一致 ——
   * 所以优先东财时走的是 `ulist.np`，代码池来自目录接口 B，
   * 只有在目录不可用时才退回 `clist`；任一步失败都会降级到新浪（见 `etf-data-sources.md` §7.4）。
   *
   * 实测（东财）：1675 只 / 约 6 秒 / 折溢价齐全；降级到新浪则没有折溢价率/上市日期。
   *
   * **这个变量只是默认值**：界面上可以随时切换（存 `app_setting` 表），
   * 运行时配置优先于它（见 `tools/etf/service.ts` 的 `spotSourcePreference`）。
   */
  etfEastmoneyEnabled: envBool(true),
  /**
   * `news` 工具的 AI 配置**默认值**（运行时 `app_setting` 优先，改完不重启）。
   *
   * 环境变量只是「没有运行时配置时」的兜底：`AI_API_KEY` 一旦写进 `.env` 就不再需要
   * 在界面上重复填；界面上填过的值存 `app_setting`，优先级高于这里。
   * 未配置时 `baseUrl` 为空串 —— 生成简报会明确报 400，而不是拿着空地址去打网络。
   */
  newsAiBaseUrl: z.string().default(''),
  newsAiApiKey: z.string().default(''),
  newsAiModel: z.string().default(''),
  newsAiTemperature: z.coerce.number().min(0).max(2).default(0.3),
  newsAiMaxTokens: z.coerce.number().int().min(256).max(32_000).default(4000),
  newsAiMaxInputTokens: z.coerce.number().int().positive().default(60_000),
  /** 每天最多几次 AI 调用（含「测试连接」）—— 克制的硬护栏 */
  newsAiDailyLimit: z.coerce.number().int().min(1).max(100).default(10),
  /** 信息流条目保留期：`news.fetch` 任务顺带清理，防表无限膨胀 */
  newsItemRetentionDays: z.coerce.number().int().positive().default(180),
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
      newsAiBaseUrl: env.AI_BASE_URL,
      newsAiApiKey: env.AI_API_KEY,
      newsAiModel: env.AI_MODEL,
      newsAiTemperature: env.AI_TEMPERATURE,
      newsAiMaxTokens: env.AI_MAX_TOKENS,
      newsAiMaxInputTokens: env.AI_MAX_INPUT_TOKENS,
      newsAiDailyLimit: env.AI_DAILY_LIMIT,
      newsItemRetentionDays: env.NEWS_ITEM_RETENTION_DAYS,
      // 默认指向 apps/web/dist —— 生产环境下由本服务同时托管 API 与前端
      webDistPath: env.WEB_DIST_PATH ?? new URL('../../web/dist', import.meta.url).pathname,
      serveStatic: env.SERVE_STATIC,
    }),
  );
}
