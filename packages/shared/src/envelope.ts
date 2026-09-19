import { z } from 'zod';

/** 全站统一的免责声明，随任何携带行情数据的响应一起返回 */
export const DISCLAIMER = '数据来自天天基金公开接口，仅供参考，实际限额以基金公司最新公告为准';

/**
 * 数据新鲜度契约：任何一个返回上游数据的响应都必须带上它。
 * 目的是让前端能固定展示「数据日期 / 更新时间」，并在降级时明确警示，
 * 避免用户基于过期数据决策。
 */
export const FreshnessSchema = z.object({
  /** 上游数据日期，如 '2026-09-14' */
  dataDate: z.string().nullable(),
  /** 本地抓取时刻，ISO8601 */
  fetchedAt: z.string(),
  /** true = 上游拉取失败，返回的是 SQLite 里的旧快照 */
  stale: z.boolean(),
  /** 陈旧原因，仅 stale 时有值 */
  staleReason: z.string().optional(),
  source: z.string(),
});
export type Freshness = z.infer<typeof FreshnessSchema>;

export const ApiErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'NOT_FOUND',
  'UPSTREAM_UNAVAILABLE',
  'PARSE_FAILED',
  'INTERNAL',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    /** 面向用户的中文说明 */
    message: z.string(),
    /** 面向排障的细节（上游原文片段等） */
    detail: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;
