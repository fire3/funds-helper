import {
  NEWS_CATEGORIES,
  NEWS_RANGES,
  NEWS_WINDOWS,
  type NewsConfigTestResponse,
  NewsGenerateRequestSchema,
  type NewsGenerateResponse,
  NewsPromptUpdateSchema,
  type NewsRange,
  type NewsRefreshResponse,
  type NewsWindow,
} from '@funds-helper/shared';
import { FEED_IDS } from '@funds-helper/sources';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import { badRequest } from '../../errors.ts';
import type { ToolContext } from '../types.ts';
import type { NewsService } from './service.ts';

/** 本工具的任务名（`POST /jobs/:name/execute` 只允许触发这两个） */
const JOB_NAMES = ['news.fetch', 'news.summary'] as const;

function queryOf(request: FastifyRequest): Record<string, unknown> {
  const query: unknown = request.query ?? {};
  return typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
}

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body: unknown = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('请求体必须是 JSON 对象', JSON.stringify(body ?? null));
  }
  return body as Record<string, unknown>;
}

/** `?cat=media,policy` 或重复的 `?cat=media&cat=policy` 都支持 */
function csv(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return parts
    .flatMap((part) => String(part).split(','))
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function windowOf(request: FastifyRequest): NewsWindow {
  const raw = queryOf(request).window;
  const value = raw === undefined ? undefined : String(raw);
  if (value === undefined || !(NEWS_WINDOWS as readonly string[]).includes(value)) {
    throw badRequest('窗口参数非法', String(raw));
  }
  return value as NewsWindow;
}

/** 分组/信源参数**不许静默忽略**：笔误该被看见，而不是悄悄返回全量 */
function sanitizeList(values: string[], allowed: readonly string[], label: string): string[] {
  const set = new Set(allowed);
  for (const value of values) {
    if (!set.has(value)) throw badRequest(`${label}参数非法`, value);
  }
  return values;
}

function isZodError(error: unknown): error is ZodError {
  return error instanceof Error && error.name === 'ZodError';
}

/** 校验失败要变成 400（`BAD_REQUEST`），而不是让 ZodError 冒成 500 */
function validated<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (isZodError(error)) {
      throw badRequest(
        '提交的内容不符合要求',
        error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      );
    }
    throw error;
  }
}

export function registerNewsRoutes(
  app: FastifyInstance,
  ctx: ToolContext,
  service: NewsService,
): void {
  /**
   * 分页信息流：**服务端筛选 + 游标分页**。
   * 条目几个月就是几万行，全量返回不可行（architecture §7.2 的阈值约定）。
   */
  app.get('/feed', async (request) => {
    const query = queryOf(request);
    const rawRange = query.range === undefined ? 'today' : String(query.range);
    if (!(NEWS_RANGES as readonly string[]).includes(rawRange)) {
      throw badRequest('时间窗口非法', String(query.range));
    }

    const rawLimit = query.limit;
    let limit: number | undefined;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed)) throw badRequest('limit 必须是整数', String(rawLimit));
      limit = parsed;
    }

    return service.getFeed({
      range: rawRange as NewsRange,
      categories: sanitizeList(csv(query.cat), NEWS_CATEGORIES, '分组'),
      sources: sanitizeList(csv(query.src), FEED_IDS, '信源'),
      q: query.q === undefined ? '' : String(query.q),
      cursor: query.cursor === undefined ? null : String(query.cursor),
      limit,
    });
  });

  /** 16 个信源的健康状态（最近抓取、状态码、连续失败、下次抓取） */
  app.get('/sources', async () => service.getSources());

  /** 最新一份**成功**简报 + 回填的引用条目；从未生成过 → 404 */
  app.get('/summary', async (request) => service.getSummary(windowOf(request)));

  app.get('/summary/history', async (request) => service.getHistory(windowOf(request)));

  /**
   * 生成简报（手动触发）。
   * 服务端按陈旧规则决定是否真的调模型：`today` 距上次 ≥ 4 小时或新增 ≥ 30 条，
   * 否则直接返回缓存那份（`reused: true`）。`force: true` 忽略规则强制重算。
   */
  app.post('/summaries/generate', async (request): Promise<NewsGenerateResponse> => {
    const parsed = validated(() => NewsGenerateRequestSchema.parse(bodyOf(request)));
    return service.generate(parsed, 'manual');
  });

  app.get('/config', async () => service.getConfig());

  /** 更新模型配置：**改完立刻生效，不重启进程**（service 每次都从 settings 现读） */
  app.put('/config', async (request) => service.updateConfig(bodyOf(request)));

  app.put('/prompts/:key', async (request) => {
    const params: unknown = request.params ?? {};
    const key = (params as { key?: string }).key ?? '';
    const parsed = validated(() => NewsPromptUpdateSchema.parse(bodyOf(request)));
    return service.updatePrompt(key, parsed);
  });

  /** 连通性测试：不测就只能等第二天早上 08:30 才知道配错了 */
  app.post('/config/test', async (): Promise<NewsConfigTestResponse> => service.testConnection());

  /**
   * 手动抓一次信源。走调度器而不是直接调 service ——
   * 手动刷新同样留下 `job_run` 记录（排障时能分清「谁抓的」）。
   */
  app.post('/refresh', async (): Promise<NewsRefreshResponse> => {
    const result = await ctx.jobs.execute('news.fetch', 'manual');
    return (
      (result?.stats as NewsRefreshResponse | undefined) ?? {
        ok: false,
        due: 0,
        fetched: 0,
        failed: 0,
        inserted: 0,
        skipped: true,
        durationMs: 0,
        message: '抓取任务没有返回结果（可能已被调度器忽略）',
      }
    );
  });

  /** 按名触发任务（沿用其它工具的手动触发习惯，含 `news.summary`） */
  app.post('/jobs/:name/execute', async (request) => {
    const params: unknown = request.params ?? {};
    const name = (params as { name?: string }).name ?? '';
    if (!(JOB_NAMES as readonly string[]).includes(name)) {
      throw badRequest('未知的任务名', name);
    }
    const result = await ctx.jobs.execute(name, 'manual');
    return { ok: true, job: name, stats: result?.stats ?? null };
  });
}
