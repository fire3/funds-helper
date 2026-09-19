import {
  type ApiErrorBody,
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

  getQdiiChanges: (days = 30): Promise<QdiiChangesResponse> =>
    request(`/api/tools/qdii/changes?days=${days}`, QdiiChangesResponseSchema),

  refreshQdii: (): Promise<QdiiRefreshResponse> =>
    request('/api/tools/qdii/refresh', QdiiRefreshResponseSchema, { method: 'POST' }),
};
