import {
  type ApiErrorBody,
  type EtfConfigResponse,
  EtfConfigResponseSchema,
  type EtfConfigUpdateResponse,
  EtfConfigUpdateResponseSchema,
  type EtfDatasetResponse,
  EtfDatasetResponseSchema,
  type EtfFeederRefreshResponse,
  EtfFeederRefreshResponseSchema,
  type EtfFundDetailResponse,
  EtfFundDetailResponseSchema,
  type EtfPeriodRefreshResponse,
  EtfPeriodRefreshResponseSchema,
  type EtfRefreshResponse,
  EtfRefreshResponseSchema,
  type EtfSpotSourceId,
  type FxDatasetResponse,
  FxDatasetResponseSchema,
  type FxDirection,
  type FxRange,
  type FxRefreshResponse,
  FxRefreshResponseSchema,
  type IndexDatasetResponse,
  IndexDatasetResponseSchema,
  type IndexOverviewResponse,
  IndexOverviewResponseSchema,
  type IndexRange,
  type IndexRefreshResponse,
  IndexRefreshResponseSchema,
  type NewsAiConfigUpdate,
  type NewsConfigResponse,
  NewsConfigResponseSchema,
  type NewsConfigTestResponse,
  NewsConfigTestResponseSchema,
  type NewsDatesResponse,
  NewsDatesResponseSchema,
  type NewsFeedResponse,
  NewsFeedResponseSchema,
  type NewsGenerateRequest,
  type NewsGenerateResponse,
  NewsGenerateResponseSchema,
  type NewsRefreshResponse,
  NewsRefreshResponseSchema,
  type NewsSourcesResponse,
  NewsSourcesResponseSchema,
  type NewsSummaryHistoryResponse,
  NewsSummaryHistoryResponseSchema,
  type NewsSummaryResponse,
  NewsSummaryResponseSchema,
  type NewsWindow,
  type QdiiChangesResponse,
  QdiiChangesResponseSchema,
  type QdiiDatasetResponse,
  QdiiDatasetResponseSchema,
  type QdiiFundDetailResponse,
  QdiiFundDetailResponseSchema,
  type QdiiPremiumResponse,
  QdiiPremiumResponseSchema,
  type QdiiRefreshResponse,
  QdiiRefreshResponseSchema,
  type ToolDescriptor,
  ToolListResponseSchema,
  type UsdDatasetResponse,
  UsdDatasetResponseSchema,
  type UsdFundDetailResponse,
  UsdFundDetailResponseSchema,
  type UsdRefreshResponse,
  UsdRefreshResponseSchema,
} from '@funds-helper/shared';
import type { ZodType, z } from 'zod';

/**
 * API 客户端。
 *
 * 响应一律用 shared 的 zod schema 解析 —— 上游字段漂移时前端会**明确报错**，
 * 而不是静默渲染出空白单元格。
 */

export class ApiError extends Error {
  readonly code: string;
  readonly detail: string | undefined;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
  }
}

async function request<S extends ZodType>(
  path: string,
  schema: S,
  init?: RequestInit,
): Promise<z.output<S>> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError('INTERNAL', `响应不是合法 JSON（HTTP ${response.status}）`);
  }

  if (!response.ok) {
    const body = payload as Partial<ApiErrorBody>;
    throw new ApiError(
      body.error?.code ?? 'INTERNAL',
      body.error?.message ?? `请求失败（HTTP ${response.status}）`,
      body.error?.detail,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(
      'PARSE_FAILED',
      '服务端返回的数据结构不符合预期，可能是前后端版本不一致',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return parsed.data;
}

/** 面向用户的中文错误说明 */
export function apiErrorMessage(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return undefined;
}

/**
 * 面向排障的细节 —— **优先展示服务端返回的 `detail`**。
 *
 * 服务端的通用 message（如「上游接口不可用，且本地还没有任何数据」）不说明原因，
 * 真正有用的是 detail（超时 / DNS / 解析失败…）。界面必须把它显示出来，否则无从排障。
 */
export function apiErrorDetail(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.detail ?? error.message;
  if (error instanceof Error) return error.message;
  return undefined;
}

export const api = {
  listTools: (): Promise<ToolDescriptor[]> =>
    request('/api/tools', ToolListResponseSchema).then((data) => data.tools),

  getQdiiDataset: (refresh = false): Promise<QdiiDatasetResponse> =>
    request(`/api/tools/qdii/dataset${refresh ? '?refresh=1' : ''}`, QdiiDatasetResponseSchema),

  getQdiiFund: (code: string, refresh = false): Promise<QdiiFundDetailResponse> =>
    request(
      `/api/tools/qdii/funds/${code}${refresh ? '?refresh=1' : ''}`,
      QdiiFundDetailResponseSchema,
    ),

  getQdiiPremium: (refresh = false): Promise<QdiiPremiumResponse> =>
    request(`/api/tools/qdii/premium${refresh ? '?refresh=1' : ''}`, QdiiPremiumResponseSchema),

  getQdiiChanges: (days = 30, limit = 1000): Promise<QdiiChangesResponse> =>
    request(`/api/tools/qdii/changes?days=${days}&limit=${limit}`, QdiiChangesResponseSchema),

  refreshQdii: (): Promise<QdiiRefreshResponse> =>
    request('/api/tools/qdii/refresh', QdiiRefreshResponseSchema, { method: 'POST' }),

  getUsdDataset: (refresh = false): Promise<UsdDatasetResponse> =>
    request(`/api/tools/usd/dataset${refresh ? '?refresh=1' : ''}`, UsdDatasetResponseSchema),

  getUsdFund: (code: string, refresh = false): Promise<UsdFundDetailResponse> =>
    request(
      `/api/tools/usd/funds/${code}${refresh ? '?refresh=1' : ''}`,
      UsdFundDetailResponseSchema,
    ),

  refreshUsd: (): Promise<UsdRefreshResponse> =>
    request('/api/tools/usd/refresh', UsdRefreshResponseSchema, { method: 'POST' }),

  getFxDataset: (params: {
    range: FxRange;
    direction: FxDirection;
    refresh?: boolean;
  }): Promise<FxDatasetResponse> => {
    const search = new URLSearchParams({ range: params.range, direction: params.direction });
    if (params.refresh === true) search.set('refresh', '1');
    return request(`/api/tools/fx/dataset?${search.toString()}`, FxDatasetResponseSchema);
  },

  refreshFx: (): Promise<FxRefreshResponse> =>
    request('/api/tools/fx/refresh', FxRefreshResponseSchema, { method: 'POST' }),

  // ---- indices：国际行情 ----

  /** 全部主要指数的最新收盘与日涨跌（按地区分组） */
  getIndicesOverview: (refresh = false): Promise<IndexOverviewResponse> =>
    request(
      `/api/tools/indices/overview${refresh ? '?refresh=1' : ''}`,
      IndexOverviewResponseSchema,
    ),

  /** 单指数走势 + 区间涨跌 + 年度表现（区间与选中指数写在 URL） */
  getIndicesDataset: (params: {
    code: string;
    range: IndexRange;
    refresh?: boolean;
  }): Promise<IndexDatasetResponse> => {
    const search = new URLSearchParams({ code: params.code, range: params.range });
    if (params.refresh === true) search.set('refresh', '1');
    return request(`/api/tools/indices/dataset?${search.toString()}`, IndexDatasetResponseSchema);
  },

  refreshIndices: (): Promise<IndexRefreshResponse> =>
    request('/api/tools/indices/refresh', IndexRefreshResponseSchema, { method: 'POST' }),

  getEtfDataset: (refresh = false): Promise<EtfDatasetResponse> =>
    request(`/api/tools/etf/dataset${refresh ? '?refresh=1' : ''}`, EtfDatasetResponseSchema),

  getEtfFund: (code: string, refresh = false): Promise<EtfFundDetailResponse> =>
    request(
      `/api/tools/etf/funds/${code}${refresh ? '?refresh=1' : ''}`,
      EtfFundDetailResponseSchema,
    ),

  refreshEtf: (): Promise<EtfRefreshResponse> =>
    request('/api/tools/etf/refresh', EtfRefreshResponseSchema, { method: 'POST' }),

  /**
   * 反查场外联接基金。默认为增量（只补候选池里的新增）；
   * `full` = 全量重建，服务端要打约 2300 个请求（4 分钟），只在首次建库时用。
   */
  refreshEtfFeeders: (full = false): Promise<EtfFeederRefreshResponse> =>
    request(
      `/api/tools/etf/feeders/refresh${full ? '?full=1' : ''}`,
      EtfFeederRefreshResponseSchema,
      {
        method: 'POST',
      },
    ),

  /**
   * 抓取区间涨幅（近6月/近1年/近3年，接口 H）。默认只抓「缺失或超过 7 天」的行；
   * `full` = 忽略新鲜度强制全抓，服务端要打约 1500 个请求（3 分钟），只在首次建库时用。
   */
  refreshEtfPeriods: (full = false): Promise<EtfPeriodRefreshResponse> =>
    request(
      `/api/tools/etf/periods/refresh${full ? '?full=1' : ''}`,
      EtfPeriodRefreshResponseSchema,
      { method: 'POST' },
    ),

  getEtfConfig: (): Promise<EtfConfigResponse> =>
    request('/api/tools/etf/config', EtfConfigResponseSchema),

  /** 切换行情渠道：服务端会顺手重抓一次（响应里带新的配置与抓取结果） */
  updateEtfConfig: (spotSource: EtfSpotSourceId): Promise<EtfConfigUpdateResponse> =>
    request('/api/tools/etf/config', EtfConfigUpdateResponseSchema, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotSource }),
    }),

  // ---- news：信息流与 AI 每日简报 ----

  /** 分页信息流：**服务端筛选 + 游标分页**（条目几个月就是几万行，不能全量返回） */
  getNewsFeed: (params: {
    range: string;
    /** 指定日历日（`YYYY-MM-DD`）时服务端按这一天取数，优先于 range */
    date?: string | null;
    categories?: readonly string[];
    sources?: readonly string[];
    q?: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<NewsFeedResponse> => {
    const search = new URLSearchParams({ range: params.range });
    if (params.date != null && params.date !== '') search.set('date', params.date);
    if (params.categories && params.categories.length > 0) {
      search.set('cat', params.categories.join(','));
    }
    if (params.sources && params.sources.length > 0) search.set('src', params.sources.join(','));
    if (params.q !== undefined && params.q.trim() !== '') search.set('q', params.q.trim());
    if (params.cursor != null) search.set('cursor', params.cursor);
    search.set('limit', String(params.limit ?? 100));
    return request(`/api/tools/news/feed?${search.toString()}`, NewsFeedResponseSchema);
  },

  getNewsSources: (): Promise<NewsSourcesResponse> =>
    request('/api/tools/news/sources', NewsSourcesResponseSchema),

  getNewsSummary: (window: NewsWindow): Promise<NewsSummaryResponse> =>
    request(`/api/tools/news/summary?window=${window}`, NewsSummaryResponseSchema),

  /** 按上海日历日取历史简报（当天生成的 today 与次日生成的 yesterday 取最新一份） */
  getNewsSummaryByDate: (date: string): Promise<NewsSummaryResponse> =>
    request(`/api/tools/news/summary?date=${encodeURIComponent(date)}`, NewsSummaryResponseSchema),

  /** 历史简报的日期索引：哪几天有简报 */
  getNewsSummaryDates: (): Promise<NewsDatesResponse> =>
    request('/api/tools/news/summary/dates', NewsDatesResponseSchema),

  getNewsSummaryHistory: (window: NewsWindow): Promise<NewsSummaryHistoryResponse> =>
    request(`/api/tools/news/summary/history?window=${window}`, NewsSummaryHistoryResponseSchema),

  /** 生成简报：服务端按陈旧规则决定是否真的调模型（`reused: true` = 返回缓存） */
  generateNewsSummary: (body: NewsGenerateRequest): Promise<NewsGenerateResponse> =>
    request('/api/tools/news/summaries/generate', NewsGenerateResponseSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  getNewsConfig: (): Promise<NewsConfigResponse> =>
    request('/api/tools/news/config', NewsConfigResponseSchema),

  updateNewsConfig: (body: NewsAiConfigUpdate): Promise<NewsConfigResponse> =>
    request('/api/tools/news/config', NewsConfigResponseSchema, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  updateNewsPrompt: (
    key: string,
    body: { name?: string; systemPrompt?: string; userTemplate?: string },
  ): Promise<NewsConfigResponse> =>
    request(`/api/tools/news/prompts/${encodeURIComponent(key)}`, NewsConfigResponseSchema, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  testNewsConfig: (): Promise<NewsConfigTestResponse> =>
    request('/api/tools/news/config/test', NewsConfigTestResponseSchema, { method: 'POST' }),

  refreshNews: (): Promise<NewsRefreshResponse> =>
    request('/api/tools/news/refresh', NewsRefreshResponseSchema, { method: 'POST' }),
};
