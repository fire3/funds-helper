import { NEWS_SUMMARY_JSON_SCHEMA, type NewsAiConfig } from '@funds-helper/shared';
import { AppError } from '../../errors.ts';

/**
 * OpenAI 兼容的 `POST {baseUrl}/chat/completions` 客户端 —— **本工具唯一的模型出网点**。
 *
 * 为什么不用 `HttpClient`：那个客户端是为「非官方行情接口」设计的 ——
 * 默认 60s 超时、对 5xx/网络错误退避重试。模型调用恰恰相反：
 * **120s 超时、绝不重试**（重试会放大成本与延迟，宁可这次生成失败、下次手动再来）。
 *
 * 一套请求/响应映射覆盖 OpenAI、DeepSeek、Kimi、智谱、DashScope、OpenRouter、vLLM、Ollama。
 * Anthropic 原生、Gemini 等留到真正需要时再加 adapter 层（design §0）。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** 第一次调用用严格 `json_schema`；端点不支持时自动降级重发（同一次逻辑调用） */
  jsonSchema?: boolean | undefined;
  /** 覆盖 `max_tokens`（「测试连接」只发 16） */
  maxTokens?: number | undefined;
}

export interface ChatResult {
  content: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
  /** 端点不支持 `response_format`，已自动降级为不带它的请求 */
  degraded: boolean;
}

interface RawStatus {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * `baseUrl` 归一化：去掉尾部 `/`，已含 `/chat/completions` 就不再拼接。
 * 用户经常直接粘完整地址 —— 这是配置类功能最常见的坑，必须容错。
 */
export function normalizeBaseUrl(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(url)) return url;
  return `${url}/chat/completions`;
}

/** 错误 detail 用的原文片段：前后各 `around` 字符（日志纪律：不整体打日志） */
export function snippetAround(text: string, around = 300): string {
  const trimmed = text.trim();
  if (trimmed.length <= around * 2) return trimmed;
  return `${trimmed.slice(0, around)} … ${trimmed.slice(-around)}`;
}

function upstreamError(message: string, status: number | null, body: string): AppError {
  const detail = status === null ? snippetAround(body) : `HTTP ${status}｜${snippetAround(body)}`;
  return new AppError('UPSTREAM_UNAVAILABLE', message, detail);
}

/** 端点对 `response_format` 的典型拒绝（各家文案不同，只能按关键词判） */
function isSchemaRejection(status: number, body: string): boolean {
  return status === 400 && /response_format|json_schema|structured|schema/i.test(body);
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface CompletionResponse {
  model?: string;
  choices?: { message?: { content?: unknown } }[];
  usage?: Usage;
}

async function post(
  cfg: NewsAiConfig,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<RawStatus> {
  const url = normalizeBaseUrl(cfg.baseUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // 本地 Ollama / vLLM 常常不需要 key；有的端点也不认 Bearer 空串
  if (cfg.apiKey !== '') headers.Authorization = `Bearer ${cfg.apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // 超时 / DNS / 连不上 —— 都是「上游不可达」，detail 要能看出真实根因
    const cause = error instanceof Error ? error.message : String(error);
    throw upstreamError('模型端点连接失败（超时或网络不可达）', null, cause);
  }

  const body = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, body };
}

/**
 * 发一次 chat completion。
 *
 * @param options.jsonSchema 用严格 `json_schema`；端点回 400 且疑似不支持时**自动降级**重发一次，
 * 让 DeepSeek/Kimi/部分 vLLM 版本这类有历史差异的兼容端点也能用。
 */
export async function chatCompletion(
  cfg: NewsAiConfig,
  messages: readonly ChatMessage[],
  options: ChatOptions = {},
): Promise<ChatResult> {
  const startedAt = Date.now();
  const maxTokens = options.maxTokens ?? cfg.maxTokens;

  const base: Record<string, unknown> = {
    model: cfg.model,
    messages: [...messages],
    temperature: cfg.temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  const withSchema = options.jsonSchema === true;
  const jsonSchemaPayload = withSchema
    ? {
        ...base,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'news_summary',
            strict: true,
            schema: NEWS_SUMMARY_JSON_SCHEMA,
          },
        },
      }
    : null;

  let result = await post(cfg, jsonSchemaPayload ?? base, cfg.timeoutMs);
  let degraded = false;

  if (!result.ok && jsonSchemaPayload !== null && isSchemaRejection(result.status, result.body)) {
    degraded = true;
    result = await post(cfg, base, cfg.timeoutMs);
  }

  if (!result.ok) {
    throw upstreamError(`模型端点返回错误（HTTP ${result.status}）`, result.status, result.body);
  }

  let parsed: CompletionResponse;
  try {
    parsed = JSON.parse(result.body) as CompletionResponse;
  } catch {
    throw upstreamError('模型端点返回的不是合法 JSON', null, result.body);
  }

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content === '') {
    throw upstreamError('模型响应里没有 choices[0].message.content', null, result.body);
  }

  return {
    content,
    model: parsed.model ?? cfg.model,
    promptTokens: numberOrNull(parsed.usage?.prompt_tokens),
    completionTokens: numberOrNull(parsed.usage?.completion_tokens),
    durationMs: Date.now() - startedAt,
    degraded,
  };
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 取出模型输出里的 JSON 文本。
 * 降级模式（没有 `response_format`）下模型常会包一层 ```json 围栏 —— 这里剥掉。
 */
export function extractJsonText(content: string): string {
  const fenced = content.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fenced?.[1] !== undefined) return fenced[1];
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start >= 0 && end > start) return content.slice(start, end + 1);
  return content;
}
