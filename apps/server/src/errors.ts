import type { ApiErrorCode } from '@funds-helper/shared';

const HTTP_STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  UPSTREAM_UNAVAILABLE: 503,
  PARSE_FAILED: 502,
  INTERNAL: 500,
};

/** 应用层错误：携带对外暴露的错误码与面向用户的中文说明 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly detail: string | undefined;

  constructor(code: ApiErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

export function badRequest(message: string, detail?: string): AppError {
  return new AppError('BAD_REQUEST', message, detail);
}

export function notFound(message: string, detail?: string): AppError {
  return new AppError('NOT_FOUND', message, detail);
}
