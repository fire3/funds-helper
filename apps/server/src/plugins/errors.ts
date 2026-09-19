import type { ApiErrorBody, ApiErrorCode } from '@funds-helper/shared';
import { ParseError, UpstreamError } from '@funds-helper/sources';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../errors.ts';

interface Mapped {
  status: number;
  code: ApiErrorCode;
  message: string;
  detail?: string;
}

/**
 * 把内部错误映射为统一的对外错误模型。
 *
 * 关键：**ParseError 必须显式暴露**（502 PARSE_FAILED）——
 * 上游改版时用户与排障者要立刻知道是「接口变了」，而不是被 500 或空数据掩盖。
 */
function mapError(error: unknown): Mapped {
  if (error instanceof AppError) {
    return error.detail === undefined
      ? { status: error.status, code: error.code, message: error.message }
      : { status: error.status, code: error.code, message: error.message, detail: error.detail };
  }

  if (error instanceof ParseError) {
    return {
      status: 502,
      code: 'PARSE_FAILED',
      message: '上游接口响应结构不符合预期，可能已改版',
      detail: error.message,
    };
  }

  if (error instanceof UpstreamError) {
    return {
      status: 503,
      code: 'UPSTREAM_UNAVAILABLE',
      message: '上游接口暂时不可用',
      detail: error.message,
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      code: 'BAD_REQUEST',
      message: '请求参数不合法',
      detail: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    };
  }

  if (typeof error === 'object' && error !== null && 'validation' in error) {
    return {
      status: 400,
      code: 'BAD_REQUEST',
      message: '请求参数不合法',
      detail: String((error as { message?: string }).message ?? ''),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, code: 'INTERNAL', message: '服务内部错误', detail: message };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);

    if (mapped.status >= 500) {
      request.log.error({ err: error, code: mapped.code }, '请求处理失败');
    } else {
      request.log.warn({ code: mapped.code, detail: mapped.detail }, '请求被拒绝');
    }

    const body: ApiErrorBody = {
      error:
        mapped.detail === undefined
          ? { code: mapped.code, message: mapped.message }
          : { code: mapped.code, message: mapped.message, detail: mapped.detail },
    };
    void reply.status(mapped.status).send(body);
  });
}

/**
 * 未命中路由的 JSON 错误响应。
 *
 * 注意：Fastify 的 `setNotFoundHandler` 每个 prefix 只能设置**一次**，
 * 因此这里与「托管前端时的 SPA 回退」是互斥的两个分支，
 * 由 app.ts 根据是否启用静态资源二选一。
 */
export function registerNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorBody = {
      error: { code: 'NOT_FOUND', message: `未找到 ${request.method} ${request.url}` },
    };
    void reply.status(404).send(body);
  });
}
