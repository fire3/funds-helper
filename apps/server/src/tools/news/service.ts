import {
  buildPromptBudget,
  canonicalizeUrl,
  collectRefs,
  dedupKeyOf,
  formatItemLines,
  renderTemplate,
  validateCitations,
} from '@funds-helper/core';
import type { Db, SettingRepository } from '@funds-helper/db';
import {
  type Freshness,
  NEWS_CATEGORIES,
  NEWS_DISCLAIMER,
  NEWS_RANGES,
  type NewsAiConfig,
  type NewsAiConfigPublic,
  NewsAiConfigSchema,
  type NewsCategory,
  type NewsConfigResponse,
  type NewsFeedResponse,
  type NewsGenerateRequest,
  type NewsGenerateResponse,
  type NewsItem,
  type NewsPrompt,
  NewsPromptSchema,
  type NewsRange,
  type NewsRefreshResponse,
  type NewsSourceInfo,
  type NewsSourcesResponse,
  type NewsSummaryBody,
  NewsSummaryBodySchema,
  type NewsSummaryHistoryResponse,
  type NewsSummaryKind,
  type NewsSummaryPayload,
  NewsSummaryPayloadSchema,
  type NewsSummaryRecord,
  type NewsSummaryResponse,
  type NewsUsage,
  type NewsWindow,
} from '@funds-helper/shared';
import {
  FEEDS,
  getFeed,
  type HttpClient,
  isRegistryUrl,
  type ParsedFeedEntry,
  parseFeed,
  UpstreamError,
} from '@funds-helper/sources';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../../config.ts';
import { AppError, badRequest, notFound } from '../../errors.ts';
import {
  type ChatMessage,
  type ChatResult,
  chatCompletion,
  extractJsonText,
  snippetAround,
} from './ai.ts';
import {
  BUILTIN_PROMPT_ROWS,
  defaultAiConfig,
  NEWS_AI_CONFIG_SETTING_KEY,
  NEWS_PROMPT_SETTING_PREFIX,
  promptHash,
} from './defaults.ts';
import type {
  NewsFeedPageQuery,
  NewsItemInput,
  NewsItemRow,
  NewsRepository,
  NewsSourceRow,
  NewsSummaryInput,
  NewsSummaryRow,
} from './repository.ts';

/**
 * `news` 工具的服务层：唯一编排 IO 的地方（信源 → 库 → 预算 → 模型 → 校验 → 库）。
 *
 * **信息流与简报是两条独立读路径**（design §2）：模型挂了、配额用完了、提示词改坏了，
 * 信息流照样能看。简报只是信息流之上的一层「读法」，不是前置依赖。
 */

const DAY_MS = 86_400_000;
/** Asia/Shanghai 无夏令时，固定偏移即可 —— 不依赖进程 TZ（与 `todayInShanghai` 同理） */
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 送入预算的窗口条目上限（再大就该先缩窗口，而不是把库扫穿） */
const WINDOW_ITEM_LIMIT = 3000;
/** `today` 的陈旧规则：距上次生成 ≥ 4 小时，或期间新增 ≥ 30 条才真的调模型 */
const TODAY_STALE_AFTER_MS = 4 * 3_600_000;
const TODAY_STALE_NEW_ITEMS = 30;
/** 失败退避上限：4 小时（design §3.3） */
const MAX_BACKOFF_MS = 4 * 3_600_000;
const FEED_PAGE_DEFAULT_LIMIT = 100;
const FEED_PAGE_MAX_LIMIT = 500;

/** 注册表权重 → 预算的组内排序（policy 一手公告权重最高） */
const FEED_WEIGHTS: Record<string, number> = Object.fromEntries(
  FEEDS.map((feed) => [feed.id, feed.weight]),
);

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Asia/Shanghai 的当日零点 */
export function shanghaiDayStart(ms: number): number {
  return Math.floor((ms + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
}

export function shanghaiDate(ms: number): string {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function dateLabel(ms: number): string {
  const date = new Date(ms + SHANGHAI_OFFSET_MS);
  return `${date.toISOString().slice(0, 10)}（${WEEKDAYS[date.getUTCDay()]}）`;
}

export interface TimeRange {
  start: number;
  end: number;
}

/** 简报窗口的**显式时间区间**（不是一个模糊的「今天」） */
export function windowRange(window: NewsWindow, nowMs: number): TimeRange {
  const todayStart = shanghaiDayStart(nowMs);
  if (window === 'yesterday') return { start: todayStart - DAY_MS, end: todayStart };
  if (window === 'last7d') return { start: todayStart - 6 * DAY_MS, end: nowMs };
  return { start: todayStart, end: nowMs };
}

/** 信息流窗口（比简报多两档：近 3 日 / 全部；`all` 不设边界） */
export function rangeBounds(
  range: NewsRange,
  nowMs: number,
): { startIso: string | null; endIso: string | null } {
  const todayStart = shanghaiDayStart(nowMs);
  // 开放式窗口的上界**含当刻**：`< now+1ms` 等价于 `<= now`，
  // 否则刚抓进来的条目（publishedAt 为空时用 fetchedAt 排序）会被自己的窗口挡在外面
  const untilNow = iso(nowMs + 1);
  switch (range) {
    case 'yesterday':
      return { startIso: iso(todayStart - DAY_MS), endIso: iso(todayStart) };
    case '3d':
      return { startIso: iso(todayStart - 2 * DAY_MS), endIso: untilNow };
    case '7d':
      return { startIso: iso(todayStart - 6 * DAY_MS), endIso: untilNow };
    case 'all':
      return { startIso: null, endIso: null };
    // 'today' 与未知值都落这里：路由层已经校验过取值，未知值不该比 today 更宽容
    default:
      return { startIso: iso(todayStart), endIso: untilNow };
  }
}

function windowLabel(window: NewsWindow, range: TimeRange): string {
  if (window === 'last7d') {
    return `${shanghaiDate(range.start)} ~ ${shanghaiDate(range.end)}（近 7 日，Asia/Shanghai）`;
  }
  return `${shanghaiDate(range.start)} 全天（00:00–24:00，Asia/Shanghai）`;
}

/** 只保留已知分组：分享链接里的笔误不该让查询变成全表扫描或空结果 */
function sanitizeCategories(values: readonly string[]): string[] {
  const allowed = new Set<string>(NEWS_CATEGORIES);
  return values.filter((value) => allowed.has(value));
}

function sanitizeSources(values: readonly string[]): string[] {
  const allowed = new Set(FEEDS.map((feed) => feed.id));
  return values.filter((value) => allowed.has(value));
}

function toCategory(value: string): NewsCategory {
  return (NEWS_CATEGORIES as readonly string[]).includes(value) ? (value as NewsCategory) : 'media';
}

function toItem(row: NewsItemRow): NewsItem {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    category: toCategory(row.category),
    title: row.title,
    summary: row.summary,
    url: row.url ?? '',
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    discovery: row.discovery === 1,
  };
}

/** 游标 = 上一页最后一行的排序键 + id（keyset 分页，写入中不漏行不重行） */
function encodeCursor(row: NewsItemRow): string {
  const key = row.published_at ?? row.fetched_at;
  return Buffer.from(`${key}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { key: string; id: number } {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw badRequest('分页游标非法', raw);
  }
  const at = decoded.lastIndexOf('|');
  const key = at <= 0 ? '' : decoded.slice(0, at);
  const id = Number.parseInt(decoded.slice(at + 1), 10);
  if (key === '' || !Number.isInteger(id)) throw badRequest('分页游标非法', raw);
  return { key, id };
}

type ParseOutcome =
  | { ok: true; payload: NewsSummaryPayload }
  | { ok: false; errors: string; raw: string };

export interface NewsServiceDeps {
  db: Db;
  repo: NewsRepository;
  settings: SettingRepository;
  http: HttpClient;
  config: AppConfig;
  logger: FastifyBaseLogger;
  now?: () => number;
}

export class NewsService {
  private readonly deps: NewsServiceDeps;
  private readonly now: () => number;

  constructor(deps: NewsServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // 抓取
  // -------------------------------------------------------------------------

  /**
   * 抓一轮信源：只拉 `next_fetch_at <= now` 的（`force` 全拉）。
   *
   * 单个信源失败**只影响它自己**（退避 + 记 `last_error`），其它信源照常 ——
   * 一次任务里 16 个信源可能 12 成 4 败，任务是 success 的、信源是坏的，
   * 所以另有一张 `news_fetch_run` 记**信源维度**的健康。
   */
  async fetchFeeds(options: { force?: boolean } = {}): Promise<NewsRefreshResponse> {
    const startedAt = this.now();
    const nowIso = iso(startedAt);
    this.deps.repo.ensureSources(nowIso);

    const due =
      options.force === true
        ? this.deps.repo.loadSources().filter((source) => source.enabled === 1)
        : this.deps.repo.loadDueSources(nowIso);

    if (due.length === 0) {
      return {
        ok: true,
        due: 0,
        fetched: 0,
        failed: 0,
        inserted: 0,
        skipped: true,
        durationMs: this.now() - startedAt,
        message: '本轮没有到期的信源（各自按 cadence 轮询），未请求上游',
      };
    }

    const runId = this.deps.repo.startFetchRun(nowIso);
    let ok = 0;
    let failed = 0;
    let inserted = 0;
    const errors: string[] = [];

    for (const source of due) {
      try {
        inserted += await this.fetchOne(source);
        ok += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${source.id}: ${message}`);
        const status = error instanceof UpstreamError ? (error.status ?? null) : null;
        // 「推后一倍」：连续失败越多等越久，上限 4 小时（别每 10 分钟打一个正在挑战你的站点）
        const backoffMs = Math.min(
          source.cadence_sec * 2 ** (source.consec_failures + 1) * 1000,
          MAX_BACKOFF_MS,
        );
        const failedAt = this.now();
        this.deps.repo.markSourceFailure({
          id: source.id,
          fetchedAt: iso(failedAt),
          nextFetchAt: iso(failedAt + backoffMs),
          status,
          error: message.slice(0, 500),
        });
        this.deps.logger.warn(
          { source: source.id, status, backoffMs, err: message },
          '信源抓取失败（该信源退避，不影响其它信源）',
        );
      }
    }

    // 顺带做保留期清理：条目表按月增长，不清理迟早拖慢分页查询
    const cutoffIso = iso(startedAt - this.deps.config.newsItemRetentionDays * DAY_MS);
    const removed = this.deps.repo.deleteItemsBefore(cutoffIso);

    const finishedAt = this.now();
    this.deps.repo.finishFetchRun(runId, {
      finishedAt: iso(finishedAt),
      okFeeds: ok,
      failFeeds: failed,
      newItems: inserted,
      error: errors.length > 0 ? errors.join('；').slice(0, 2000) : null,
    });

    const stats: NewsRefreshResponse = {
      ok: failed === 0,
      due: due.length,
      fetched: ok,
      failed,
      inserted,
      skipped: false,
      durationMs: finishedAt - startedAt,
      message:
        `抓取 ${due.length} 个信源：${ok} 成功 / ${failed} 失败，新增 ${inserted} 条` +
        (removed > 0 ? `，清理 ${removed} 条超过保留期的条目` : ''),
    };
    this.deps.logger.info({ ...stats }, '信源抓取完成');
    return stats;
  }

  private async fetchOne(source: NewsSourceRow): Promise<number> {
    // SSRF 护栏：只请求注册表里的地址（即便上游表被误改，也只会在本地失败）
    if (!isRegistryUrl(source.url)) {
      throw new Error(`信源地址不在注册表中，拒绝请求：${source.url}`);
    }
    const definition = getFeed(source.id);

    const response = await this.deps.http.getRaw(source.url, {
      ifNoneMatch: source.etag,
      ifModifiedSince: source.last_modified,
      // 304 是**成功**：绝大多数轮次只是确认「没变」，不该被当成上游错误
      allowNotModified: true,
    });

    const fetchedAt = iso(this.now());
    const cadenceMs = (definition?.cadenceSec ?? source.cadence_sec) * 1000;
    const nextFetchAt = iso(this.now() + cadenceMs);

    if (response.status === 304) {
      this.deps.repo.markSourceSuccess({
        id: source.id,
        etag: source.etag,
        lastModified: source.last_modified,
        fetchedAt,
        nextFetchAt,
        status: 304,
      });
      return 0;
    }

    // 根本不是 XML（HTML 挑战页 / 404 页）→ ParseError，写进 last_status，只影响这一个信源
    const parsed = parseFeed(response.text, definition?.format ?? 'auto', { baseUrl: source.url });
    const discovery = source.category === 'discovery';
    const inputs: NewsItemInput[] = parsed.entries.map((entry) =>
      this.toItemInput(source.id, discovery, entry, fetchedAt),
    );
    const inserted = this.deps.repo.insertItems(inputs);

    this.deps.repo.markSourceSuccess({
      id: source.id,
      etag: response.headers.etag ?? null,
      lastModified: response.headers['last-modified'] ?? null,
      fetchedAt,
      nextFetchAt,
      status: response.status,
    });

    if (parsed.skipped > 0) {
      this.deps.logger.warn(
        { source: source.id, skipped: parsed.skipped, entries: parsed.entries.length },
        '部分条目残缺（缺标题或链接），已跳过',
      );
    }
    return inserted;
  }

  private toItemInput(
    sourceId: string,
    discovery: boolean,
    entry: ParsedFeedEntry,
    fetchedAt: string,
  ): NewsItemInput {
    // 聚合器的跳转链接原样保留（它本身就是「线索」），其它信源 canonical 化后再入库
    const url = canonicalizeUrl(entry.link, { keepQuery: discovery });
    return {
      sourceId,
      guid: entry.guid,
      url,
      // url 拿不到时才有退化键：两个可空唯一索引，绝不塞伪造值
      dedupKey: url === null ? dedupKeyOf(sourceId, entry.title, entry.publishedAt) : null,
      title: entry.title,
      summary: entry.summary,
      publishedAt: entry.publishedAt,
      fetchedAt,
      discovery,
    };
  }

  // -------------------------------------------------------------------------
  // 信息流（纯查询）
  // -------------------------------------------------------------------------

  getFeed(params: {
    range: NewsRange;
    categories: readonly string[];
    sources: readonly string[];
    q: string;
    cursor: string | null;
    limit: number | undefined;
  }): NewsFeedResponse {
    if (!(NEWS_RANGES as readonly string[]).includes(params.range)) {
      throw badRequest('时间窗口非法', String(params.range));
    }
    const limit = params.limit ?? FEED_PAGE_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > FEED_PAGE_MAX_LIMIT) {
      throw badRequest(`limit 必须是 1~${FEED_PAGE_MAX_LIMIT} 的整数`, String(params.limit));
    }

    const nowMs = this.now();
    const bounds = rangeBounds(params.range, nowMs);
    const filters = {
      startIso: bounds.startIso,
      endIso: bounds.endIso,
      categories: sanitizeCategories(params.categories),
      sources: sanitizeSources(params.sources),
      q: params.q.trim(),
    };
    const cursor =
      params.cursor === null || params.cursor === '' ? null : decodeCursor(params.cursor);

    const query: NewsFeedPageQuery = { ...filters, cursor, limit };
    const rows = this.deps.repo.queryFeedPage(query);
    const items = rows.map(toItem);
    const last = rows.at(-1);

    return {
      items,
      nextCursor: rows.length === limit && last !== undefined ? encodeCursor(last) : null,
      // 只有第一页统计总数：每页都 COUNT 是白白的读放大
      total: cursor === null ? this.deps.repo.countFeed(filters) : null,
      freshness: this.freshness(),
    };
  }

  private freshness(): Freshness {
    const fetchedAt = this.deps.repo.latestFetchedAt();
    return {
      // dataDate = 库里最新一条的发布时间（上游没有统一的「数据日期」概念）
      dataDate: this.deps.repo.latestPublishedAt(),
      fetchedAt: fetchedAt ?? iso(this.now()),
      stale: false,
      source: 'rss',
    };
  }

  getSources(): NewsSourcesResponse {
    // 信源页在**第一次抓取之前**就该列出 16/15 个信源（状态为「未抓取」），
    // 否则新装好的实例上这一页是空的，看起来像坏了
    this.deps.repo.ensureSources(iso(this.now()));
    const counts = this.deps.repo.sourceItemCounts();
    const sources: NewsSourceInfo[] = this.deps.repo.loadSources().map((row) => {
      const definition = getFeed(row.id);
      return {
        id: row.id,
        name: row.name,
        homeUrl: definition?.homeUrl ?? '',
        url: row.url,
        category: toCategory(row.category),
        weight: row.weight,
        cadenceSec: row.cadence_sec,
        enabled: row.enabled === 1,
        lastFetchedAt: row.last_fetched_at,
        nextFetchAt: row.next_fetch_at,
        lastStatus: row.last_status,
        lastError: row.last_error,
        consecFailures: row.consec_failures,
        itemCount: counts.get(row.id) ?? 0,
      };
    });

    const run = this.deps.repo.lastFetchRun();
    return {
      sources,
      lastRun:
        run === null
          ? null
          : {
              startedAt: run.started_at,
              finishedAt: run.finished_at,
              okFeeds: run.ok_feeds,
              failFeeds: run.fail_feeds,
              newItems: run.new_items,
              error: run.error,
            },
    };
  }

  // -------------------------------------------------------------------------
  // 配置与提示词
  // -------------------------------------------------------------------------

  /** 运行时配置优先（改完不重启），没有才回落到环境变量默认值；脏数据按默认处理并告警 */
  aiConfig(): NewsAiConfig {
    const raw = this.deps.settings.get(NEWS_AI_CONFIG_SETTING_KEY);
    if (raw !== null) {
      try {
        return NewsAiConfigSchema.parse(JSON.parse(raw));
      } catch (error) {
        this.deps.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'news.aiConfig 解析失败，回退到环境变量默认值',
        );
      }
    }
    return defaultAiConfig(this.deps.config);
  }

  /** **apiKey 永远只下发 `hasApiKey`**：回传明文只会让它出现在日志与浏览器里 */
  private publicConfig(): NewsAiConfigPublic {
    const { apiKey, ...rest } = this.aiConfig();
    return { ...rest, hasApiKey: apiKey !== '' };
  }

  prompts(): NewsPrompt[] {
    const rows = this.deps.settings
      .all()
      .filter((row) => row.key.startsWith(NEWS_PROMPT_SETTING_PREFIX));

    const prompts: NewsPrompt[] = [];
    for (const row of rows) {
      try {
        prompts.push(NewsPromptSchema.parse(JSON.parse(row.value)));
      } catch (error) {
        this.deps.logger.warn(
          { key: row.key, err: error instanceof Error ? error.message : String(error) },
          '提示词模板损坏，已跳过',
        );
      }
    }

    if (prompts.length === 0) {
      // 首启写入三个内置模板；之后用户怎么改都不覆盖（只在「一条都没有」时播种）
      for (const builtin of BUILTIN_PROMPT_ROWS) {
        this.deps.settings.set(
          `${NEWS_PROMPT_SETTING_PREFIX}${builtin.key}`,
          JSON.stringify(builtin),
        );
      }
      return [...BUILTIN_PROMPT_ROWS];
    }
    return prompts;
  }

  getConfig(): NewsConfigResponse {
    return {
      ai: this.publicConfig(),
      prompts: this.promptsWithHash(),
      usage: this.usage(),
    };
  }

  /** 下发的提示词带上**现算**的 prompt_hash（与生成记录里的那个可比） */
  private promptsWithHash(): NewsPrompt[] {
    return this.prompts().map((prompt) => ({
      ...prompt,
      promptHash: promptHash(prompt.systemPrompt, prompt.userTemplate),
    }));
  }

  updateConfig(update: Record<string, unknown>): NewsConfigResponse {
    const current = this.aiConfig();
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) continue;
      // apiKey 表单不回显明文：留空 = 不改（要清空得先填个新值再删，属可接受的取舍）
      if (key === 'apiKey' && value === '') continue;
      patch[key] = value;
    }

    const merged = NewsAiConfigSchema.parse({ ...current, ...patch });
    this.deps.settings.set(NEWS_AI_CONFIG_SETTING_KEY, JSON.stringify(merged));
    this.deps.logger.info(
      { baseUrl: merged.baseUrl, model: merged.model, enabled: merged.enabled },
      'AI 配置已更新（运行时生效，无需重启）',
    );
    return this.getConfig();
  }

  updatePrompt(key: string, update: Record<string, unknown>): NewsConfigResponse {
    const prompts = this.prompts();
    const existing = prompts.find((prompt) => prompt.key === key);
    if (existing === undefined) throw notFound(`提示词模板不存在：${key}`);

    const patch: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(update)) {
      if (value !== undefined) patch[name] = value;
    }
    const merged = NewsPromptSchema.parse({
      ...existing,
      ...patch,
      key: existing.key,
      // 内置模板的 isDefault 由服务端决定，不接受客户端改
      isDefault: existing.isDefault,
      updatedAt: iso(this.now()),
    });
    this.deps.settings.set(`${NEWS_PROMPT_SETTING_PREFIX}${key}`, JSON.stringify(merged));
    return this.getConfig();
  }

  usage(): NewsUsage {
    const config = this.aiConfig();
    const startOfDay = shanghaiDayStart(this.now());
    return {
      used: this.deps.repo.countSummariesSince(iso(startOfDay)),
      limit: config.dailyLimit,
      date: shanghaiDate(this.now()),
    };
  }

  // -------------------------------------------------------------------------
  // 简报
  // -------------------------------------------------------------------------

  getSummary(window: NewsWindow): NewsSummaryResponse {
    const row = this.deps.repo.latestSuccessSummary(window);
    if (row === null) {
      throw notFound(
        '该窗口还没有生成过简报',
        '点「生成简报」手动触发一次（会消耗一次 AI 调用额度）',
      );
    }
    return { summary: this.toRecord(row, true), disclaimer: NEWS_DISCLAIMER };
  }

  getHistory(window: NewsWindow): NewsSummaryHistoryResponse {
    // 历史只是「哪天用了什么模型/提示词、成没成功」，不下发 payload（体积大且已展示过）
    const history = this.deps.repo.history(window).map((row) => this.toRecord(row, false));
    return { history, disclaimer: NEWS_DISCLAIMER };
  }

  private toRecord(row: NewsSummaryRow, withPayload: boolean): NewsSummaryRecord {
    let payload: NewsSummaryBody | null = null;
    if (withPayload && row.payload !== null) {
      try {
        payload = NewsSummaryBodySchema.parse(JSON.parse(row.payload));
      } catch (error) {
        // 存量 payload 解析不了（理论上不该发生）：降级成无 payload，而不是让整个接口 500
        this.deps.logger.error(
          { id: row.id, err: error instanceof Error ? error.message : String(error) },
          '简报 payload 解析失败，按无 payload 返回',
        );
      }
    }

    return {
      id: row.id,
      window: row.window,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      generatedAt: row.generated_at,
      kind: row.kind as NewsSummaryKind,
      status: row.status,
      model: row.model,
      promptKey: row.prompt_key,
      promptHash: row.prompt_hash,
      payload,
      itemCount: row.item_count,
      droppedCount: row.dropped_count,
      invalidRefs: row.invalid_refs,
      citations: row.status === 'success' ? this.citationsOf(row) : null,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      durationMs: row.duration_ms,
      error: row.error,
    };
  }

  /** `citations:'none'` 是生成时算好的；老数据没有该列语义，按 payload 里的引用回填判断 */
  private citationsOf(row: NewsSummaryRow): 'ok' | 'none' {
    if (row.payload === null) return 'none';
    try {
      const body = NewsSummaryBodySchema.parse(JSON.parse(row.payload));
      return Object.keys(body.items).length > 0 ? 'ok' : 'none';
    } catch {
      return 'none';
    }
  }

  /**
   * 生成一份简报。
   *
   * 护栏顺序（每一道都**显式失败**，绝不返回半成品）：
   * 未配置 → 400；已关闭 → 400；今日额度用尽 → 503；窗口内没条目 → 404；
   * 模型不可达 → 503（信息流不受影响）；两次输出都不合法 → 502 + 模型原文片段。
   */
  async generate(
    request: NewsGenerateRequest,
    kind: NewsSummaryKind,
  ): Promise<NewsGenerateResponse> {
    const config = this.aiConfig();
    const nowMs = this.now();

    if (!config.enabled) {
      throw badRequest('AI 总结已关闭', '到「设置」页打开后再试；信息流不受影响');
    }
    if (config.baseUrl === '' || config.model === '') {
      throw badRequest('还没有配置模型地址，请到设置页填写 baseUrl / model');
    }

    const usage = this.usage();
    if (usage.used >= usage.limit) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        `今日 AI 调用已达上限（${usage.used}/${usage.limit}），明日重置`,
      );
    }

    const range = windowRange(request.window, nowMs);
    const windowStartIso = iso(range.start);
    // 与 rangeBounds 同理：开放式窗口的右边界含当刻（`yesterday` 的右边界是次日 00:00，必须开）
    const windowEndIso = iso(range.end + (request.window === 'yesterday' ? 0 : 1));

    // `today` 的陈旧规则：距上次生成 ≥ 4 小时或期间新增 ≥ 30 条才真的调模型
    if (request.force !== true && request.window === 'today' && kind === 'manual') {
      const latest = this.deps.repo.latestSuccessSummary('today');
      if (latest !== null && latest.window_start === windowStartIso) {
        const age = nowMs - Date.parse(latest.generated_at);
        const newItems = this.deps.repo.countItemsSince(latest.generated_at);
        if (age < TODAY_STALE_AFTER_MS && newItems < TODAY_STALE_NEW_ITEMS) {
          return {
            summary: this.toRecord(latest, true),
            reused: true,
            usage: this.usage(),
            disclaimer: NEWS_DISCLAIMER,
          };
        }
      }
    }

    const prompt = this.resolvePrompt(request.promptKey, request.window);
    const hash = promptHash(prompt.systemPrompt, prompt.userTemplate);

    const rows = this.deps.repo.queryWindow(
      {
        startIso: windowStartIso,
        endIso: windowEndIso,
        categories: prompt.categories,
        sources: [],
        q: '',
      },
      WINDOW_ITEM_LIMIT,
    );
    if (rows.length === 0) {
      throw notFound('该窗口内没有可总结的条目', '先到「信息流」页抓一次，或换一个时间窗口');
    }

    const budget = buildPromptBudget({
      items: rows.map(toItem),
      targetInputTokens: Math.floor(config.maxInputTokens * 0.6),
      weights: FEED_WEIGHTS,
    });
    if (budget.selected.length === 0) {
      throw notFound('该窗口内没有可总结的条目', '预算过小或条目全部被分组配额挤出');
    }

    const userPrompt = renderTemplate(prompt.userTemplate, {
      date: dateLabel(range.start),
      window_label: windowLabel(request.window, range),
      item_count: budget.selected.length,
      source_count: new Set(budget.selected.map((item) => item.sourceId)).size,
      items: formatItemLines(budget.selected),
      extra: request.extra ?? '',
      output_language: '中文（简体）',
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: prompt.systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const base: NewsSummaryInput = {
      window: request.window,
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      generatedAt: iso(nowMs),
      kind,
      status: 'failed',
      model: config.model,
      promptKey: prompt.key,
      promptHash: hash,
      payload: null,
      itemCount: budget.selected.length,
      droppedCount: budget.dropped,
      invalidRefs: null,
      promptTokens: null,
      completionTokens: null,
      durationMs: null,
      error: null,
    };

    const outcome = await this.callModelWithRepair(config, messages);
    if (outcome.kind === 'failure') {
      const isParseFailure = outcome.error.startsWith('模型输出两次都不合法');
      // 记一行 failed（额度与历史都算这一次），再把错误原样抛给前端 —— 不返回半成品
      this.deps.repo.insertSummary({
        ...base,
        status: 'failed',
        model: outcome.model,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
        durationMs: outcome.durationMs,
        error: outcome.error.slice(0, 2000),
      });
      throw isParseFailure
        ? new AppError(
            'PARSE_FAILED',
            '模型两次输出都不是合法的结构化结果，本次生成失败',
            snippetAround(outcome.error),
          )
        : new AppError(
            'UPSTREAM_UNAVAILABLE',
            '模型调用失败，本次生成失败（信息流不受影响，可稍后重试）',
            snippetAround(outcome.error),
          );
    }

    const checked = validateCitations(outcome.payload, budget.selected.length);
    const refItems: Record<string, { id: number; title: string; url: string; sourceName: string }> =
      {};
    for (const ref of collectRefs(checked.payload)) {
      const item = budget.selected[ref - 1];
      if (item === undefined) continue;
      // 回填进 payload：前端渲染角标时不用再查条目表，原条目被清理后链接仍可点
      refItems[String(ref)] = {
        id: item.id,
        title: item.title,
        url: item.url,
        sourceName: item.sourceName,
      };
    }
    const body: NewsSummaryBody = { ...checked.payload, items: refItems };

    const generatedAt = iso(this.now());
    const id = this.deps.repo.insertSummary({
      ...base,
      status: 'success',
      generatedAt,
      model: outcome.model,
      payload: JSON.stringify(body),
      invalidRefs: checked.invalidRefs,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      durationMs: outcome.durationMs,
      error: null,
    });

    if (checked.invalidRefs > 0 || checked.citations === 'none') {
      this.deps.logger.warn(
        { id, invalidRefs: checked.invalidRefs, citations: checked.citations },
        '简报存在无效引用（已丢弃越界引用，正文保留）',
      );
    }
    this.deps.logger.info(
      {
        id,
        window: request.window,
        kind,
        itemCount: budget.selected.length,
        dropped: budget.dropped,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
        durationMs: outcome.durationMs,
      },
      '简报已生成',
    );

    const record: NewsSummaryRecord = {
      id,
      window: request.window,
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      generatedAt,
      kind,
      status: 'success',
      model: outcome.model,
      promptKey: prompt.key,
      promptHash: hash,
      payload: body,
      itemCount: budget.selected.length,
      droppedCount: budget.dropped,
      invalidRefs: checked.invalidRefs,
      citations: checked.citations,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      durationMs: outcome.durationMs,
      error: null,
    };

    return {
      summary: record,
      reused: false,
      usage: this.usage(),
      disclaimer: NEWS_DISCLAIMER,
    };
  }

  private resolvePrompt(key: string | undefined, window: NewsWindow): NewsPrompt {
    const prompts = this.prompts();
    if (key !== undefined) {
      const found = prompts.find((prompt) => prompt.key === key);
      if (found === undefined) throw badRequest(`未知的提示词模板：${key}`, key);
      return found;
    }
    const preferred = window === 'last7d' ? 'weekly' : 'daily';
    const fallback =
      prompts.find((prompt) => prompt.key === preferred) ??
      prompts.find((prompt) => prompt.isDefault) ??
      prompts[0];
    if (fallback === undefined) {
      throw badRequest(
        '没有任何提示词模板可用',
        '删掉 app_setting 里的 news.prompt.* 后重启即可重新播种内置模板',
      );
    }
    return fallback;
  }

  /**
   * 两次调用上限：第 1 次严格 `json_schema`，不合法则**修复重试一次**（把上一次输出与
   * 校验错误一起回给模型），仍不合法就停 —— 这是成本护栏，也是「失败要显式」的落点。
   */
  private async callModelWithRepair(
    config: NewsAiConfig,
    messages: readonly ChatMessage[],
  ): Promise<
    | {
        kind: 'success';
        payload: NewsSummaryPayload;
        model: string;
        promptTokens: number | null;
        completionTokens: number | null;
        durationMs: number;
      }
    | {
        kind: 'failure';
        error: string;
        model: string;
        promptTokens: number;
        completionTokens: number;
        durationMs: number;
      }
  > {
    let promptTokens = 0;
    let completionTokens = 0;
    let durationMs = 0;
    let model = config.model;
    let lastErrors = '';
    let lastRaw = '';

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result: ChatResult;
      try {
        const requestMessages: ChatMessage[] =
          attempt === 0
            ? [...messages]
            : [
                ...messages,
                {
                  role: 'user',
                  content:
                    `上一次的输出是：\n${snippetAround(lastRaw, 600)}\n\n` +
                    `校验错误是：\n${lastErrors}\n\n` +
                    '请只输出修正后的 JSON，不要解释，不要用代码围栏。',
                },
              ];
        result = await chatCompletion(config, requestMessages, { jsonSchema: true });
      } catch (error) {
        const message =
          error instanceof AppError && error.detail !== undefined
            ? `${error.message}｜${error.detail}`
            : error instanceof Error
              ? error.message
              : String(error);
        return {
          kind: 'failure',
          error: message,
          model,
          promptTokens,
          completionTokens,
          durationMs,
        };
      }

      promptTokens += result.promptTokens ?? 0;
      completionTokens += result.completionTokens ?? 0;
      durationMs += result.durationMs;
      model = result.model;

      const parsed = this.parsePayload(result.content);
      if (parsed.ok) {
        return {
          kind: 'success',
          payload: parsed.payload,
          model,
          promptTokens,
          completionTokens,
          durationMs,
        };
      }
      lastErrors = parsed.errors;
      lastRaw = parsed.raw;
    }

    // 两次都不合法：detail 必须带上模型原文（前后各 300 字符），否则无从判断它到底输出了什么
    return {
      kind: 'failure',
      error: `模型输出两次都不合法：${lastErrors}｜上一次的输出：${snippetAround(lastRaw, 300)}`,
      model,
      promptTokens,
      completionTokens,
      durationMs,
    };
  }

  private parsePayload(content: string): ParseOutcome {
    const text = extractJsonText(content);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      return {
        ok: false,
        errors: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        raw: content,
      };
    }
    const parsed = NewsSummaryPayloadSchema.safeParse(json);
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
        raw: content,
      };
    }
    return { ok: true, payload: parsed.data };
  }

  // -------------------------------------------------------------------------
  // 连通性测试
  // -------------------------------------------------------------------------

  /**
   * 最小请求测试（`max_tokens: 16`）。**计入 `dailyLimit`** ——
   * 否则它就是个绕过护栏的口子；单独标 `kind: 'test'` 便于在历史里区分。
   */
  async testConnection(): Promise<{
    ok: boolean;
    model: string;
    latencyMs: number;
    message: string;
    detail?: string;
  }> {
    const config = this.aiConfig();
    if (config.baseUrl === '' || config.model === '') {
      throw badRequest('还没有配置模型地址，请到设置页填写 baseUrl / model');
    }
    const usage = this.usage();
    if (usage.used >= usage.limit) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        `今日 AI 调用已达上限（${usage.used}/${usage.limit}），明日重置`,
      );
    }

    const startedAt = this.now();
    const range = windowRange('today', startedAt);
    const base: NewsSummaryInput = {
      window: 'today',
      windowStart: iso(range.start),
      windowEnd: iso(range.end),
      generatedAt: iso(startedAt),
      kind: 'test',
      status: 'failed',
      model: config.model,
      promptKey: null,
      promptHash: null,
      payload: null,
      itemCount: null,
      droppedCount: null,
      invalidRefs: null,
      promptTokens: null,
      completionTokens: null,
      durationMs: null,
      error: null,
    };

    try {
      const result = await chatCompletion(config, [{ role: 'user', content: '回复 OK' }], {
        maxTokens: 16,
      });
      this.deps.repo.insertSummary({
        ...base,
        status: 'success',
        model: result.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        durationMs: result.durationMs,
      });
      return {
        ok: true,
        model: result.model,
        latencyMs: result.durationMs,
        message: `连接成功（${result.durationMs} ms）`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail =
        error instanceof AppError && error.detail !== undefined ? error.detail : undefined;
      const latencyMs = this.now() - startedAt;
      this.deps.repo.insertSummary({
        ...base,
        status: 'failed',
        durationMs: latencyMs,
        error: message.slice(0, 2000),
      });
      this.deps.logger.warn({ err: message }, 'AI 连通性测试失败');
      return {
        ok: false,
        model: config.model,
        latencyMs,
        message: '连接失败',
        ...(detail === undefined ? {} : { detail }),
      };
    }
  }
}
