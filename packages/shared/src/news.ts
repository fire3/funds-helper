import { z } from 'zod';
import { FreshnessSchema } from './envelope.ts';

/**
 * 信息流与 AI 每日简报（`news`）的传输契约（见 docs/design/news-tool.md）。
 *
 * 两条独立的读路径共用这一个文件：
 * - **信息流**：`NewsItem` + 服务端分页的 `NewsFeedResponse`（纯查询，永远可用）；
 * - **AI 简报**：`NewsSummaryPayload`（模型输出的结构化结果）→ 校验 → 回填引用 → 入库。
 *
 * 模型是本工具里最不可控的依赖，所以它的输出必须先过这里的 schema 才能落到前端。
 */

// ---------------------------------------------------------------------------
// 分组与窗口
// ---------------------------------------------------------------------------

/** 信息流分组：决定分组展示、总结配额与提示词里的引用权重 */
export const NEWS_CATEGORIES = ['media', 'opinion', 'policy', 'discovery'] as const;
export const NewsCategorySchema = z.enum(NEWS_CATEGORIES);
export type NewsCategory = z.infer<typeof NewsCategorySchema>;

export const NEWS_CATEGORY_LABELS: Record<NewsCategory, string> = {
  media: '全球财经',
  opinion: '观点',
  policy: '政策与监管',
  discovery: '发现',
};

/**
 * 信源 id 清单（与 `packages/sources` 的 `FEEDS` **逐字相同**，
 * `apps/server/src/contract.test.ts` 断言两边不漂移）。
 *
 * 放一份在这里是为了让前端能**纯函数地**清洗 URL 里的 `src=` 参数：
 * 分享链接里的笔误应该被丢掉，而不是让服务端回一个 400 把页面打死。
 */
export const NEWS_SOURCE_IDS = [
  'ft.home',
  'ft.markets',
  'cnbc.markets',
  'yahoo.finance',
  'nikkei.asia',
  'scmp',
  'economist.finance',
  'project-syndicate',
  'foreign-affairs',
  'ecb',
  'boe',
  'fed',
  'sec',
  'gnews.reuters',
  'gnews.finance',
] as const;
export type NewsSourceId = (typeof NEWS_SOURCE_IDS)[number];

/** AI 简报的时间窗口：显式的、入库的时间区间（Asia/Shanghai） */
export const NEWS_WINDOWS = ['today', 'yesterday', 'last7d'] as const;
export const NewsWindowSchema = z.enum(NEWS_WINDOWS);
export type NewsWindow = z.infer<typeof NewsWindowSchema>;

export const NEWS_WINDOW_LABELS: Record<NewsWindow, string> = {
  today: '今日',
  yesterday: '昨日',
  last7d: '近 7 日',
};

/** 信息流筛选的时间窗口（比简报窗口多两档：近 3 日 / 全部） */
export const NEWS_RANGES = ['today', 'yesterday', '3d', '7d', 'all'] as const;
export const NewsRangeSchema = z.enum(NEWS_RANGES);
export type NewsRange = z.infer<typeof NewsRangeSchema>;

export const NEWS_RANGE_LABELS: Record<NewsRange, string> = {
  today: '今日',
  yesterday: '昨日',
  '3d': '近 3 日',
  '7d': '近 7 日',
  all: '全部',
};

export const NEWS_DISCLAIMER = 'AI 生成内容，仅作信息整理，不构成投资建议；事实请以原文为准';

// ---------------------------------------------------------------------------
// 信息流
// ---------------------------------------------------------------------------

export const NewsItemSchema = z.object({
  id: z.number().int(),
  sourceId: z.string(),
  sourceName: z.string(),
  category: NewsCategorySchema,
  title: z.string(),
  /** 已剥离 HTML、已截断的摘要；上游没给就是 null */
  summary: z.string().nullable(),
  /** 条目原文链接（canonical）。缺 link 的条目在解析阶段就被跳过，所以这里非空 */
  url: z.string(),
  /** ISO8601，可为 null —— 上游没给发布时间就**不伪造**，界面标「时间未知」 */
  publishedAt: z.string().nullable(),
  fetchedAt: z.string(),
  /** 聚合器条目：只能当线索，不能当事实依据 */
  discovery: z.boolean(),
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

/** 信源健康状态（信源页） */
export const NewsSourceInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  homeUrl: z.string(),
  url: z.string(),
  category: NewsCategorySchema,
  weight: z.number(),
  cadenceSec: z.number(),
  enabled: z.boolean(),
  lastFetchedAt: z.string().nullable(),
  nextFetchAt: z.string(),
  lastStatus: z.number().nullable(),
  lastError: z.string().nullable(),
  consecFailures: z.number(),
  /** 库里该信源的条目总数 */
  itemCount: z.number(),
});
export type NewsSourceInfo = z.infer<typeof NewsSourceInfoSchema>;

/** 游标：把上一页最后一行的排序键原样带回来，避免 offset 翻页在持续写入时漏行/重行 */
export const NewsFeedCursorSchema = z.string();

export const NewsFeedResponseSchema = z.object({
  items: z.array(NewsItemSchema),
  /** 下一页游标；null = 已经到底 */
  nextCursor: NewsFeedCursorSchema.nullable(),
  /** 当前筛选条件下的总条数；只有第一页（无游标）才统计，避免每页都 COUNT */
  total: z.number().int().nullable(),
  freshness: FreshnessSchema,
});
export type NewsFeedResponse = z.infer<typeof NewsFeedResponseSchema>;

export const NewsSourcesResponseSchema = z.object({
  sources: z.array(NewsSourceInfoSchema),
  /** 最近一次抓取任务的留痕（信源页顶部显示「上一轮 12 成 3 败」） */
  lastRun: z
    .object({
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      okFeeds: z.number(),
      failFeeds: z.number(),
      newItems: z.number(),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type NewsSourcesResponse = z.infer<typeof NewsSourcesResponseSchema>;

// ---------------------------------------------------------------------------
// AI 简报 payload
// ---------------------------------------------------------------------------

/**
 * 分区是**固定四段**（而不是模型自由发挥的数组）：
 * 这样 `response_format=json_schema` 的 strict 模式能真正生效，
 * 也能在「缺 section」时立刻判定非法（见 shared 契约测试）。
 */
export const NEWS_SECTION_KEYS = ['macro', 'markets', 'companies', 'asia'] as const;
export const NewsSectionKeySchema = z.enum(NEWS_SECTION_KEYS);
export type NewsSectionKey = z.infer<typeof NewsSectionKeySchema>;

export const NEWS_SECTION_LABELS: Record<NewsSectionKey, string> = {
  macro: '宏观与政策',
  markets: '市场与资金',
  companies: '公司与行业',
  asia: '亚洲',
};

/** 风险/分歧段：模型必须在这里点明相互矛盾的说法，不许擅自裁决 */
export const NEWS_RISK_LABEL = '风险提示';
/** 后续关注段：0–5 条，**不带引用**（还没发生的事没有条目可引） */
export const NEWS_WATCH_LABEL = '后续关注';

export const NewsSummaryPointSchema = z.object({
  text: z.string().min(1),
  /** 引用编号，对应送入模型的条目清单 `[n]`；允许为空数组（背景性表述） */
  refs: z.array(z.number().int().positive()),
});
export type NewsSummaryPoint = z.infer<typeof NewsSummaryPointSchema>;

export const NewsSummaryPayloadSchema = z.object({
  /** 一句话今日要闻 */
  headline: z.string(),
  // strictObject：枚举外的分区 id 必须被挡住（与 json_schema 的 additionalProperties:false 对齐）
  sections: z.strictObject({
    macro: z.array(NewsSummaryPointSchema),
    markets: z.array(NewsSummaryPointSchema),
    companies: z.array(NewsSummaryPointSchema),
    asia: z.array(NewsSummaryPointSchema),
  }),
  risk: z.array(NewsSummaryPointSchema),
  watch: z.array(z.string()),
});
export type NewsSummaryPayload = z.infer<typeof NewsSummaryPayloadSchema>;

/** 被引用条目的回填：前端渲染角标时**不再查条目表**，即使原条目被清理也仍可点 */
export const NewsSummaryRefItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  url: z.string(),
  sourceName: z.string(),
});
export type NewsSummaryRefItem = z.infer<typeof NewsSummaryRefItemSchema>;

/** 入库的完整 payload = 模型输出 + 服务端回填的引用条目 */
export const NewsSummaryBodySchema = NewsSummaryPayloadSchema.extend({
  items: z.record(z.string(), NewsSummaryRefItemSchema),
});
export type NewsSummaryBody = z.infer<typeof NewsSummaryBodySchema>;

/**
 * `response_format: { type: 'json_schema' }` 的 schema。
 * 与 `NewsSummaryPayloadSchema` 手工保持一致（strict 模式要求 additionalProperties: false），
 * 一致性由 `apps/server/src/contract.test.ts` 断言。
 */
export const NEWS_SUMMARY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'sections', 'risk', 'watch'],
  properties: {
    headline: { type: 'string' },
    sections: {
      type: 'object',
      additionalProperties: false,
      required: [...NEWS_SECTION_KEYS],
      properties: Object.fromEntries(
        NEWS_SECTION_KEYS.map((key) => [key, { type: 'array', items: pointJsonSchema() }]),
      ),
    },
    risk: { type: 'array', items: pointJsonSchema() },
    watch: { type: 'array', items: { type: 'string' } },
  },
};

function pointJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'refs'],
    properties: {
      text: { type: 'string' },
      refs: { type: 'array', items: { type: 'integer' } },
    },
  };
}

// ---------------------------------------------------------------------------
// 简报记录与响应
// ---------------------------------------------------------------------------

export const NEWS_SUMMARY_KINDS = ['scheduled', 'manual', 'test'] as const;
export const NewsSummaryKindSchema = z.enum(NEWS_SUMMARY_KINDS);
export type NewsSummaryKind = z.infer<typeof NewsSummaryKindSchema>;

export const NEWS_SUMMARY_STATUSES = ['success', 'failed'] as const;
export const NewsSummaryStatusSchema = z.enum(NEWS_SUMMARY_STATUSES);

/** 引用整体健康度：`none` = 这份简报没有一条引用能对上原文条目 */
export const NEWS_CITATIONS = ['ok', 'none'] as const;
export const NewsCitationsSchema = z.enum(NEWS_CITATIONS);

export const NewsSummaryRecordSchema = z.object({
  id: z.number().int(),
  window: NewsWindowSchema,
  windowStart: z.string(),
  windowEnd: z.string(),
  generatedAt: z.string(),
  kind: NewsSummaryKindSchema,
  status: NewsSummaryStatusSchema,
  model: z.string().nullable(),
  promptKey: z.string().nullable(),
  /** system+user 的 sha256 前 8 位：提示词改了但没重新生成时，UI 能提示「旧提示词」 */
  promptHash: z.string().nullable(),
  /** 成功时为结构化结果；失败/连通性测试为 null */
  payload: NewsSummaryBodySchema.nullable(),
  itemCount: z.number().int().nullable(),
  /** 窗口内被 token 预算挤掉的条数（绝不静默截断，UI 必须标注） */
  droppedCount: z.number().int().nullable(),
  /** 越界被丢弃的引用次数 */
  invalidRefs: z.number().int().nullable(),
  citations: NewsCitationsSchema.nullable(),
  promptTokens: z.number().int().nullable(),
  completionTokens: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type NewsSummaryRecord = z.infer<typeof NewsSummaryRecordSchema>;

export const NewsSummaryResponseSchema = z.object({
  summary: NewsSummaryRecordSchema,
  disclaimer: z.string(),
});
export type NewsSummaryResponse = z.infer<typeof NewsSummaryResponseSchema>;

export const NewsSummaryHistoryResponseSchema = z.object({
  /** 按生成时间倒序；payload 不下发（历史只是「哪天用了什么模型/提示词」） */
  history: z.array(NewsSummaryRecordSchema),
  disclaimer: z.string(),
});
export type NewsSummaryHistoryResponse = z.infer<typeof NewsSummaryHistoryResponseSchema>;

/** 今日 AI 调用用量（界面显示「今日 3/10」） */
export const NewsUsageSchema = z.object({
  used: z.number().int(),
  limit: z.number().int(),
  /** Asia/Shanghai 的日期，用于「明日重置」的说明 */
  date: z.string(),
});
export type NewsUsage = z.infer<typeof NewsUsageSchema>;

export const NewsGenerateRequestSchema = z.object({
  window: NewsWindowSchema,
  /** 不传 = 按窗口选内置默认提示词 */
  promptKey: z.string().min(1).optional(),
  /** 用户在界面上填的额外要求，可为空 */
  extra: z.string().max(2000).optional(),
  /** true = 忽略 `today` 的陈旧规则强制重算（「重新生成」按钮） */
  force: z.boolean().optional(),
});
export type NewsGenerateRequest = z.infer<typeof NewsGenerateRequestSchema>;

export const NewsGenerateResponseSchema = z.object({
  summary: NewsSummaryRecordSchema,
  /** true = 命中陈旧规则，直接返回缓存的那份（本次没有调用模型） */
  reused: z.boolean(),
  usage: NewsUsageSchema,
  disclaimer: z.string(),
});
export type NewsGenerateResponse = z.infer<typeof NewsGenerateResponseSchema>;

// ---------------------------------------------------------------------------
// 配置与提示词
// ---------------------------------------------------------------------------

/** 模型配置。**环境变量只给默认值**，运行时配置（app_setting）优先，改完不重启 */
/** 只允许 http(s)：模型端点是本工具里唯一由用户配置的出网地址（SSRF 边界） */
function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export const NewsAiConfigSchema = z.object({
  /** OpenAI 兼容端点根地址；留空 = 还没配置（生成时明确报 400，而不是拿空地址打网络） */
  baseUrl: z
    .string()
    .trim()
    .refine((value) => value === '' || isHttpUrl(value), 'baseUrl 必须是 http(s) 地址'),
  /** 允许为空（本地 Ollama 不需要 key） */
  apiKey: z.string().default(''),
  /** 允许为空：留空 = 还没配置 */
  model: z.string(),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().int().min(256).max(32_000).default(4000),
  timeoutMs: z.number().int().min(5_000).max(300_000).default(120_000),
  /** 输入预算上限；实际目标取 0.6（留 40% 余量给输出与估算误差） */
  maxInputTokens: z.number().int().positive().default(60_000),
  /** 每天最多调用 N 次（含「测试连接」）—— 个人自用但要克制的硬护栏 */
  dailyLimit: z.number().int().min(1).max(100).default(10),
  enabled: z.boolean().default(true),
});
export type NewsAiConfig = z.infer<typeof NewsAiConfigSchema>;

/** 下发给前端的配置：**apiKey 永远只给 hasApiKey 布尔值**，绝不回传明文 */
export const NewsAiConfigPublicSchema = NewsAiConfigSchema.omit({ apiKey: true }).extend({
  hasApiKey: z.boolean(),
});
export type NewsAiConfigPublic = z.infer<typeof NewsAiConfigPublicSchema>;

/** 部分更新：没提交的字段保持原值（表单不用回显 apiKey，所以它只能「填了才改」） */
export const NewsAiConfigUpdateSchema = NewsAiConfigSchema.partial();
export type NewsAiConfigUpdate = z.infer<typeof NewsAiConfigUpdateSchema>;

export const NewsPromptSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/, '提示词 key 只能是小写字母、数字与短横线'),
  name: z.string().min(1),
  systemPrompt: z.string().min(1),
  userTemplate: z.string().min(1),
  /**
   * 该模板只送入这些分组的条目（空数组 = 全部分组）。
   * 「政策聚焦」这类模板要**只喂 policy 组**，光靠提示词约束不够 ——
   * 不送进去才是真正的隔离（设计文档 §6.2 的意图，schema 里补上这一维）。
   */
  categories: z.array(NewsCategorySchema).default([]),
  /** 内置模板不可删除 */
  isDefault: z.boolean(),
  updatedAt: z.string(),
  /**
   * system+user 的 sha256 前 8 位，**下发时由服务端现算**（不入库）。
   * 简报记录里有同一个 hash —— 两边对不上就是「提示词改了但看到的还是旧结果」。
   */
  promptHash: z
    .string()
    .regex(/^[0-9a-f]{8}$/)
    .optional(),
});
export type NewsPrompt = z.infer<typeof NewsPromptSchema>;

export const NewsPromptUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).optional(),
  userTemplate: z.string().min(1).optional(),
  categories: z.array(NewsCategorySchema).optional(),
});
export type NewsPromptUpdate = z.infer<typeof NewsPromptUpdateSchema>;

export const NewsConfigResponseSchema = z.object({
  ai: NewsAiConfigPublicSchema,
  prompts: z.array(NewsPromptSchema),
  usage: NewsUsageSchema,
});
export type NewsConfigResponse = z.infer<typeof NewsConfigResponseSchema>;

export const NewsConfigTestResponseSchema = z.object({
  ok: z.boolean(),
  model: z.string(),
  latencyMs: z.number(),
  message: z.string(),
  /** 失败时的上游原文片段（要能一眼看出是 401 还是连不上） */
  detail: z.string().optional(),
});
export type NewsConfigTestResponse = z.infer<typeof NewsConfigTestResponseSchema>;

// ---------------------------------------------------------------------------
// 抓取
// ---------------------------------------------------------------------------

export const NewsRefreshResponseSchema = z.object({
  ok: z.boolean(),
  /** 本轮到点（或强制）需要抓取的信源数 */
  due: z.number(),
  fetched: z.number(),
  failed: z.number(),
  inserted: z.number(),
  skipped: z.boolean(),
  durationMs: z.number(),
  message: z.string(),
});
export type NewsRefreshResponse = z.infer<typeof NewsRefreshResponseSchema>;
