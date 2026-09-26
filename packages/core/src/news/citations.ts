import type { NewsSectionKey, SummaryPayloadLike, SummaryPointLike } from './model.ts';
import { NEWS_SECTION_KEYS } from './model.ts';

/**
 * 引用校验与降级（design §5.6）。
 *
 * 模型最容易犯的错是**编造引用编号**（`refs: [999]` 而清单只有 187 条）。
 *
 * 为什么不因为越界就整单作废：一次调用已经花了 token，整单丢弃的边际收益接近零；
 * 丢掉坏引用、保留可读正文，再在界面上标注，比再打一次模型更符合「克制」。
 * 真正致命的是 JSON 不合法 —— 那条路径在 schema 校验时已经停住了。
 */

export interface CitationCheckResult {
  /** 引用已清理的 payload（结构不变，越界的 refs 被丢弃） */
  payload: SummaryPayloadLike;
  /** 被丢弃的越界引用次数（写进 `news_summary.invalid_refs` 并在 UI 标注） */
  invalidRefs: number;
  /** `none` = 这份简报没有一条引用能对上原文条目（UI 顶部提示） */
  citations: 'ok' | 'none';
  /** 至少有一个有效引用的要点数（用于判断「有没有关联到原文」） */
  validRefs: number;
}

function cleanPoints(
  points: readonly SummaryPointLike[],
  itemCount: number,
  stats: { invalid: number; valid: number },
): SummaryPointLike[] {
  return points.map((point) => {
    // 越界（<=0 或 > 清单长度）一律丢弃；空数组保留 —— 对应「背景性表述」
    const refs = point.refs.filter((ref) => {
      if (!Number.isInteger(ref) || ref < 1 || ref > itemCount) {
        stats.invalid += 1;
        return false;
      }
      return true;
    });
    if (refs.length > 0) stats.valid += 1;
    return { text: point.text, refs };
  });
}

export function validateCitations(
  payload: SummaryPayloadLike,
  itemCount: number,
): CitationCheckResult {
  const stats = { invalid: 0, valid: 0 };

  const sections = Object.fromEntries(
    NEWS_SECTION_KEYS.map((key: NewsSectionKey) => [
      key,
      cleanPoints(payload.sections[key] ?? [], itemCount, stats),
    ]),
  ) as SummaryPayloadLike['sections'];

  const risk = cleanPoints(payload.risk ?? [], itemCount, stats);

  return {
    payload: { headline: payload.headline, sections, risk, watch: [...payload.watch] },
    invalidRefs: stats.invalid,
    // 一条有效引用都没有（全空或全越界）→ 标记 citations:'none'
    citations: stats.valid > 0 ? 'ok' : 'none',
    validRefs: stats.valid,
  };
}

/** 收集一份 payload 里**仍然有效**的全部引用编号（去重，用于回填引用条目） */
export function collectRefs(payload: SummaryPayloadLike): number[] {
  const refs = new Set<number>();
  const add = (points: readonly SummaryPointLike[]): void => {
    for (const point of points) for (const ref of point.refs) refs.add(ref);
  };
  for (const key of NEWS_SECTION_KEYS) add(payload.sections[key] ?? []);
  add(payload.risk);
  return [...refs].sort((a, b) => a - b);
}
