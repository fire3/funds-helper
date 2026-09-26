import { normalizeTitle } from './canonicalize.ts';
import type { NewsItemLike } from './model.ts';

/**
 * 提示词阶段的标题近似合并（design §3.4 的第 4 步）。
 *
 * 入库阶段已经按 canonical URL / dedup_key 去过重；这里只处理
 * **「同一标题在窗口里出现多次」**（同源重发、转载标题完全一致）——
 * 目的是控制 token，不是做事实归并。
 *
 * 刻意**只做标准化标题的完全相等**：FT 与 CNBC 报同一件事是两条不同的标题，
 * 模型自己归纳；聚合器与原文的标题差一个来源后缀，也不会被误合并。
 * 相似度阈值（编辑距离 / 前缀包含）会引入「错合并」，与「宁可重复，不可错合并」冲突。
 */
export function dedupeForPrompt(items: readonly NewsItemLike[]): NewsItemLike[] {
  const result: NewsItemLike[] = [];
  const indexByKey = new Map<string, number>();

  const rank = (item: NewsItemLike): number =>
    // 事实源优先于聚合器，有摘要的优先于只有标题的
    (item.discovery ? 0 : 2) + (item.summary !== null && item.summary !== '' ? 1 : 0);

  for (const item of items) {
    const key = normalizeTitle(item.title);
    // 标题只剩标点的条目不参与合并（原样保留，不能因为规范化为空就把它吞掉）
    if (key === '') {
      result.push(item);
      continue;
    }

    const at = indexByKey.get(key);
    if (at === undefined) {
      indexByKey.set(key, result.length);
      result.push(item);
      continue;
    }
    // 保留信息量更大的那条，但**位置取第一次出现的地方**（时间顺序不被打乱）
    const current = result[at];
    if (current !== undefined && rank(item) > rank(current)) result[at] = item;
  }

  return result;
}

/**
 * 三段式去重的**判定**（入库时用）：给定一条新条目与库里已有的判定依据，
 * 该不该落库。真正的唯一约束在数据库（两个可空唯一索引），这里提供可单测的口径。
 */
export interface DedupCandidate {
  /** canonical URL；拿不到就是 null */
  url: string | null;
  /** 退化键（source|hash(title)|date）；url 为空时才有意义 */
  dedupKey: string | null;
}

export type DedupReason = 'same-url' | 'same-key' | 'insert';

/** 新条目是否会与已有条目撞车（撞车 = 丢弃，不报错） */
export function classifyDedup(
  candidate: DedupCandidate,
  existing: { url: string | null; dedupKey: string | null },
): DedupReason {
  if (candidate.url !== null && candidate.url === existing.url) return 'same-url';
  if (
    candidate.url === null &&
    candidate.dedupKey !== null &&
    candidate.dedupKey === existing.dedupKey
  ) {
    return 'same-key';
  }
  return 'insert';
}
