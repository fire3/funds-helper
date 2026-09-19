/** 上游不可达、超时、非 2xx 等网络层错误 */
export class UpstreamError extends Error {
  readonly url: string | undefined;
  readonly status: number | undefined;

  constructor(message: string, options: { url?: string; status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UpstreamError';
    this.url = options.url;
    this.status = options.status;
  }
}

/**
 * 上游响应结构不符合预期 —— 通常意味着接口已改版。
 * 刻意独立成类型：这类错误必须**显式暴露**给使用者，绝不能静默返回空数据。
 */
export class ParseError extends UpstreamError {
  constructor(message: string, options: { url?: string; detail?: string } = {}) {
    super(options.detail === undefined ? message : `${message}｜${options.detail}`, {
      ...(options.url === undefined ? {} : { url: options.url }),
    });
    this.name = 'ParseError';
  }
}

/** 极简日志接口，与 pino 的 (obj, msg) 调用形式兼容，避免 sources 耦合具体日志库 */
export interface Logger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}
